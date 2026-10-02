import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import * as vscode from "vscode";

import {
  hostDefaultToolchains,
  mcppCommandArguments,
  normalizeToolchainSpec,
  parseToolchainList,
  toolchainInstallKind,
  toolchainSpecTargetHint,
  type ToolchainInventory,
  type ToolchainItem,
} from "./toolchain";
import {
  discoveryBoundaryOf,
  type DiscoveryBoundary,
  type McppProjectDiscovery,
} from "../projects/discovery";
import { updateEditorTitleButtonsContext } from "../projects/context";
import { createLogger, type Logger } from "../util/log";
import { runProcess } from "./process";
import {
  McppOperationRegistry,
  classifyTaskExit,
  projectTaskPlan,
  TASK_ARGUMENT_SETTINGS,
  shouldRefreshLanguageServerAfterTask,
  type ProjectTaskKind,
  type TaskCompletion,
} from "./tasks";
import { classifyExit, explainHint, type McppFailureKind, type McppOutcome } from "./errors";
import { CLI_COMMANDS } from "../commands/ids";
import { QUICK_MENU_GROUPS, quickMenuItems, quickMenuStatusText } from "../commands/menu";
import { read } from "../config/access";
import { t } from "../i18n/t";
import { controllerLabels } from "./labels";
import { runNewProjectFlow, validateNewProjectName } from "./newProject";

export interface McppCliControllerOptions {
  output: vscode.OutputChannel;
  currentProject: () => McppProjectDiscovery | undefined;
  afterProjectTask: (
    project: McppProjectDiscovery,
    kind: ProjectTaskKind,
    completion: TaskCompletion,
  ) => Promise<void>;
  isTrusted: () => boolean;
  /**
   * `mcpp.ui.statusBar.showLanguageServer`: one short line describing the C++
   * Modules state, or `undefined` when there is nothing to show. A callback
   * instead of an import so this controller never depends on `src/mcppls/**`;
   * the extension layer owns the bridge and passes it in.
   */
  languageServerSummary?: () => string | undefined;
}

interface ToolchainPickItem extends vscode.QuickPickItem {
  spec?: string;
  toolchain?: ToolchainItem;
  customInput?: boolean;
}

type OperationToken = object;

export interface ProjectTaskRunOptions {
  /** Set to false when the caller performs its own post-task action. */
  notify?: boolean;
}

function taskScope(root: string): vscode.WorkspaceFolder | vscode.TaskScope {
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))
    ?? vscode.TaskScope.Workspace;
}

