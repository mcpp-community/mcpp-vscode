import * as vscode from "vscode";

import { McppCliController, discoveryBoundaryFromSettings } from "./cli/controller";
import { runProcess } from "./cli/process";
import { parseProtocolInfo } from "./cli/protocol";
import { buildSelfCheckText } from "./cli/selfCheck";
import { CLI_COMMANDS, LEGACY_LANGUAGE_SERVER_COMMANDS, LIBRARY_COMMANDS, TOOL_COMMANDS } from "./commands/ids";
import { findNearestMcppProject, type McppProjectDiscovery } from "./projects/discovery";
import { MCPP_MANIFEST_GLOB, registerInProjectContext } from "./projects/context";
import {
  createLanguageServerBridge,
  type LanguageServerBridge,
  type LanguageServerCommandResult,
} from "./mcppls/bridge";
import { CAPABILITIES, MCPPLS_EXTENSION_ID, VERIFIED_MCPPLS_RANGE } from "./mcppls/contract";
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
import { applyRenames, pendingRenames, renamePrompt } from "./config/migrate";
import { registerSettingsPanel } from "./config/panel";
import { languagePreference, setLanguagePreference, t, type LanguagePreference } from "./i18n/t";
import { readCacheSnapshot, registerCacheView } from "./cache/cacheView";
import { registerLanguageServerCommands } from "./views/languageServerView";
import { createLibraryDetailOpener } from "./library/detailPanel";
import { loadSnapshot } from "./library/indexLocator";
import { registerLibraryView } from "./library/libraryView";
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
    return findNearestMcppProject(
      activeUri.fsPath,
      workspaceFolder.uri.fsPath,
      discoveryBoundaryFromSettings(workspaceFolder.uri),
    );
  }

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    const project = findNearestMcppProject(
      workspaceFolder.uri.fsPath,
      workspaceFolder.uri.fsPath,
      discoveryBoundaryFromSettings(workspaceFolder.uri),
    );
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
      return t("This workspace is not trusted, so mcpp will not run and the C++ Modules language service will not refresh. Trust the workspace first.");
    case "busy":
      return t("An mcpp operation is already running; wait for it to finish and try again.");
  }
}

