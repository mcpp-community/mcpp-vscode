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

const INSTALL_CUSTOM_LABEL = "$(edit) 输入其他兼容工具链 spec…";
const CONFIRM_INSTALL = "安装";
const CONFIRM_DETECT = "检测";
const CONFIRM_DEFAULT = "设为全局默认";
const CONFIRM_CLEAN = "清理 target";
const SHOW_TASKS = "显示正在运行的任务";

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
      const choice = await vscode.window.showWarningMessage(
        `将删除当前工程的 target 目录：${project.root}/target`,
        { modal: true, detail: "此操作不会清理全局 BMI 缓存。" },
        CONFIRM_CLEAN,
      );
      if (choice !== CONFIRM_CLEAN) {
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
      const choice = await vscode.window.showWarningMessage(
        `已有 mcpp 操作正在运行，暂不启动 ${kind}。`,
        SHOW_TASKS,
      );
      if (choice === SHOW_TASKS) {
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
        "mcpp 没有列出可用工具链；请查看 mcpp 输出频道中的原始结果。",
      );
      return;
    }
    await vscode.window.showQuickPick(items, {
      title: "mcpp 工具链与 target",
      placeHolder: "只读查看 mcpp 当前解析结果",
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
    const confirmLabel = installKind === "system-detect" ? CONFIRM_DETECT : CONFIRM_INSTALL;
    const confirmation = installKind === "system-detect"
      ? `将调用 mcpp 检测系统 MSVC（${spec}）。`
      : targetHint === "target"
        ? `将把可能携带 target 语义的兼容 spec ${spec} 交给 mcpp 安装，最终由 mcpp 校验。`
        : installKind === "managed-target"
          ? `将把携带 target 语义的兼容 spec ${spec} 交给 mcpp 安装。`
          : `将安装 mcpp 工具链 ${spec}（不指定 target，使用 host target）。`;
    const detail = installKind === "system-detect"
      ? "mcpp 不会下载或安装 MSVC；它会检测 Visual Studio，并在缺失时给出官方安装指引。"
      : targetHint === "target"
        ? "mcpp 会判断编译器前缀是否为有效 triple；有效时可能下载对应 target 的较大工具链包。"
        : installKind === "managed-target"
          ? "mcpp 会规范化兼容写法，并可能下载对应 target 的较大工具链包。"
          : "安装可能下载较大的工具链包，并修改 mcpp 全局缓存。";

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
        "已有 mcpp 操作正在运行。",
        SHOW_TASKS,
      );
      if (duplicateChoice === SHOW_TASKS) {
        await vscode.commands.executeCommand("workbench.action.tasks.showTasks");
      }
      return;
    }

    const taskTitle = installKind === "system-detect"
      ? `mcpp: 检测系统 MSVC（${spec}）`
      : `mcpp: 安装工具链 ${spec}`;
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
      this.reportSuccess(`mcpp 已完成 ${spec}。首版插件不修改 target 默认；如需设为默认，请使用带 --target 的 mcpp CLI。`);
      return;
    }

    const refreshed = await this.readToolchainInventory(project);
    const defaultChoice = await vscode.window.showInformationMessage(
      installKind === "system-detect"
        ? "MSVC 检测完成。是否从最新列表中选择全局默认？"
        : `工具链 ${spec} 安装完成。是否从最新列表中选择全局默认？`,
      "选择全局默认",
    );
    if (defaultChoice === "选择全局默认" && refreshed !== undefined) {
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
        "没有可用于 host target 的已安装工具链，不能在此处设置全局默认。target 专用工具链请使用 mcpp CLI；Windows MSVC 请先安装 Visual Studio。",
      );
      return;
    }

    const items: ToolchainPickItem[] = installed.map((toolchain) => ({
      label: `${toolchain.effective ? "$(check) " : ""}${toolchain.spec}`,
      description: toolchain.source === "system" ? "系统工具链（mcpp 只检测）" : "mcpp 管理的工具链",
      detail: toolchain.effective ? "当前工程有效工具链" : undefined,
      spec: toolchain.spec,
      toolchain,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: "选择 mcpp 全局默认工具链",
      placeHolder: this.isNestedWorkspaceProject(project)
        ? "当前工程根位于 VS Code 文件夹子目录；实际构建解析以 mcpp 为准"
        : inventory.projectOverridesGlobal
          ? "项目当前覆盖全局默认；这里只修改 mcpp 当前全局配置"
          : "选择后只修改 mcpp 全局配置，不会自动构建工程",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked?.spec === undefined) {
      return;
    }

    const defaultPolicy = confirmationPolicy(read<boolean>("mcpp.ui.confirmDestructiveOnly"));
    const choice = await vscode.window.showWarningMessage(
      `将把全局默认对设为 ${picked.spec} + host target。当前项目的 mcpp.toml/target 配置仍可能覆盖它。`,
      this.warningOptions(
        defaultPolicy.globalDefault,
        "mcpp 会同时清空全局 default_target；配置文件位置由当前 mcpp 安装及 MCPP_HOME 决定。",
      ),
      CONFIRM_DEFAULT,
    );
    if (choice !== CONFIRM_DEFAULT) {
      return;
    }

    const token: OperationToken = {};
    const active = this.operations.beginGlobal(token);
    if (active !== undefined) {
      await vscode.window.showWarningMessage("已有 mcpp 操作正在运行。", SHOW_TASKS);
      return;
    }

    try {
      const args = mcppCommandArguments("toolchain", "default", picked.spec);
      const result = await runProcess(
        this.mcppExecutable(project),
        args,
        workingDirectory(project),
      );
      this.appendShortCommand("设置全局默认工具链", this.mcppExecutable(project), args, result);
      if (result.exitCode !== 0) {
        this.reportCommandFailure(
          args,
          result.exitCode,
          `${result.stdout}\n${result.stderr}`,
          `设置全局默认工具链失败（退出码 ${result.exitCode}）。请查看 mcpp 输出频道。`,
        );
        return;
      }

    } finally {
      this.operations.finishGlobal(token);
    }

    const buildChoice = await vscode.window.showInformationMessage(
      `mcpp 全局默认已更新为 ${picked.spec} + host target。建议清理旧工具链产物后重新构建。`,
      ...(project === undefined ? [] : ["清理并构建"]),
    );
    if (buildChoice === "清理并构建" && project !== undefined) {
      const cleanArgs = mcppCommandArguments("clean");
      const cleanResult = await runProcess(this.mcppExecutable(project), cleanArgs, project.root);
      this.appendShortCommand("清理旧产物", this.mcppExecutable(project), cleanArgs, cleanResult);
      await this.runProjectTask("build");
    }
  }

  private async pickInstallSpec(inventory: ToolchainInventory | undefined): Promise<string | undefined> {
    const items: ToolchainPickItem[] = [];
    for (const toolchain of inventory?.available ?? []) {
      items.push({
        label: toolchain.spec,
        description: "mcpp 按 family 聚合的可用版本；本操作按 host target 安装",
        spec: toolchain.spec,
      });
    }
    items.push({
      label: INSTALL_CUSTOM_LABEL,
      detail: "支持 family、family@version、namespace、部分版本和 mcpp 兼容旧拼写",
      customInput: true,
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: "安装 mcpp 工具链",
      placeHolder: "不选择 target；target 专用安装请使用 mcpp CLI",
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
      title: "输入工具链 spec",
      prompt: "例如 gcc、llvm@20.1.7、xim:gcc@16、msvc、mingw；兼容写法由 mcpp 规范化",
      placeHolder: "gcc@16",
      validateInput: (value) => {
        const normalized = normalizeToolchainSpec(value);
        if (normalized === undefined) {
          return "请输入 family、family@version、family version、namespace 或 mcpp 兼容 spec";
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
        label: `$(check) ${nestedView ? "mcpp list 当前目录工具链" : "当前有效工具链"}：${inventory.effective.spec}`,
        description: nestedView
          ? "当前目录视图；实际生效值以 mcpp build 解析为准"
          : inventory.projectOverridesGlobal ? "来自当前项目 mcpp.toml，覆盖全局默认" : "来自全局默认",
        detail: inventory.effectiveTarget === undefined
          ? "有效 target：host（mcpp 未显示显式 target）"
          : `有效 target：${inventory.effectiveTarget}`,
      });
    }
    if (inventory.globalDefaultSpec !== undefined) {
      items.push({
        label: `全局默认：${inventory.globalDefaultSpec}`,
        description: nestedView
          ? "当前目录视图；项目或父级配置的覆盖以实际构建为准"
          : inventory.projectOverridesGlobal ? "当前项目可能没有使用此值" : "mcpp 全局配置",
      });
    } else if (inventory.recognized) {
      items.push({
        label: "全局默认：<none>",
        description: "mcpp 尚未设置全局默认工具链",
      });
    }
    for (const toolchain of inventory.installed) {
      items.push({
        label: `${toolchain.effective ? "$(check) " : ""}${toolchain.spec}`,
        description: toolchain.source === "system" ? "System：系统工具链，仅检测" : "已安装",
        detail: toolchain.effective
          ? nestedView ? "mcpp list 当前目录有效项；实际构建解析可能受父级 mcpp 工作区影响" : "当前有效项"
          : undefined,
        spec: toolchain.spec,
        toolchain,
      });
    }
    for (const target of inventory.targets) {
      items.push({
        label: `${target.effective ? "$(check) " : ""}target ${target.target}`,
        description: `${target.status}${target.toolchainSpec === undefined ? "" : ` · 约定 ${target.toolchainSpec}`}`,
        detail: target.note.length === 0 ? "target 轴只读展示；选择 target 请使用 mcpp CLI" : target.note,
      });
    }
    for (const toolchain of inventory.available) {
      items.push({
        label: `可安装：${toolchain.spec}`,
        description: "mcpp 按 family 聚合的索引版本；未承诺 host payload",
        spec: toolchain.spec,
      });
    }
    if (includeActions) {
      items.push({
        label: "$(cloud-download) 安装工具链…",
        detail: "回到工具链安装流程",
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
      title: "新建 mcpp 工程（1/2）",
      prompt: "输入项目名，将在所选位置创建同名项目文件夹",
      placeHolder: "hello-mcpp",
      validateInput: validateNewProjectName,
    });
    if (input === undefined) {
      return;
    }
    const projectName = input.trim();

    const picked = await vscode.window.showOpenDialog({
      title: "选择项目位置（2/2）",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "在此创建项目",
    });
    const location = picked?.[0];
    if (location === undefined) {
      return;
    }

    const projectRoot = join(location.fsPath, projectName);
    const confirmCreate = "创建并打开";
    await runNewProjectFlow(projectName, location.fsPath, projectRoot, {
      exists: existsSync,
      confirm: async (message) =>
        (await vscode.window.showWarningMessage(message, { modal: true }, confirmCreate))
        === confirmCreate,
      run: async (name, cwd) => {
        const executable = this.mcppExecutable(undefined);
        const args = mcppCommandArguments("new", name);
        const result = await runProcess(executable, args, cwd);
        this.appendShortCommand("新建工程", executable, args, result);
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
        this.logger.error(`mcpp CLI 操作失败：${message}`);
        await vscode.window.showErrorMessage(`mcpp：${message}`);
      }
    };
  }

  private requireProject(): McppProjectDiscovery | undefined {
    const project = this.options.currentProject();
    if (project === undefined) {
      void vscode.window.showWarningMessage("当前工作区没有找到 mcpp.toml。请在 mcpp 工程中执行此命令。");
    }
    return project;
  }

  private requireTrusted(): boolean {
    if (this.options.isTrusted()) {
      return true;
    }
    void vscode.window.showWarningMessage(
      "当前工作区未受信任。mcpp 命令可能执行工作区设置指定的外部程序，请先信任工作区。",
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
    this.appendShortCommand("查看工具链", executable, args, result);
    if (result.exitCode !== 0) {
      this.reportCommandFailure(
        args,
        result.exitCode,
        `${result.stdout}\n${result.stderr}`,
        `mcpp toolchain list 失败（退出码 ${result.exitCode}）。请查看 mcpp 输出频道。`,
      );
      return undefined;
    }

    const inventory = parseToolchainList(`${result.stdout}${result.stderr.length > 0 ? `\n${result.stderr}` : ""}`);
    if (!inventory.recognized) {
      await vscode.window.showErrorMessage(
        "无法识别当前 mcpp toolchain list 输出；原始输出已保留在 mcpp 输出频道，请检查 mcpp 版本。",
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
      ? `退出码 ${completion.exitCode ?? 0}`
      : completion.state === "cancelled"
        ? "已取消"
        : `失败，退出码 ${completion.exitCode ?? "未知"}`;
    // `mcpp.log.level` gates the verbose lines; the failed result is an error
    // and is therefore never suppressed.
    this.logger.info(`\n[${new Date().toISOString()}] ${title}`);
    this.logger.debug(`工作目录：${root}`);
    this.logger.debug(`任务参数：${args.join(" ")}`);
    const resultLine = `结果：${suffix}`;
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
        `${title}失败（退出码 ${completion.exitCode ?? "未知"}）。请查看任务终端。`,
      );
    } else if (completion.state === "cancelled") {
      void vscode.window.showWarningMessage(`${title}已取消。`);
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
