import * as vscode from "vscode";

import { McppCliController } from "./cli/controller";
import { runProcess } from "./cli/process";
import { parseProtocolInfo } from "./cli/protocol";
import { buildSelfCheckText } from "./cli/selfCheck";
import { CLI_COMMANDS, LEGACY_LANGUAGE_SERVER_COMMANDS, TOOL_COMMANDS } from "./commands/ids";
import { findNearestMcppProject, type McppProjectDiscovery } from "./projects/discovery";
import { MCPP_MANIFEST_GLOB, registerInProjectContext } from "./projects/context";
import {
  createLanguageServerBridge,
  type LanguageServerBridge,
  type LanguageServerCommandResult,
} from "./mcppls/bridge";
import { CAPABILITIES, MCPPLS_EXTENSION_ID } from "./mcppls/contract";
import { formatResult } from "./mcppls/messages";
import { describeState } from "./mcppls/state";
import {
  languageServerEnabled,
  languageServerInstalled,
  languageServerVersion,
  readLanguageServerState,
} from "./mcppls/stateSource";
import { registerBuildScriptProviders } from "./buildscript/providers";
import { registerTomlProviders } from "./toml/providers";
import {
  buildModuleSetupPlan,
  executeModuleSetup,
  moduleSetupConfirmation,
  type ModuleSetupDecision,
  type ModuleSetupStepResult,
} from "./workflows/moduleSetup";
import type { TaskCompletion } from "./cli/tasks";
import { changedSettings, onDidChange as onConfigurationChanged, read } from "./config/access";
import { registerSettingsPanel } from "./config/panel";
import { languagePreference, setLanguagePreference, t, type LanguagePreference } from "./i18n/t";
import { registerCacheView } from "./views/cacheView";
import { registerLanguageServerView } from "./views/languageServerView";
import { registerProjectView } from "./views/projectView";

/**
 * The commands an extension declares in its own `package.json`, read without
 * activating it. `undefined` means "no static information", which the capability
 * probe treats as "assume it works until a call says otherwise".
 */
function declaredCommandsOf(id: string): readonly string[] | undefined {
  const extension = vscode.extensions.getExtension(id);
  const commands = (extension?.packageJSON as { contributes?: { commands?: Array<{ command?: string }> } })
    ?.contributes?.commands;
  if (!Array.isArray(commands)) {
    return undefined;
  }
  return commands
    .map((entry) => entry.command)
    .filter((command): command is string => typeof command === "string");
}

/** When the language service was last asked to reload, for the self-check. */
let lastRefresh: { at: string; state: string; command?: string } | undefined;

/** `mcpp.ui.language` decides which of our strings the user sees. */
function applyLanguagePreference(): void {
  setLanguagePreference(read<LanguagePreference>("mcpp.ui.language"));
}


function findCurrentProject(): McppProjectDiscovery | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor !== undefined) {
    const activeUri = activeEditor.document.uri;
    if (activeUri.scheme !== "file") {
      return undefined;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (workspaceFolder === undefined) {
      return undefined;
    }
    return findNearestMcppProject(activeUri.fsPath, workspaceFolder.uri.fsPath);
  }

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    const project = findNearestMcppProject(workspaceFolder.uri.fsPath);
    if (project !== undefined) {
      return project;
    }
  }
  return undefined;
}

function outputText(output: vscode.OutputChannel, line: string): void {
  try {
    output.appendLine(line);
  } catch {
    // The output channel can close before an async task finishes during shutdown.
  }
}

function resultText(output: vscode.OutputChannel, result: LanguageServerCommandResult): void {
  const formatted = formatResult(result);
  outputText(output, `[C++ Modules] ${formatted.message}${formatted.hint === undefined ? "" : ` ${formatted.hint}`}`);
  if (result.state === "unavailable") {
    const install = t("Install extension");
    void vscode.window.showWarningMessage(formatted.message, install).then((choice) => {
      if (choice === install) {
        void vscode.commands.executeCommand("workbench.extensions.search", `@id:${MCPPLS_EXTENSION_ID}`);
      }
    });
    return;
  }
  if (formatted.severity === "warning") {
    void vscode.window.showWarningMessage(formatted.message);
  } else if (formatted.severity === "error") {
    void vscode.window.showErrorMessage(formatted.message);
  }
}