function workingDirectory(project: McppProjectDiscovery | undefined): string {
  if (project !== undefined) {
    return project.root;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function commandLine(executable: string, args: string[]): string {
  return [executable, ...args].join(" ");
}

// ─── pure policy ────────────────────────────────────────────────────────────
//
// Every decision a setting makes is computed by a pure function in this block,
// so `test/cli/controller.*.test.ts` can assert the decision without an editor.
// The class below only executes what these functions decide.

export type TaskRevealSetting = "always" | "onFailure" | "never";

export interface TaskTerminalUi {
  /** `mcpp.task.revealTerminal`. */
  reveal: TaskRevealSetting;
  /** `mcpp.task.focusTerminal`: hand keyboard focus to the task terminal. */
  focus: boolean;
  /** `mcpp.task.clearTerminal`: clear the panel before the command runs. */
  clearBeforeRun: boolean;
}

export function taskTerminalUi(
  revealTerminal: unknown,
  focusTerminal: unknown,
  clearTerminal: unknown,
): TaskTerminalUi {
  return {
    reveal:
      revealTerminal === "never" || revealTerminal === "onFailure" ? revealTerminal : "always",
    focus: focusTerminal === true,
    clearBeforeRun: clearTerminal !== false,
  };
}

/** `workbench.action.terminal.*` commands to run once the task has finished. */
export function terminalCommandsAfterTask(ui: TaskTerminalUi, failed: boolean): readonly string[] {
  // VS Code has no "reveal without focusing" command, so the one command below
  // is both the reveal and the focus for the failure-only setting.
  return failed && ui.reveal === "onFailure" ? ["workbench.action.terminal.focus"] : [];
}

/** The problem matcher `package.json` must contribute under `contributes.problemMatchers`. */
export const PROBLEM_MATCHER_NAME = "$mcpp";

export function problemMatchersFor(enabled: unknown): readonly string[] {
  return enabled === false ? [] : [PROBLEM_MATCHER_NAME];
}

/**
 * `mcpp.task.confirmClean`: this decides only the controller's own prompt for
 * `mcpp.clean`. The cleanup plan (`src/cli/clean.ts`) keeps its own level-2/3
 * confirmations, which this setting can never remove.
 */
export function cleanConfirmationRequired(confirmClean: unknown): boolean {
  return confirmClean !== false;
}

export type ConfirmationStrength = "notice" | "modal";

export interface ConfirmationPolicy {
  installToolchain: ConfirmationStrength;
  globalDefault: ConfirmationStrength;
}

/**
 * `mcpp.ui.confirmDestructiveOnly` (default true) reserves a modal for actions
 * that cannot be undone. Turning it off escalates these two undoable prompts
 * from a dismissible notification to a modal — the prompt, its text and its
 * buttons are identical in both modes, so the setting can only ask *more*
 * insistently, never less often.
 */
export function confirmationPolicy(confirmDestructiveOnly: unknown): ConfirmationPolicy {
  const strength: ConfirmationStrength = confirmDestructiveOnly === false ? "modal" : "notice";
  return { installToolchain: strength, globalDefault: strength };
}

/** `mcpp.ui.statusBar.showLanguageServer`: the suffix the status item gains. */
export function languageServerStatusSuffix(show: unknown, summary: string | undefined): string | undefined {
  if (show !== true) {
    return undefined;
  }
  const text = summary?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

export type SuccessReport = "silent" | "statusBar" | "toast";

/** `mcpp.ui.notifications.success`; only a *successful* result consults this. */
export function successReportOf(value: unknown): SuccessReport {
  return value === "silent" || value === "toast" ? value : "statusBar";
}

/**
 * `mcpp.ui.notifications.dedupeMinutes`: true when the same message may be
 * shown again. `0` (or an unusable value) shows every notification.
 */
export function dedupeAllows(lastAt: number | undefined, now: number, dedupeMinutes: unknown): boolean {
  if (typeof dedupeMinutes !== "number" || !Number.isFinite(dedupeMinutes) || dedupeMinutes <= 0) {
    return true;
  }
  if (typeof lastAt !== "number" || !Number.isFinite(lastAt)) {
    return true;
  }
  return now - lastAt >= dedupeMinutes * 60_000;
}

export const STATUS_BAR_SUCCESS_MAX = 60;

/** A status bar item is a label, not a paragraph. */
export function statusBarSuccessText(message: string): string {
  const single = message.replace(/\s+/g, " ").trim();
  return single.length <= STATUS_BAR_SUCCESS_MAX
    ? single
    : `${single.slice(0, STATUS_BAR_SUCCESS_MAX - 1)}…`;
}

export interface FailureAdvice {
  kind: McppFailureKind;
  exitCode: number;
  /** `mcpp self explain <CODE>`, when the output or code names a diagnostic. */
  hint?: string;
}

/**
 * `src/cli/errors.ts` (SPEC-003) applied to a failed run: the failure kind that
 * picks the guidance, plus the `mcpp self explain` follow-up when there is a
 * diagnostic code to explain.
 */
export function failureAdvice(args: readonly string[], exitCode: number, output: string): FailureAdvice {
  const outcome: McppOutcome = { ...classifyExit(exitCode, args), detail: output };
  return { kind: outcome.kind, exitCode: outcome.exitCode, hint: explainHint(outcome) };
}

/** The exit-code-specific next step, or `undefined` to keep the caller's message. */
function failureGuidanceText(kind: McppFailureKind): string | undefined {
  switch (kind) {
    case "usage":
      return t("mcpp rejected the command line; check the arguments and run it from the project root.");
    case "environment":
      return t("mcpp is installed but the environment is not ready; run `mcpp self doctor` to see what is missing.");
    case "internal":
      return t("mcpp reported an internal error; re-run with the mcpp output channel open and report it.");
    case "unknown-command":
      return t("This mcpp build does not recognise that command; update mcpp or check the spelling.");
    case "build-failed":
      return t("The program did not build; see the task terminal for the compiler output.");
    default:
      return undefined;
  }
}

/**
 * The `vscode`-side read of `mcpp.project.discoveryBoundary`. `extension.ts`
 * passes the result into `findNearestMcppProject`, whose walk stays pure. The
 * resource is the workspace folder, because the setting is resource-scoped.
 */
export function discoveryBoundaryFromSettings(resource?: vscode.Uri): DiscoveryBoundary {
  return discoveryBoundaryOf(read<string>("mcpp.project.discoveryBoundary", resource));
}

const SUCCESS_STATUS_MS = 6000;

export class McppCliController {
  private readonly status: vscode.StatusBarItem;

  private readonly operations = new McppOperationRegistry<OperationToken>();

  /** `mcpp.log.level` decides what reaches the `mcpp` channel; see `src/util/log.ts`. */
  private readonly logger: Logger;

  /** `mcpp.ui.notifications.dedupeMinutes`: message signature -> last shown (ms). */
  private readonly lastNotified = new Map<string, number>();

  /** Reverts the transient success text in the status item. */
  private statusRevert: ReturnType<typeof setTimeout> | undefined;

  public constructor(private readonly options: McppCliControllerOptions) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
    this.status.command = CLI_COMMANDS.showMenu;
    this.logger = createLogger(this.options.output, () => read<unknown>("mcpp.log.level"));
    this.applyStatusBar();
  }

  public register(): vscode.Disposable[] {
    this.applyStatusBar();
    const applyEditorTitleButtons = (): void => {
      void updateEditorTitleButtonsContext({
        enabled: () => read<boolean>("mcpp.task.editorTitleButtons"),
        setContextValue: (key, value) => vscode.commands.executeCommand("setContext", key, value),
      }).catch(() => undefined);
    };
    applyEditorTitleButtons();
    const disposables: vscode.Disposable[] = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("mcpp.ui.statusBar")) {
          this.applyStatusBar();
        }
        if (event.affectsConfiguration("mcpp.task.editorTitleButtons")) {
          applyEditorTitleButtons();
        }
      }),
      this.status,
      vscode.commands.registerCommand(CLI_COMMANDS.showMenu, this.guarded(() => this.showMenu())),
      vscode.commands.registerCommand(CLI_COMMANDS.newProject, this.guarded(() => this.newProject())),
      vscode.commands.registerCommand(CLI_COMMANDS.build, this.guarded(() => this.runProjectTask("build"))),
      vscode.commands.registerCommand(CLI_COMMANDS.run, this.guarded(() => this.runProjectTask("run"))),
      vscode.commands.registerCommand(CLI_COMMANDS.test, this.guarded(() => this.runProjectTask("test"))),
      vscode.commands.registerCommand(CLI_COMMANDS.clean, this.guarded(() => this.runProjectTask("clean"))),
      vscode.commands.registerCommand(CLI_COMMANDS.showToolchains, this.guarded(() => this.showToolchains())),
      vscode.commands.registerCommand(CLI_COMMANDS.installToolchain, this.guarded(() => this.installToolchain())),
      vscode.commands.registerCommand(CLI_COMMANDS.selectDefaultToolchain, this.guarded(() => this.selectDefaultToolchain())),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshStatus()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshStatus()),
    ];
    this.refreshStatus();
    return disposables;
  }

  public refreshStatus(): void {
    if (this.options.currentProject() === undefined) {
      this.status.hide();
      return;
    }
    this.applyStatusBar();
  }

  public isBusy(): boolean {
    return this.operations.hasActive();
  }

  public async runProjectTask(
    kind: ProjectTaskKind,
    options: ProjectTaskRunOptions = {},
  ): Promise<TaskCompletion | undefined> {
    const project = this.requireProject();
    if (project === undefined || !this.requireTrusted()) {
      return undefined;
    }

    // `mcpp.task.confirmClean`: one prompt for this entry point; the cleanup
    // plan's own level-2/3 confirmations are untouched by it.
    if (kind === "clean" && cleanConfirmationRequired(read<boolean>("mcpp.task.confirmClean", vscode.Uri.file(project.root)))) {
      const labels = controllerLabels();
      const choice = await vscode.window.showWarningMessage(
        t("Delete the target/ directory of this project: {0}/target", project.root),
        { modal: true, detail: t("This does not clean the global BMI cache.") },
        labels.confirmClean,
      );
      if (choice !== labels.confirmClean) {
        return undefined;
      }
    }

    // `mcpp.runtime.concurrency` picks the mutual-exclusion scope: one task at a
    // time per project (the default), or one task at a time for the whole window.
    const globalScope = read<string>("mcpp.runtime.concurrency") === "global";
    const token: OperationToken = {};
    const active = globalScope
      ? this.operations.beginGlobal(token)
      : this.operations.beginProject(project.root, token);
    if (active !== undefined) {
      const labels = controllerLabels();
      const choice = await vscode.window.showWarningMessage(
        t("An mcpp operation is already running; not starting {0} now.", kind),
        labels.showTasks,
      );
      if (choice === labels.showTasks) {
        await vscode.commands.executeCommand("workbench.action.tasks.showTasks");
      }
      return undefined;
    }

    let completion: TaskCompletion | undefined;
    try {
      const plan = projectTaskPlan(kind, read<string[]>(TASK_ARGUMENT_SETTINGS[kind]));
      completion = await this.executeTask(
        project.root,
        this.mcppExecutable(project),
        plan.title,
        plan.args,
      );
      this.appendTaskCompletion(project.root, plan.title, plan.args, completion);
    } finally {
      if (globalScope) {
        this.operations.finishGlobal(token);
      } else {
        this.operations.finishProject(project.root, token);
      }
    }

    if (options.notify !== false
      && completion !== undefined
      && shouldRefreshLanguageServerAfterTask(kind, completion)) {
      await this.options.afterProjectTask(project, kind, completion);
    }
    return completion;
  }

  public async showToolchains(): Promise<void> {
    if (!this.requireTrusted()) {
      return;
    }
    const project = this.options.currentProject();
    const inventory = await this.readToolchainInventory(project);
    if (inventory === undefined) {
      return;
    }

    const items = this.inventoryItems(inventory, false, project);
    if (items.length === 0) {
      await vscode.window.showInformationMessage(
        t("mcpp listed no usable toolchain; see the raw result in the mcpp output channel."),
      );
      return;
    }
    await vscode.window.showQuickPick(items, {
      title: t("mcpp toolchains and targets"),
      placeHolder: t("Read-only view of what mcpp currently resolves"),
      matchOnDescription: true,
      matchOnDetail: true,
    });
  }

  public async installToolchain(): Promise<void> {
    if (!this.requireTrusted()) {
      return;
    }
    const project = this.options.currentProject();
    const inventory = await this.readToolchainInventory(project);
    const spec = await this.pickInstallSpec(inventory);
    if (spec === undefined) {
      return;
    }
    const installKind = toolchainInstallKind(spec);
    const targetHint = toolchainSpecTargetHint(spec);
    const labels = controllerLabels();
    const confirmLabel = installKind === "system-detect" ? labels.confirmDetect : labels.confirmInstall;
    const confirmation = installKind === "system-detect"
      ? t("mcpp will detect the system MSVC ({0}).", spec)
      : targetHint === "target"
        ? t("The compatible spec {0}, which may carry target semantics, is handed to mcpp to install, and mcpp validates it in the end.", spec)
        : installKind === "managed-target"
          ? t("The compatible spec {0} carrying target semantics is handed to mcpp to install.", spec)
          : t("mcpp toolchain {0} is installed (no target specified, the host target is used).", spec);
    const detail = installKind === "system-detect"
      ? t("mcpp does not download or install MSVC; it detects Visual Studio and points to the official installation guide when it is missing.")
      : targetHint === "target"
        ? t("mcpp decides whether the compiler prefix is a valid triple; when it is, it may download a larger toolchain package for that target.")
        : installKind === "managed-target"
          ? t("mcpp normalises the compatible spelling and may download a larger toolchain package for that target.")
          : t("The installation may download a large toolchain package and modifies the mcpp global cache.");

    const policy = confirmationPolicy(read<boolean>("mcpp.ui.confirmDestructiveOnly"));
    const choice = await vscode.window.showWarningMessage(
      confirmation,
      this.warningOptions(policy.installToolchain, detail),
      confirmLabel,
    );
    if (choice !== confirmLabel) {
      return;
    }

    const token: OperationToken = {};
    const active = this.operations.beginGlobal(token);
    if (active !== undefined) {
      const duplicateChoice = await vscode.window.showWarningMessage(
        t("An mcpp operation is already running."),
        labels.showTasks,
      );
      if (duplicateChoice === labels.showTasks) {
        await vscode.commands.executeCommand("workbench.action.tasks.showTasks");
      }
      return;
    }

    const taskTitle = installKind === "system-detect"
      ? t("mcpp: detect system MSVC ({0})", spec)
      : t("mcpp: install toolchain {0}", spec);
    try {
      const installArgs = mcppCommandArguments("toolchain", "install", spec);
      const completion = await this.executeTask(
        workingDirectory(project),
        this.mcppExecutable(project),
        taskTitle,
        installArgs,
      );
      this.appendTaskCompletion(
        workingDirectory(project),
        taskTitle,
        installArgs,
        completion,
      );
      if (completion.state !== "succeeded") {
        return;
      }
    } finally {
      this.operations.finishGlobal(token);
    }

    if (installKind === "managed-target") {
      this.reportSuccess(t("mcpp finished {0}. This first release does not change the target default; to set one, use the mcpp CLI with --target.", spec));
      return;
    }

    const refreshed = await this.readToolchainInventory(project);
    const defaultChoice = await vscode.window.showInformationMessage(
      installKind === "system-detect"
        ? t("MSVC detection finished. Choose a global default from the latest list?")
        : t("Toolchain {0} installed. Choose a global default from the latest list?", spec),
      labels.chooseGlobalDefault,
    );
    if (defaultChoice === labels.chooseGlobalDefault && refreshed !== undefined) {
      await this.selectDefaultToolchainFromInventory(project, refreshed);
    }
  }

  public async selectDefaultToolchain(): Promise<void> {
    if (!this.requireTrusted()) {
      return;
    }
    const project = this.options.currentProject();
    const inventory = await this.readToolchainInventory(project);
    if (inventory !== undefined) {
      await this.selectDefaultToolchainFromInventory(project, inventory);
    }
  }

  private async selectDefaultToolchainFromInventory(
    project: McppProjectDiscovery | undefined,
    inventory: ToolchainInventory,
  ): Promise<void> {
    const installed = hostDefaultToolchains(inventory);
    if (installed.length === 0) {
      await vscode.window.showWarningMessage(
        t("No installed toolchain is usable for the host target, so a global default cannot be set here. For target-specific toolchains use the mcpp CLI; on Windows install Visual Studio first."),
      );
      return;
    }

    const items: ToolchainPickItem[] = installed.map((toolchain) => ({
      label: `${toolchain.effective ? "$(check) " : ""}${toolchain.spec}`,
      description: toolchain.source === "system" ? t("System toolchain (mcpp only detects it)") : t("Toolchain managed by mcpp"),
      detail: toolchain.effective ? t("Effective toolchain of this project") : undefined,
      spec: toolchain.spec,
      toolchain,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: t("Choose the mcpp global default toolchain"),
      placeHolder: this.isNestedWorkspaceProject(project)
        ? t("The project root sits below the VS Code folder; the real build resolution is whatever mcpp reports")
        : inventory.projectOverridesGlobal
          ? t("The project currently overrides the global default; this only changes the current mcpp global configuration")
          : t("Choosing here only changes the mcpp global configuration; it does not build the project"),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked?.spec === undefined) {
      return;
    }

    const defaultPolicy = confirmationPolicy(read<boolean>("mcpp.ui.confirmDestructiveOnly"));
    const warningLabels = controllerLabels();
    const choice = await vscode.window.showWarningMessage(
      t("The global default pair is set to {0} + host target. The mcpp.toml/target configuration of the current project can still override it.", picked.spec),
      this.warningOptions(
        defaultPolicy.globalDefault,
        t("mcpp also clears the global default_target; the configuration file location is decided by the current mcpp installation and MCPP_HOME."),
      ),
      warningLabels.confirmDefault,
    );
    if (choice !== warningLabels.confirmDefault) {
      return;
    }

    const token: OperationToken = {};
    const active = this.operations.beginGlobal(token);
    if (active !== undefined) {
      await vscode.window.showWarningMessage(t("An mcpp operation is already running."), warningLabels.showTasks);
      return;
    }

    try {
      const args = mcppCommandArguments("toolchain", "default", picked.spec);
      const result = await runProcess(
        this.mcppExecutable(project),
        args,
        workingDirectory(project),
      );
      this.appendShortCommand(t("Set the global default toolchain"), this.mcppExecutable(project), args, result);
      if (result.exitCode !== 0) {
        this.reportCommandFailure(
          args,
          result.exitCode,
          `${result.stdout}\n${result.stderr}`,
          t("Setting the global default toolchain failed (exit code {0}). See the mcpp output channel.", result.exitCode),
        );
        return;
      }

    } finally {
      this.operations.finishGlobal(token);
    }

    const buildChoice = await vscode.window.showInformationMessage(
      t("The mcpp global default is now {0} + host target. Cleaning the old toolchain artifacts and rebuilding is recommended.", picked.spec),
      ...(project === undefined ? [] : [warningLabels.cleanAndBuild]),
    );
    if (buildChoice === warningLabels.cleanAndBuild && project !== undefined) {
      const cleanArgs = mcppCommandArguments("clean");
      const cleanResult = await runProcess(this.mcppExecutable(project), cleanArgs, project.root);
      this.appendShortCommand(t("Clean old artifacts"), this.mcppExecutable(project), cleanArgs, cleanResult);
      await this.runProjectTask("build");
    }
  }

  private async pickInstallSpec(inventory: ToolchainInventory | undefined): Promise<string | undefined> {
    const labels = controllerLabels();
    const items: ToolchainPickItem[] = [];
    for (const toolchain of inventory?.available ?? []) {
      items.push({
        label: toolchain.spec,
        description: t("Versions mcpp aggregates by family; this operation installs for the host target"),
        spec: toolchain.spec,
      });
    }
    items.push({
      label: labels.installCustom,
      detail: t("Accepts family, family@version, namespace, partial versions and mcpp's compatible legacy spellings"),
      customInput: true,
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: t("Install an mcpp toolchain"),
      placeHolder: t("No target is selected; for a target-specific install use the mcpp CLI"),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked === undefined) {
      return undefined;
    }
    if (!picked.customInput) {
      return picked.spec;
    }

    const input = await vscode.window.showInputBox({
      title: t("Enter a toolchain spec"),
      prompt: t("For example gcc, llvm@20.1.7, xim:gcc@16, msvc, mingw; mcpp normalises compatible spellings"),
      placeHolder: "gcc@16",
      validateInput: (value) => {
        const normalized = normalizeToolchainSpec(value);
        if (normalized === undefined) {
          return t("Enter a family, family@version, family version, namespace or an mcpp-compatible spec");
        }
        return undefined;
      },
    });
    return input === undefined ? undefined : normalizeToolchainSpec(input);
  }

  private inventoryItems(
    inventory: ToolchainInventory,
    includeActions: boolean,
    project: McppProjectDiscovery | undefined,
  ): ToolchainPickItem[] {
    const items: ToolchainPickItem[] = [];
    const nestedView = this.isNestedWorkspaceProject(project);
    if (inventory.effective !== undefined) {
      items.push({
        label: `$(check) ${nestedView ? t("mcpp list toolchain for this directory") : t("Current effective toolchain")}: ${inventory.effective.spec}`,
        description: nestedView
          ? t("This is the current-directory view; the value mcpp build resolves is authoritative")
          : inventory.projectOverridesGlobal ? t("From this project's mcpp.toml, overriding the global default") : t("From the global default"),
        detail: inventory.effectiveTarget === undefined
          ? t("Effective target: host (mcpp shows no explicit target)")
          : t("Effective target: {0}", inventory.effectiveTarget),
      });
    }
    if (inventory.globalDefaultSpec !== undefined) {
      items.push({
        label: t("Global default: {0}", inventory.globalDefaultSpec),
        description: nestedView
          ? t("This is the current-directory view; overrides from the project or a parent configuration are decided by the actual build")
          : inventory.projectOverridesGlobal ? t("This project may not be using this value") : t("mcpp global configuration"),
      });
    } else if (inventory.recognized) {
      items.push({
        label: t("Global default: <none>"),
        description: t("mcpp has no global default toolchain yet"),
      });
    }
    for (const toolchain of inventory.installed) {
      items.push({
        label: `${toolchain.effective ? "$(check) " : ""}${toolchain.spec}`,
        description: toolchain.source === "system" ? t("System: system toolchain, detection only") : t("Installed"),
        detail: toolchain.effective
          ? nestedView ? t("mcpp list item effective for this directory; the actual build resolution may be affected by a parent mcpp workspace") : t("Currently effective item")
          : undefined,
        spec: toolchain.spec,
        toolchain,
      });
    }
    for (const target of inventory.targets) {
      items.push({
        label: `${target.effective ? "$(check) " : ""}target ${target.target}`,
        description: `${target.status}${target.toolchainSpec === undefined ? "" : ` · ${t("convention {0}", target.toolchainSpec)}`}`,
        detail: target.note.length === 0 ? t("The target axis is shown read-only; to select a target use the mcpp CLI") : target.note,
      });
    }
    for (const toolchain of inventory.available) {
      items.push({
        label: t("Installable: {0}", toolchain.spec),
        description: t("Index versions mcpp aggregates by family; no host payload is promised"),
        spec: toolchain.spec,
      });
    }
    if (includeActions) {
      items.push({
        label: t("$(cloud-download) Install a toolchain…"),
        detail: t("Back to the toolchain installation flow"),
        customInput: true,
      });
    }
    return items;
  }

  private async showMenu(): Promise<void> {
    const groupLabel = new Map(QUICK_MENU_GROUPS.map((group) => [group.id, t(group.labelKey)]));
    const showLanguageServer = read<boolean>("mcpp.languageService.menuItems");
    const items = quickMenuItems
      .filter((item) => showLanguageServer || item.group !== "languageServer")
      .map((item) => ({
      label: t(item.labelKey),
      description: groupLabel.get(item.group) ?? item.group,
      command: item.command,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: t("mcpp: quick menu"),
      placeHolder: t("Choose a project, toolchain, cache or C++ Modules action"),
      matchOnDescription: true,
    });
    if (picked !== undefined) {
      await vscode.commands.executeCommand(picked.command);
    }
  }

  public async newProject(): Promise<void> {
    if (!this.requireTrusted()) {
      return;
    }

    const input = await vscode.window.showInputBox({
      title: t("New mcpp project (1/2)"),
      prompt: t("Enter a project name; a folder of that name is created at the location you pick"),
      placeHolder: "hello-mcpp",
      validateInput: validateNewProjectName,
    });
    if (input === undefined) {
      return;
    }
    const projectName = input.trim();

    const picked = await vscode.window.showOpenDialog({
      title: t("Choose the project location (2/2)"),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: t("Create the project here"),
    });
    const location = picked?.[0];
    if (location === undefined) {
      return;
    }

    const projectRoot = join(location.fsPath, projectName);
    // Shown *and* compared: one definition keeps the two in step.
    const confirmCreate = t("Create and open");
    await runNewProjectFlow(projectName, location.fsPath, projectRoot, {
      exists: existsSync,
      confirm: async (message) =>
        (await vscode.window.showWarningMessage(message, { modal: true }, confirmCreate))
        === confirmCreate,
      run: async (name, cwd) => {
        const executable = this.mcppExecutable(undefined);
        const args = mcppCommandArguments("new", name);
        const result = await runProcess(executable, args, cwd);
        this.appendShortCommand(t("New project"), executable, args, result);
        return result.exitCode;
      },
      openFolder: async (path) => {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path));
      },
      showError: async (message) => {
        await vscode.window.showErrorMessage(message);
      },
    });
  }

  private guarded<T>(operation: () => Promise<T>): () => Promise<void> {
    return async () => {
      try {
        await operation();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(t("mcpp CLI operation failed: {0}", message));
        await vscode.window.showErrorMessage(t("mcpp: {0}", message));
      }
    };
  }

  private requireProject(): McppProjectDiscovery | undefined {
    const project = this.options.currentProject();
    if (project === undefined) {
      void vscode.window.showWarningMessage(t("No mcpp.toml was found in this workspace. Run this command inside an mcpp project."));
    }
    return project;
  }

  private requireTrusted(): boolean {
    if (this.options.isTrusted()) {
      return true;
    }
    void vscode.window.showWarningMessage(
      t("This workspace is not trusted. mcpp commands may run external programs named by workspace settings; trust the workspace first."),
    );
    return false;
  }

  public mcppExecutable(project: McppProjectDiscovery | undefined): string {
    const uri = project === undefined
      ? vscode.workspace.workspaceFolders?.[0]?.uri
      : vscode.Uri.file(project.root);
    const configured = vscode.workspace.getConfiguration("mcpp", uri).get<string>("path", "").trim();
    return configured.length === 0 ? "mcpp" : configured;
  }

  private isNestedWorkspaceProject(project: McppProjectDiscovery | undefined): boolean {
    if (project === undefined) {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root));
    return folder !== undefined && folder.uri.fsPath !== project.root;
  }

  public async readToolchainInventory(
    project: McppProjectDiscovery | undefined = this.options.currentProject(),
  ): Promise<ToolchainInventory | undefined> {
    const executable = this.mcppExecutable(project);
    const args = mcppCommandArguments("toolchain", "list");
    const result = await runProcess(executable, args, workingDirectory(project));
    this.appendShortCommand(t("Inspect the toolchain"), executable, args, result);
    if (result.exitCode !== 0) {
      this.reportCommandFailure(
        args,
        result.exitCode,
        `${result.stdout}\n${result.stderr}`,
        t("mcpp toolchain list failed (exit code {0}). See the mcpp output channel.", result.exitCode),
      );
      return undefined;
    }

    const inventory = parseToolchainList(`${result.stdout}${result.stderr.length > 0 ? `\n${result.stderr}` : ""}`);
    if (!inventory.recognized) {
      await vscode.window.showErrorMessage(
        t("The current mcpp toolchain list output is not recognised; the raw output is kept in the mcpp output channel, so check the mcpp version."),
      );
      return undefined;
    }
    return inventory;
  }

  private async executeTask(
    root: string,
    executable: string,
    title: string,
    args: string[],
  ): Promise<TaskCompletion> {
    // `mcpp.task.revealTerminal` / `focusTerminal` / `clearTerminal` and
    // `mcpp.task.problemMatcher` are read here, where the task object is
    // assembled; the completion path re-reads them for the failure-only reveal.
    const ui = this.terminalUi(root);
    const task = new vscode.Task(
      { type: "mcpp", command: args[0] ?? "mcpp", projectRoot: root },
      taskScope(root),
      title,
      "mcpp",
      new vscode.ProcessExecution(executable, args, { cwd: root }),
      [...problemMatchersFor(read<boolean>("mcpp.task.problemMatcher", vscode.Uri.file(root)))],
    );
    task.presentationOptions = {
      reveal: ui.reveal === "always"
        ? vscode.TaskRevealKind.Always
        : ui.reveal === "never"
          ? vscode.TaskRevealKind.Never
          : vscode.TaskRevealKind.Silent,
      panel: vscode.TaskPanelKind.Dedicated,
      focus: ui.focus,
      clear: ui.clearBeforeRun,
      showReuseMessage: false,
    };

    let execution: vscode.TaskExecution | undefined;
    let earlyCompletion: TaskCompletion | undefined;
    let settled = false;
    let processEndSubscription: vscode.Disposable | undefined;
    let taskEndSubscription: vscode.Disposable | undefined;
    const disposeListeners = (): void => {
      processEndSubscription?.dispose();
      taskEndSubscription?.dispose();
    };
    const finish = (completion: TaskCompletion): void => {
      if (settled) {
        return;
      }
      settled = true;
      disposeListeners();
      resolveCompletion?.(completion);
    };
    let resolveCompletion: ((completion: TaskCompletion) => void) | undefined;
    const completion = new Promise<TaskCompletion>((resolve) => {
      resolveCompletion = resolve;
      processEndSubscription = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution.task !== task) {
          return;
        }
        const classified = classifyTaskExit(event.exitCode);
        if (execution === undefined) {
          earlyCompletion ??= classified;
          return;
        }
        finish(classified);
      });
      taskEndSubscription = vscode.tasks.onDidEndTask((event) => {
        if (event.execution.task !== task) {
          return;
        }
        const classified = classifyTaskExit(undefined);
        if (execution === undefined) {
          earlyCompletion ??= classified;
          return;
        }
        finish(classified);
      });
    });

    try {
      execution = await vscode.tasks.executeTask(task);
    } catch (error) {
      disposeListeners();
      throw error;
    }
    if (earlyCompletion !== undefined) {
      finish(earlyCompletion);
    }
    return completion;
  }

  private appendTaskCompletion(
    root: string,
    title: string,
    args: string[],
    completion: TaskCompletion,
  ): void {
    const suffix = completion.state === "succeeded"
      ? t("Exit code {0}", completion.exitCode ?? 0)
      : completion.state === "cancelled"
        ? t("Cancelled")
        : t("Failed with exit code {0}", completion.exitCode ?? t("unknown"));
    // `mcpp.log.level` gates the verbose lines; the failed result is an error
    // and is therefore never suppressed.
    this.logger.info(`\n[${new Date().toISOString()}] ${title}`);
    this.logger.debug(t("Working directory: {0}", root));
    this.logger.debug(t("Task arguments: {0}", args.join(" ")));
    const resultLine = t("Result: {0}", suffix);
    if (completion.state === "failed") {
      this.logger.error(resultLine);
    } else if (completion.state === "cancelled") {
      this.logger.warn(resultLine);
    } else {
      this.logger.info(resultLine);
    }

    for (const command of terminalCommandsAfterTask(this.terminalUi(root), completion.state === "failed")) {
      void vscode.commands.executeCommand(command);
    }

    if (completion.state === "failed") {
      this.reportCommandFailure(
        args,
        completion.exitCode ?? 1,
        "",
        t("{0} failed (exit code {1}). See the task terminal.", title, completion.exitCode ?? t("unknown")),
      );
    } else if (completion.state === "cancelled") {
      void vscode.window.showWarningMessage(t("{0} was cancelled.", title));
    } else {
      this.reportSuccess(t("{0} finished.", title));
    }
  }

  /** The task-terminal settings, read together so every site agrees. */
  private terminalUi(root: string): TaskTerminalUi {
    const resource = vscode.Uri.file(root);
    return taskTerminalUi(
      read<string>("mcpp.task.revealTerminal", resource),
      read<boolean>("mcpp.task.focusTerminal", resource),
      read<boolean>("mcpp.task.clearTerminal", resource),
    );
  }

  /**
   * A *successful* result only; failures and cancellations never consult
   * `mcpp.ui.notifications.success`. `mcpp.ui.notifications.dedupeMinutes`
   * suppresses a repeated identical message inside its window.
   */
  private reportSuccess(message: string): void {
    const mode = successReportOf(read<string>("mcpp.ui.notifications.success"));
    if (mode === "silent") {
      return;
    }
    const now = Date.now();
    if (!dedupeAllows(this.lastNotified.get(message), now, read<number>("mcpp.ui.notifications.dedupeMinutes"))) {
      return;
    }
    this.lastNotified.set(message, now);
    if (mode === "toast") {
      void vscode.window.showInformationMessage(message);
      return;
    }
    this.showStatusSuccess(message);
  }

  /** `mcpp.ui.notifications.success = statusBar`: a transient, non-blocking label. */
  private showStatusSuccess(message: string): void {
    if (this.options.currentProject() === undefined || !read<boolean>("mcpp.ui.statusBar.show")) {
      return;
    }
    this.status.text = `$(check) ${statusBarSuccessText(message)}`;
    this.status.show();
    if (this.statusRevert !== undefined) {
      clearTimeout(this.statusRevert);
    }
    this.statusRevert = setTimeout(() => {
      this.statusRevert = undefined;
      try {
        this.applyStatusBar();
      } catch {
        // The status item can already be disposed during a window reload.
      }
    }, SUCCESS_STATUS_MS);
  }

  /**
   * A failed `mcpp` run: the exit-code-specific next step from
   * `src/cli/errors.ts`, the caller's own message as the fallback, and the
   * `mcpp self explain` hint whenever the output names a diagnostic code.
   */
  private reportCommandFailure(
    args: readonly string[],
    exitCode: number,
    output: string,
    fallback: string,
  ): void {
    const advice = failureAdvice(args, exitCode, output);
    const parts: string[] = [failureGuidanceText(advice.kind) ?? fallback];
    if (advice.hint !== undefined) {
      parts.push(t("Explain this code with: {0}", advice.hint));
    }
    void vscode.window.showErrorMessage(parts.join(" "));
  }

  private warningOptions(strength: ConfirmationStrength, detail: string): vscode.MessageOptions {
    return strength === "modal" ? { modal: true, detail } : { detail };
  }

  /**
   * `mcpp.ui.statusBar.show` plus `mcpp.ui.statusBar.showLanguageServer`; the
   * C++ Modules line comes from the host callback, so this controller never
   * imports the mcppls bridge.
   */
  private applyStatusBar(): void {
    if (this.statusRevert !== undefined) {
      clearTimeout(this.statusRevert);
      this.statusRevert = undefined;
    }
    const tooltip = t("Open the mcpp project and toolchain quick menu");
    const languageServer = languageServerStatusSuffix(
      read<boolean>("mcpp.ui.statusBar.showLanguageServer"),
      this.options.languageServerSummary?.(),
    );
    this.status.text = languageServer === undefined
      ? quickMenuStatusText
      : `${quickMenuStatusText} · ${t("C++ Modules: {0}", languageServer)}`;
    this.status.tooltip = languageServer === undefined
      ? tooltip
      : `${tooltip}\n${t("C++ Modules (provided by the mcpp language server extension): {0}", languageServer)}`;
    if (read<boolean>("mcpp.ui.statusBar.show")) {
      this.status.show();
    } else {
      this.status.hide();
    }
  }

  private appendShortCommand(
    title: string,
    executable: string,
    args: string[],
    result: { exitCode: number; stdout: string; stderr: string },
  ): void {
    // The command echo and the output of a successful command are the verbose
    // lines `mcpp.log.level` gates. A failed command's raw stdout/stderr is
    // written at `error`, which no configured level may suppress.
    const failed = result.exitCode !== 0;
    this.logger.info(`\n[${new Date().toISOString()}] ${title}`);
    this.logger.debug(`$ ${commandLine(executable, args)}`);
    if (result.stdout.length > 0) {
      (failed ? this.logger.error : this.logger.info)(result.stdout.trimEnd());
    }
    if (result.stderr.length > 0) {
      (failed ? this.logger.error : this.logger.info)(result.stderr.trimEnd());
    }
    (failed ? this.logger.error : this.logger.info)(`[exit ${result.exitCode}]`);
  }
}