function taskCompletionText(completion: TaskCompletion): string {
  if (completion.state === "cancelled") {
    return t("The build was cancelled; the C++ Modules language service was not refreshed.");
  }
  if (completion.state === "failed") {
    return t("The mcpp build failed (exit code {0}); the C++ Modules language service re-read the existing build description.", completion.exitCode ?? t("unknown"));
  }
  return t("The mcpp build finished; the C++ Modules language service has been refreshed.");
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
  // One definition: the label is shown *and* the reply is compared against it.
  const confirmLabel = t("Confirm one-click setup");
  const choice = await vscode.window.showWarningMessage(
    confirmation.message,
    { modal: true, detail: confirmation.detail },
    confirmLabel,
  );
  if (choice !== confirmLabel) {
    return;
  }

  const outcome = await executeModuleSetup(decision, {
    build: async (): Promise<ModuleSetupStepResult> => {
      const completion = await cliController.runProjectTask("build", { notify: false });
      if (completion === undefined) {
        return {
          stage: "build",
          state: "not-started",
          detail: t("mcpp build was not started."),
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
    await vscode.window.showErrorMessage(outcome.steps.at(-1)?.detail ?? t("Configuring the C++ Modules language service failed."));
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
      outputText(output, t("Unexpected error: {0}", message));
      void vscode.window.showErrorMessage(t("mcpp: {0}", message));
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
    extensionUri: extensionContext.extensionUri,
    currentProject: findCurrentProject,
    afterProjectTask,
    isTrusted: () => vscode.workspace.isTrusted,
    languageServerSummary: () => {
      const view = readLanguageServerState();
      return view.available ? view.state : undefined;
    },
  });

  // ── views ────────────────────────────────────────────────────────────────
  // Each view owns its own tree provider and its own commands; the project view
  // reads the manifest, the cache view runs mcpp's read-only queries, and the
  // C++ Modules view only forwards to mcppls.
  const applyViewVisibility = (): void => {
    // Literal keys, so the wiring gate can see them.
    // `mcpp.views.enabled` is the master switch: with it off every view is hidden and
    // VS Code removes the container from the activity bar with them. The `when`
    // clauses in package.json are negated (`!mcpp.sidebarHidden`) so the default
    // state is visible — otherwise activation would never run to set the key back.
    void vscode.commands.executeCommand("setContext", "mcpp.sidebarHidden", !read<boolean>("mcpp.views.enabled"));
    void vscode.commands.executeCommand("setContext", "mcpp.views.project", read<boolean>("mcpp.views.project.show"));
    void vscode.commands.executeCommand("setContext", "mcpp.views.library", read<boolean>("mcpp.views.library.show"));
    void vscode.commands.executeCommand("setContext", "mcpp.views.cache", read<boolean>("mcpp.views.cache.show"));
  };
  applyViewVisibility();
  extensionContext.subscriptions.push(onConfigurationChanged(applyViewVisibility));

  // The language service is a block inside the project view, so its state source has
  // to exist before the view is registered.
  const languageService = registerLanguageServerCommands(extensionContext, { bridge, output });
  registerProjectView(extensionContext, { currentProject: findCurrentProject, languageService });
  // The library ecosystem: a sidebar view plus an editor-area package page. The
  // detail page writes `mcpp.toml` through `mcpp add`, so it tells the view to
  // refresh — no save event fires for a file written outside the editor.
  const openLibraryDetail = createLibraryDetailOpener(extensionContext, {
    mcppExecutable: () => cliController.mcppExecutable(findCurrentProject()),
    projectRoot: () => findCurrentProject()?.root,
    output,
    isTrusted: () => vscode.workspace.isTrusted,
    onDependenciesChanged: () => void library.refresh(),
  });
  const library = registerLibraryView(extensionContext, {
    projectRoot: () => findCurrentProject()?.root,
    mcppExecutable: () => cliController.mcppExecutable(findCurrentProject()),
    openDetail: openLibraryDetail,
    output,
  });
  // `registerLibraryView` registers its own webview provider; these are only the
  // entry points a menu or the project view can name.
  extensionContext.subscriptions.push(
    vscode.commands.registerCommand(LIBRARY_COMMANDS.search, async () => {
      await vscode.commands.executeCommand("mcpp.library.focus");
    }),
    vscode.commands.registerCommand(LIBRARY_COMMANDS.openDetail, async (id: unknown) => {
      if (typeof id === "string" && id.length > 0) {
        await openLibraryDetail(id);
      }
    }),
    vscode.commands.registerCommand(LIBRARY_COMMANDS.updateIndex, async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage(
          t("This workspace is not trusted. mcpp commands may run external programs named by workspace settings; trust the workspace first."),
        );
        return;
      }
      const project = findCurrentProject();
      // A refresh that reaches the network is worth a progress notification, and
      // a refresh that succeeds has to *say so*: the command produced no visible
      // change at all before, which reads exactly like a broken button.
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t("Refreshing the mcpp Package Index…") },
        () =>
          runProcess(cliController.mcppExecutable(project), ["index", "update"], project?.root, {
            timeoutMs: 300_000,
          }),
      );
      await library.refresh();
      if (result.exitCode !== 0) {
        void vscode.window.showErrorMessage(t("mcpp index update failed with exit code {0}", result.exitCode));
        return;
      }
      // `library.refresh()` has just filled the snapshot cache, so this second
      // look is the count the view is showing, not another read of the index.
      const snapshot = await loadSnapshot(project === undefined ? {} : { projectRoot: project.root });
      void vscode.window.showInformationMessage(
        t(
          "mcpp Package Index refreshed: {0} package(s) from {1} index folder(s).",
          snapshot.entries.length,
          snapshot.roots.length,
        ),
      );
    }),
  );
  // There is no `mcpp.library.indexFound` context key and no `viewsWelcome`
  // entry for the library view. `paneview.ts`'s base `ViewPane` answers
  // `shouldShowWelcome() === false`; only the tree-shaped panes override it, so
  // welcome content can never render inside a `"type": "webview"` view. The
  // library view states its own empty case in the document instead, which is the
  // only place VS Code will show it.

  registerCacheView(extensionContext, {
    output,
    currentProject: findCurrentProject,
    mcppExecutable: (project) => cliController.mcppExecutable(project),
    isTrusted: () => vscode.workspace.isTrusted,
  });
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

  void offerSettingRenames(extensionContext);
  void noteUnverifiedLanguageService(output);

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
 * The 0.4.x keys that were renamed still hold values nothing reads. Offer to move
 * them, once per workspace — and leave the old key in place either way, because
 * deleting a user's setting is their decision.
 */
async function offerSettingRenames(context: vscode.ExtensionContext): Promise<void> {
  const pending = pendingRenames(vscode.window.activeTextEditor?.document.uri);
  if (pending.length === 0 || context.workspaceState.get<boolean>("mcpp.renamesOffered") === true) {
    return;
  }
  await context.workspaceState.update("mcpp.renamesOffered", true);

  const toUser = t("Move them to my user settings");
  const toWorkspace = t("Move them to this workspace");
  const choice = await vscode.window.showInformationMessage(renamePrompt(pending), toUser, toWorkspace);
  if (choice !== toUser && choice !== toWorkspace) {
    return;
  }
  const moved = await applyRenames(pending, choice === toUser ? "user" : "workspace");
  void vscode.window.showInformationMessage(t("mcpp: moved {0} setting(s).", moved));
}

/**
 * A version notice, never a gate. `extensionDependencies` cannot express a version
 * range, so a user can legitimately end up with a build of the language service
 * older than the one this extension was tested against; the capability probe means
 * that still works, but it is worth one sentence in the log.
 */
async function noteUnverifiedLanguageService(output: vscode.OutputChannel): Promise<void> {
  const version = languageServerVersion();
  if (version === undefined) {
    return;
  }
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const below = major < 0 || (major === 0 && (minor < 0 || (minor === 0 && patch < 4)));
  if (below) {
    output.appendLine(
      t("{0} {1} is older than the verified range ({2}); the capability probe will hide what it cannot do.", MCPPLS_EXTENSION_ID, version, VERIFIED_MCPPLS_RANGE),
    );
  }
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
    cache: await readCacheSnapshot(),
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