function moduleSetupBlockedMessage(reason: Extract<ModuleSetupDecision, { kind: "blocked" }>["reason"]): string {
  switch (reason) {
    case "untrusted":
      return "当前工作区未受信任，不会执行 mcpp 或刷新 C++ 模块语言服务。请先信任工作区。";
    case "busy":
      return "已有 mcpp 操作正在运行，请等待完成后再试。";
  }
}

function taskCompletionText(completion: TaskCompletion): string {
  if (completion.state === "cancelled") {
    return "构建已取消；C++ 模块语言服务未刷新。";
  }
  if (completion.state === "failed") {
    return `mcpp 构建失败（退出码 ${completion.exitCode ?? "未知"}）；C++ 模块语言服务已重新读取现有构建描述。`;
  }
  return "mcpp 构建完成，C++ 模块语言服务已刷新。";
}

async function autoConfigureModulesWizard(
  bridge: LanguageServerBridge,
  cliController: McppCliController,
  output: vscode.OutputChannel,
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    await vscode.window.showWarningMessage(moduleSetupBlockedMessage("untrusted"));
    return;
  }
  if (cliController.isBusy()) {
    await vscode.window.showWarningMessage(moduleSetupBlockedMessage("busy"));
    return;
  }

  const decision = buildModuleSetupPlan(true, false);
  if (decision.kind === "blocked") {
    await vscode.window.showWarningMessage(moduleSetupBlockedMessage(decision.reason));
    return;
  }
  const confirmation = moduleSetupConfirmation();
  const choice = await vscode.window.showWarningMessage(
    confirmation.message,
    { modal: true, detail: confirmation.detail },
    "确认一键配置",
  );
  if (choice !== "确认一键配置") {
    return;
  }

  const outcome = await executeModuleSetup(decision, {
    build: async (): Promise<ModuleSetupStepResult> => {
      const completion = await cliController.runProjectTask("build", { notify: false });
      if (completion === undefined) {
        return {
          stage: "build",
          state: "not-started",
          detail: "未启动 mcpp 构建。",
        };
      }
      return {
        stage: "build",
        state: completion.state,
        exitCode: completion.exitCode,
      };
    },
    refreshLanguageServer: async (): Promise<ModuleSetupStepResult> => {
      const result = await bridge.refreshLanguageServerAfterBuild();
      resultText(output, result);
      return {
        stage: "language-server",
        state: result.state === "completed" ? "succeeded" : "failed",
        detail: result.state === "completed" ? undefined : formatResult(result).message,
      };
    },
  });

  const buildStep = outcome.steps[0];
  if (outcome.state === "succeeded") {
    await vscode.window.showInformationMessage(
      taskCompletionText(buildStep?.state === "failed" ? { state: "failed", exitCode: buildStep.exitCode } : { state: "succeeded" }),
    );
  } else if (outcome.state === "cancelled") {
    await vscode.window.showWarningMessage(taskCompletionText({ state: "cancelled" }));
  } else {
    await vscode.window.showErrorMessage(outcome.steps.at(-1)?.detail ?? "C++ 模块语言服务配置失败。");
  }
}

