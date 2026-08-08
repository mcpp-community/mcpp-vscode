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
} from "./cli";
import type { McppProjectDiscovery } from "./discovery";
import { runProcess } from "./process";
import {
  McppOperationRegistry,
  classifyTaskExit,
  projectTaskPlan,
  shouldReconcileAfterTask,
  type ProjectTaskKind,
  type TaskCompletion,
} from "./tasks";
import { CLI_COMMANDS, quickMenuItems, quickMenuStatusText } from "./commands";
import { runNewProjectFlow, validateNewProjectName } from "./newProject";
import {
  mcppModuleSetupCommands,
  type ModuleSetupCommand,
  type ModuleSetupDecision,
  type ModuleSetupStepResult,
} from "./moduleSetup";

export interface McppCliControllerOptions {
  output: vscode.OutputChannel;
  currentProject: () => McppProjectDiscovery | undefined;
  afterProjectTask: (
    project: McppProjectDiscovery,
    kind: ProjectTaskKind,
    completion: TaskCompletion,
  ) => Promise<void>;
  isTrusted: () => boolean;
}

interface ToolchainPickItem extends vscode.QuickPickItem {
  spec?: string;
  toolchain?: ToolchainItem;
  customInput?: boolean;
}

type OperationToken = object;

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

export class McppCliController {
  private readonly status: vscode.StatusBarItem;

  private readonly operations = new McppOperationRegistry<OperationToken>();

