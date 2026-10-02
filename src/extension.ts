import * as vscode from "vscode";

import { McppCliController } from "./cli/controller";
import { CLI_COMMANDS, DEPRECATED_COMMANDS } from "./commands/ids";
import { findNearestMcppProject, type McppProjectDiscovery } from "./projects/discovery";
import { MCPP_MANIFEST_GLOB, registerInProjectContext } from "./projects/context";
import {
  createLanguageServerBridge,
  type LanguageServerBridge,
  type LanguageServerCommandResult,
} from "./mcppls/bridge";
import { computeMcppTomlCompletions } from "./toml/completion";
import {
  buildModuleSetupPlan,
  executeModuleSetup,
  moduleSetupConfirmation,
  type ModuleSetupDecision,
  type ModuleSetupStepResult,
} from "./workflows/moduleSetup";
import type { TaskCompletion } from "./cli/tasks";
import { onDidChange as onConfigurationChanged, read } from "./config/access";
import { setLanguagePreference, type LanguagePreference } from "./i18n/t";

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
  outputText(output, `[C++ Modules] ${result.message}`);
  if (result.state === "unavailable") {
    void vscode.window.showWarningMessage(result.message, "安装扩展").then((choice) => {
      if (choice === "安装扩展") {
        void vscode.commands.executeCommand("workbench.extensions.search", "@id:sunrisepeak.mcpp-language-server");
      }
    });
  } else if (result.state === "failed") {
    void vscode.window.showErrorMessage(result.message);
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
        detail: result.state === "completed" ? undefined : result.message,
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

// mcpp.toml structural completion is deliberately local text analysis. It never executes mcpp or
// the language server, so it remains available in restricted workspaces.
const mcppTomlCompletionKinds = {
  section: vscode.CompletionItemKind.Folder,
  template: vscode.CompletionItemKind.Snippet,
} as const;

const mcppTomlCompletionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(document, position) {
    if (!vscode.workspace.getConfiguration("mcpp", document.uri).get<boolean>("tomlCompletion", true)) {
      return undefined;
    }
    const lines: string[] = [];
    for (let line = 0; line <= position.line; line += 1) {
      lines.push(document.lineAt(line).text);
    }
    return computeMcppTomlCompletions(lines, position.line, position.character).map((suggestion) => {
      const item = new vscode.CompletionItem(
        suggestion.label,
        mcppTomlCompletionKinds[suggestion.kind],
      );
      item.detail = suggestion.detail;
      if (suggestion.documentation !== undefined) {
        item.documentation = new vscode.MarkdownString(suggestion.documentation);
      }
      if (suggestion.insertSnippet !== undefined) {
        item.insertText = new vscode.SnippetString(suggestion.insertSnippet);
      }
      item.range = new vscode.Range(
        position.line,
        suggestion.range.startCharacter,
        position.line,
        suggestion.range.endCharacter,
      );
      return item;
    });
  },
};

export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("mcpp");

  // Language first: everything below may want to speak to the user.
  applyLanguagePreference();
  extensionContext.subscriptions.push(onConfigurationChanged(applyLanguagePreference));

  const bridge = createLanguageServerBridge({
    extensionInstalled: (id) => vscode.extensions.getExtension(id) !== undefined,
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
    const result = await bridge.refreshLanguageServerAfterBuild();
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

  extensionContext.subscriptions.push(
    output,
    manifestWatcher,
    inProjectContext,
    ...cliController.register(),
    vscode.languages.registerCompletionItemProvider(
      { language: "mcpp-toml" },
      mcppTomlCompletionProvider,
      "[",
    ),
    vscode.commands.registerCommand(CLI_COMMANDS.configureLanguageServer, invokeLanguageServer(
      () => bridge.selectContext(),
    )),
    vscode.commands.registerCommand(DEPRECATED_COMMANDS.configureClangd, invokeLanguageServer(
      () => bridge.selectContext(),
    )),
    vscode.commands.registerCommand(CLI_COMMANDS.refreshCompilationDatabase, runGuarded(async () => {
      await cliController.runProjectTask("build");
    })),
    vscode.commands.registerCommand(CLI_COMMANDS.checkModuleSupport, invokeLanguageServer(
      () => bridge.restartLanguageServer(),
    )),
    vscode.commands.registerCommand(CLI_COMMANDS.showModuleGraph, invokeLanguageServer(
      () => bridge.showModuleGraph(),
    )),
    vscode.commands.registerCommand(CLI_COMMANDS.showLanguageServerLogs, invokeLanguageServer(
      () => bridge.showLanguageServerLogs(),
    )),
    vscode.commands.registerCommand(CLI_COMMANDS.autoConfigureModules, runGuarded(async () => {
      const project = findCurrentProject();
      if (project === undefined) {
        await vscode.window.showWarningMessage("当前工作区没有找到 mcpp.toml。");
        return;
      }
      await autoConfigureModulesWizard(bridge, cliController, output);
    })),
    vscode.workspace.onDidGrantWorkspaceTrust(() => cliController.refreshStatus()),
  );

  extensionContext.subscriptions.push(
    manifestWatcher.onDidCreate(() => cliController.refreshStatus()),
    manifestWatcher.onDidChange(() => cliController.refreshStatus()),
    manifestWatcher.onDidDelete(() => cliController.refreshStatus()),
  );
}

export function deactivate(): void {
  // VS Code disposes everything registered in activate().
}