export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("mcpp");

  // Language first: everything below may want to speak to the user.
  applyLanguagePreference();
  extensionContext.subscriptions.push(onConfigurationChanged(applyLanguagePreference));

  const bridge = createLanguageServerBridge({
    extensionInstalled: (id) => vscode.extensions.getExtension(id) !== undefined,
    declaredCommands: declaredCommandsOf,
    activateExtension: async (id) => {
      await vscode.extensions.getExtension(id)?.activate();
    },
    executeCommand: <T>(command: string, ...args: unknown[]) => vscode.commands.executeCommand<T>(command, ...args),
  });
  const runGuarded = (operation: () => Promise<void>): (() => Promise<void>) => async () => {
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputText(output, `发生未预期错误：${message}`);
      void vscode.window.showErrorMessage(`mcpp：${message}`);
    }
  };
  const invokeLanguageServer = (
    operation: () => Promise<LanguageServerCommandResult>,
  ): (() => Promise<void>) => runGuarded(async () => {
    resultText(output, await operation());
  });

  const manifestWatcher = vscode.workspace.createFileSystemWatcher(MCPP_MANIFEST_GLOB);
  const inProjectContext = registerInProjectContext({
    currentProject: findCurrentProject,
    setContextValue: (key, value) => vscode.commands.executeCommand("setContext", key, value),
    subscribe: (listener) => [
      vscode.window.onDidChangeActiveTextEditor(listener),
      vscode.workspace.onDidChangeWorkspaceFolders(listener),
      manifestWatcher.onDidCreate(listener),
      manifestWatcher.onDidDelete(listener),
    ],
  });

  const afterProjectTask = async (
    _project: McppProjectDiscovery,
    _kind: "build" | "run" | "test" | "clean",
    completion: TaskCompletion,
  ): Promise<void> => {
    if (completion.state === "cancelled") {
      return;
    }
    const mode = read<string>("mcpp.languageService.refreshAfterBuild");
    if (mode === "off") {
      lastRefresh = { at: new Date().toISOString(), state: "skipped (mcpp.languageService.refreshAfterBuild = off)" };
      return;
    }
    const result =
      mode === "restart" ? await bridge.restartLanguageServer() : await bridge.refreshLanguageServerAfterBuild();
    lastRefresh = { at: new Date().toISOString(), state: result.state, command: result.command };
    resultText(output, result);
    if (completion.state === "succeeded" && result.state === "completed") {
      await vscode.window.showInformationMessage(taskCompletionText(completion));
    } else if (completion.state === "failed" && result.state === "completed") {
      await vscode.window.showWarningMessage(taskCompletionText(completion));
    }
  };

  const cliController = new McppCliController({
    output,
    currentProject: findCurrentProject,
    afterProjectTask,
    isTrusted: () => vscode.workspace.isTrusted,
  });

  // ── views ────────────────────────────────────────────────────────────────
  // Each view owns its own tree provider and its own commands; the project view
  // reads the manifest, the cache view runs mcpp's read-only queries, and the
  // C++ Modules view only forwards to mcppls.
  const applyViewVisibility = (): void => {
    for (const [key, setting] of [
      ["mcpp.views.project", "mcpp.views.project.show"],
      ["mcpp.views.cache", "mcpp.views.cache.show"],
      ["mcpp.views.languageServer", "mcpp.views.languageServer.show"],
    ] as const) {
      void vscode.commands.executeCommand("setContext", key, read<boolean>(setting));
    }
  };
  applyViewVisibility();
  extensionContext.subscriptions.push(onConfigurationChanged(applyViewVisibility));

  registerProjectView(extensionContext, { currentProject: findCurrentProject });
  registerCacheView(extensionContext, {
    output,
    currentProject: findCurrentProject,
    mcppExecutable: (project) => cliController.mcppExecutable(project),
    isTrusted: () => vscode.workspace.isTrusted,
  });
  registerLanguageServerView(extensionContext, { bridge, output });
  registerSettingsPanel(extensionContext);

  // Text analysis only: no mcpp process, so both stay available in a restricted
  // workspace, which is exactly what the `limited` capability promises.
  registerTomlProviders(
    extensionContext,
    () => read<boolean>("mcpp.toml.completion"),
    () => ({
      syntax: read("mcpp.toml.diagnostics.syntax"),
      unknownSection: read("mcpp.toml.diagnostics.unknownSection"),
      unknownKey: read("mcpp.toml.diagnostics.unknownKey"),
      planeSeparation: read("mcpp.toml.diagnostics.planeSeparation"),
      legacyKeys: read("mcpp.toml.diagnostics.legacyKeys"),
    }),
    () => read<boolean>("mcpp.toml.diagnostics.enabled"),
    () => read<boolean>("mcpp.toml.hover"),
    () => read<boolean>("mcpp.toml.navigation"),
  );
  registerBuildScriptProviders(extensionContext, () => {
    if (!read<boolean>("mcpp.buildScript.intelligence") || !read<boolean>("mcpp.buildScript.diagnostics")) {
      return "off";
    }
    return read<"warning" | "info" | "off">("mcpp.buildScript.diagnostics.severity");
  });

  extensionContext.subscriptions.push(
    output,
    manifestWatcher,
    inProjectContext,
    ...cliController.register(),

    // The ids from 0.4.x keep working.
    vscode.commands.registerCommand(CLI_COMMANDS.autoConfigureModules, runGuarded(async () => {
      const project = findCurrentProject();
      if (project === undefined) {
        await vscode.window.showWarningMessage(t("This workspace has no mcpp.toml."));
        return;
      }
      await autoConfigureModulesWizard(bridge, cliController, output);
    })),
    vscode.commands.registerCommand(LEGACY_LANGUAGE_SERVER_COMMANDS.refreshCompilationDatabase, runGuarded(async () => {
      await cliController.runProjectTask("build");
    })),

    // Environment self-check: one copyable snapshot of everything a bug report needs.
    vscode.commands.registerCommand(TOOL_COMMANDS.selfCheck, runGuarded(async () => {
      await showSelfCheck(output, cliController, bridge, extensionContext.extension.packageJSON.version);
    })),

    vscode.workspace.onDidGrantWorkspaceTrust(() => cliController.refreshStatus()),
  );

  if (read<boolean>("mcpp.diagnostics.selfCheckOnStartup")) {
    void showSelfCheck(output, cliController, bridge, extensionContext.extension.packageJSON.version);
  }

  extensionContext.subscriptions.push(
    manifestWatcher.onDidCreate(() => cliController.refreshStatus()),
    manifestWatcher.onDidChange(() => cliController.refreshStatus()),
    manifestWatcher.onDidDelete(() => cliController.refreshStatus()),
  );
}