  public constructor(private readonly options: McppCliControllerOptions) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
    this.status.command = CLI_COMMANDS.showMenu;
    this.status.text = quickMenuStatusText;
    this.status.tooltip = "打开 mcpp 项目和工具链快捷菜单";
  }

  public register(): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [
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
    this.status.show();
  }

  public isBusy(): boolean {
    return this.operations.hasActive();
  }

  public async runAutomaticModuleSetup(
    plan: Extract<ModuleSetupDecision, { kind: "ready" }>,
  ): Promise<ModuleSetupStepResult> {
    const project = this.requireProject();
    const commands = mcppModuleSetupCommands(plan);
    const firstCommand = commands[0];
    if (project === undefined || !this.requireTrusted() || firstCommand === undefined) {
      return {
        stage: firstCommand?.stage ?? "build",
        state: "failed",
        detail: "当前工作区无法执行自动模块配置。",
      };
    }

    const token: OperationToken = {};
    if (this.operations.beginGlobal(token) !== undefined) {
      return {
        stage: firstCommand.stage,
        state: "failed",
        detail: "已有 mcpp 操作正在运行。",
      };
    }

    const executable = this.mcppExecutable(project);
    try {
      for (const command of commands) {
        const result = await this.executeAutomaticModuleSetupCommand(
          project,
          executable,
          command,
        );
        if (result.state !== "succeeded") {
          return result;
        }
      }
      return { stage: "build", state: "succeeded" };
    } finally {
      // 整个 install/default/build 事务共用一个 token，异常时也必须释放。
      this.operations.finishGlobal(token);
    }
  }

  public async runProjectTask(kind: ProjectTaskKind): Promise<void> {
    const project = this.requireProject();
    if (project === undefined || !this.requireTrusted()) {
      return;
    }

    if (kind === "clean") {
      const choice = await vscode.window.showWarningMessage(
        `将删除当前工程的 target 目录：${project.root}/target`,
        { modal: true, detail: "此操作不会清理全局 BMI 缓存。" },
        CONFIRM_CLEAN,
      );
      if (choice !== CONFIRM_CLEAN) {
        return;
      }
    }

    const token: OperationToken = {};
    const active = this.operations.beginProject(project.root, token);
    if (active !== undefined) {
      const choice = await vscode.window.showWarningMessage(
        `已有 mcpp 操作正在运行，暂不启动 ${kind}。`,
        SHOW_TASKS,
      );
      if (choice === SHOW_TASKS) {
        await vscode.commands.executeCommand("workbench.action.tasks.showTasks");
      }
      return;
    }

    let completion: TaskCompletion | undefined;
    try {
      const plan = projectTaskPlan(kind);
      completion = await this.executeTask(
        project.root,
        this.mcppExecutable(project),
        plan.title,
        plan.args,
      );
      this.appendTaskCompletion(project.root, plan.title, plan.args, completion);
    } finally {
      this.operations.finishProject(project.root, token);
    }

    if (completion !== undefined && shouldReconcileAfterTask(kind, completion)) {
      await this.options.afterProjectTask(project, kind, completion);
    }
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

    const choice = await vscode.window.showWarningMessage(
      confirmation,
      { modal: true, detail },
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
      await vscode.window.showInformationMessage(
        `mcpp 已完成 ${spec}。首版插件不修改 target 默认；如需设为默认，请使用带 --target 的 mcpp CLI。`,
      );
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

    const choice = await vscode.window.showWarningMessage(
      `将把全局默认对设为 ${picked.spec} + host target。当前项目的 mcpp.toml/target 配置仍可能覆盖它。`,
      { modal: true, detail: "mcpp 会同时清空全局 default_target；配置文件位置由当前 mcpp 安装及 MCPP_HOME 决定。" },
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
        await vscode.window.showErrorMessage(
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
    const items = quickMenuItems.map((item) => ({
      label: item.label,
      description: item.group === "project"
        ? "当前 mcpp 工程"
        : item.group === "toolchain" ? "mcpp 工具链管理" : "clangd 与编译数据库",
      command: item.command,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: "mcpp 快捷菜单",
      placeHolder: "选择项目、工具链或 IDE 操作",
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

  private guarded(operation: () => Promise<void>): () => Promise<void> {
    return async () => {
      try {
        await operation();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          this.options.output.appendLine(`mcpp CLI 操作失败：${message}`);
        } catch {
          // 输出频道可能已经在窗口重载时释放。
        }
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
      await vscode.window.showErrorMessage(
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

  private async executeAutomaticModuleSetupCommand(
    project: McppProjectDiscovery,
    executable: string,
    command: ModuleSetupCommand,
  ): Promise<ModuleSetupStepResult> {
    if (command.mode === "process") {
      const result = await runProcess(executable, command.args, project.root);
      this.appendShortCommand(`自动模块配置：${command.stage}`, executable, command.args, result);
      return {
        stage: command.stage,
        state: result.exitCode === 0 ? "succeeded" : "failed",
        exitCode: result.exitCode,
      };
    }

    // build 直接复用任务执行器，避免在 global token 内再次申请 project token。
    let completion: TaskCompletion;
    try {
      completion = await this.executeTask(
        project.root,
        executable,
        "mcpp: 自动模块配置构建",
        command.args,
      );
    } catch (error) {
      return {
        stage: command.stage,
        state: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    this.appendTaskCompletion(
      project.root,
      "mcpp: 自动模块配置构建",
      command.args,
      completion,
    );
    return {
      stage: command.stage,
      state: completion.state,
      exitCode: completion.exitCode,
    };
  }

  private async executeTask(
    root: string,
    executable: string,
    title: string,
    args: string[],
  ): Promise<TaskCompletion> {
    const task = new vscode.Task(
      { type: "mcpp", command: args[0] ?? "mcpp", projectRoot: root },
      taskScope(root),
      title,
      "mcpp",
      new vscode.ProcessExecution(executable, args, { cwd: root }),
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      focus: true,
      clear: true,
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
    try {
      this.options.output.appendLine(`\n[${new Date().toISOString()}] ${title}`);
      this.options.output.appendLine(`工作目录：${root}`);
      this.options.output.appendLine(`任务参数：${args.join(" ")}`);
      this.options.output.appendLine(`结果：${suffix}`);
    } catch {
      // 窗口重载时输出频道可能早于任务事件被释放。
    }
    if (completion.state === "failed") {
      void vscode.window.showErrorMessage(`${title}失败（退出码 ${completion.exitCode ?? "未知"}）。请查看任务终端。`);
    } else if (completion.state === "cancelled") {
      void vscode.window.showWarningMessage(`${title}已取消。`);
    }
  }

  private appendShortCommand(
    title: string,
    executable: string,
    args: string[],
    result: { exitCode: number; stdout: string; stderr: string },
  ): void {
    try {
      this.options.output.appendLine(`\n[${new Date().toISOString()}] ${title}`);
      this.options.output.appendLine(`$ ${commandLine(executable, args)}`);
      if (result.stdout.length > 0) {
        this.options.output.appendLine(result.stdout.trimEnd());
      }
      if (result.stderr.length > 0) {
        this.options.output.appendLine(result.stderr.trimEnd());
      }
      this.options.output.appendLine(`[exit ${result.exitCode}]`);
    } catch {
      // 窗口重载时输出频道可能早于短命令结束被释放。
    }
  }
}