/**
 * The self-check gathers, never guesses: anything it cannot read is reported as
 * unknown rather than left blank. It is the first thing to ask for in a bug
 * report, and it writes to the `mcpp` channel so it can be copied in one go.
 */
async function showSelfCheck(
  output: vscode.OutputChannel,
  cliController: McppCliController,
  bridge: LanguageServerBridge,
  extensionVersion: unknown,
): Promise<void> {
  const project = findCurrentProject();
  const executable = cliController.mcppExecutable(project);
  const timeoutSeconds = read<number>("mcpp.runtime.timeoutSeconds");
  const probeResult = await runProcess(executable, ["--protocol-version"], project?.root, {
    timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
  });
  const info = probeResult.exitCode === 0 ? parseProtocolInfo(probeResult.stdout) : undefined;
  const state = readLanguageServerState();
  const capabilities = CAPABILITIES.map((entry) => ({
    key: entry.key,
    state: bridge.isGone(entry.key) ? "missing" : bridge.isUnconfirmed(entry.key) ? "unconfirmed" : "available",
  }));
  const text = buildSelfCheckText({
    extensionVersion: typeof extensionVersion === "string" ? extensionVersion : "unknown",
    vscodeVersion: vscode.version,
    platform: `${process.platform}-${process.arch}`,
    languagePreference: languagePreference(),
    trusted: vscode.workspace.isTrusted,
    workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    projectRoot: project?.root,
    mcppPath: executable,
    mcppProbe:
      info === undefined
        ? undefined
        : { version: info.mcppVersion, envelopeMax: info.envelopeMax, kinds: Object.keys(info.kinds) },
    mcppls: {
      installed: languageServerInstalled(),
      version: languageServerVersion(),
      enabled: languageServerEnabled(),
      state: describeState(state),
      capabilities,
    },
    changedSettings: changedSettings(project === undefined ? undefined : vscode.Uri.file(project.root)),
    lastRefresh: lastRefresh,
  });
  output.appendLine("");
  output.appendLine("===== mcpp: environment self-check =====");
  output.appendLine(text);
  output.appendLine("========================================");
  output.show(true);
}

export function deactivate(): void {
  // VS Code disposes everything registered in activate().
}
