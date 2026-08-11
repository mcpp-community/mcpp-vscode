import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

import * as vscode from "vscode";

import {
  analyzeCompilationDatabase,
  buildClangdArguments,
  buildClangdConfigurationPlan,
  compareToolIdentities,
  type CheckResult,
  type CompilationDatabaseAnalysis,
  type ModulesSupportMode,
  type ToolIdentityComparison,
} from "./analysis";
import {
  deriveClangdCandidates,
  findNearestMcppProject,
  isPathWithinProject,
  manifestProjectRoot,
  projectAffectedByManifest,
  shouldReconcileDeletedManifest,
  type McppProjectDiscovery,
} from "./discovery";
import {
  resolveXlingsExecutable,
  llvmToolsVersionSpec,
  xlingsInstallArgs,
} from "./llvmTools";
import { CLI_COMMANDS } from "./commands";
import { McppCliController } from "./cliController";
import { runClangdCheck, runToolVersion, type ProcessResult, type ToolVersionResult } from "./process";
import { ensureIdeConfigured } from "./ideWorkflow";
import {
  configurationReadyAfterRestart,
  configurationAffectsMcppExecution,
  configurationAffectsModuleSupport,
  createKeyedSingleFlightReconciler,
  createLatestOperationTracker,
  createSerialExecutor,
  describeConfigureOnlyOutcome,
  describeRefreshOutcome,
  moduleSupportState,
  registerCompilationDatabaseReconciliation,
  shouldRestartClangd,
  shouldCheckModuleSupport,
  shouldRenderProjectStatus,
  shouldUseWorkspaceClangd,
  statusCommandForCapability,
  withTimeout,
  workspaceAllowsToolExecution,
  type ModuleSupportState,
} from "./workflow";
import { classifyTaskExit, type TaskCompletion } from "./tasks";
import { MCPP_MANIFEST_GLOB, registerInProjectContext } from "./inProject";
import { computeMcppTomlCompletions } from "./mcppTomlCompletion";
import {
  buildModuleSetupPlan,
  executeModuleSetup,
  moduleSetupConfirmation,
  type ModuleSetupBlockedReason,
  type ModuleSetupStepResult,
} from "./moduleSetup";

const COMMAND_CONFIGURE = "mcpp.configureClangd";
const COMMAND_REFRESH = "mcpp.refreshCompilationDatabase";
const COMMAND_CHECK = "mcpp.checkModuleSupport";

interface ProjectContext {
  project: McppProjectDiscovery;
  analysis: CompilationDatabaseAnalysis;
}

interface ClangdResolution {
  path: string;
  version: ToolVersionResult;
  comparison: ToolIdentityComparison;
}

interface ProjectReconciliation {
  context: ProjectContext | undefined;
  databaseFound: boolean;
  configured: boolean;
}

interface ModuleStatus {
  state: ModuleSupportState;
  message: string;
}

type ConfigureMode = "automatic" | "interactive";

const moduleStatusByProject = new Map<string, ModuleStatus>();
const moduleCheckOperations = createLatestOperationTracker<string>();
// 记录 manifest/settings 变化触发的 IDE 配置请求；CDB watcher 只重读
// 已发布快照，避免写 CDB 后再次启动 mcpp 形成重入。
const forceConfigureOnlyByProject = new Set<string>();
let lastReconciledProjectRoot: string | undefined;

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
    const project = findNearestMcppProject(
      workspaceFolder.uri.fsPath,
      workspaceFolder.uri.fsPath,
    );
    if (project !== undefined) {
      return project;
    }
  }
  return undefined;
}

function findProjectForUri(uri: vscode.Uri): McppProjectDiscovery | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder === undefined) {
    return undefined;
  }
  return findNearestMcppProject(uri.fsPath, workspaceFolder.uri.fsPath);
}

function findWorkspaceProjects(
  currentProject: McppProjectDiscovery | undefined,
): McppProjectDiscovery[] {
  const projects = new Map<string, McppProjectDiscovery>();
  if (currentProject !== undefined) {
    projects.set(currentProject.root, currentProject);
  }
  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    const project = findNearestMcppProject(
      workspaceFolder.uri.fsPath,
      workspaceFolder.uri.fsPath,
    );
    if (project !== undefined) {
      projects.set(project.root, project);
    }
  }
  return [...projects.values()];
}

function loadProjectContext(project: McppProjectDiscovery | undefined = findCurrentProject()): ProjectContext | undefined {
  if (project === undefined) {
    return undefined;
  }

  if (!existsSync(project.compilationDatabasePath)) {
    return {
      project,
      analysis: {
        kind: "unknown",
        capability: "unavailable",
        reason: `找不到编译数据库：${project.compilationDatabasePath}`,
      },
    };
  }

  try {
    return {
      project,
      analysis: analyzeCompilationDatabase(readFileSync(project.compilationDatabasePath, "utf8")),
    };
  } catch (error) {
    return {
      project,
      analysis: {
        kind: "unknown",
        capability: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function hasUsableCompilationDatabase(project: McppProjectDiscovery): boolean {
  return loadProjectContext(project)?.analysis.capability !== "unavailable";
}

function moduleSetupBlockedMessage(reason: ModuleSetupBlockedReason): string {
  switch (reason) {
    case "project-toolchain-override":
      return "当前项目显式固定了非 LLVM 工具链；一键配置不会修改 mcpp.toml，请先手动切换项目工具链。";
    case "untrusted":
      return "当前工作区未受信任，不会执行外部程序。请先信任工作区。";
    case "busy":
      return "已有 mcpp 操作正在运行，请等待完成后再试。";
    case "unrecognized-inventory":
      return "无法识别 mcpp 工具链状态，请查看 mcpp 输出频道并检查 mcpp 版本。";
  }
}

function configurationTarget(uri: vscode.Uri): vscode.ConfigurationTarget {
  return vscode.workspace.getWorkspaceFolder(uri) === undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.WorkspaceFolder;
}

function projectConfiguration(project: McppProjectDiscovery): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("mcpp", vscode.Uri.file(project.root));
}

function officialClangdConfiguration(project: McppProjectDiscovery): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("clangd", vscode.Uri.file(project.root));
}

function appendProcessOutput(
  output: vscode.OutputChannel,
  title: string,
  executable: string,
  args: string[],
  result: { exitCode: number; stdout: string; stderr: string },
): void {
  try {
    output.appendLine(`\n[${new Date().toISOString()}] ${title}`);
    output.appendLine(`$ ${executable} ${args.join(" ")}`);
    if (result.stdout.length > 0) {
      output.appendLine(result.stdout.trimEnd());
    }
    if (result.stderr.length > 0) {
      output.appendLine(result.stderr.trimEnd());
    }
    output.appendLine(`[exit ${result.exitCode}]`);
  } catch {
    // 重载窗口时输出频道可能先于异步检查关闭。
  }
}

function appendOutputLine(output: vscode.OutputChannel, value: string): void {
  try {
    output.appendLine(value);
  } catch {
    // 重载窗口时输出频道可能先于异步操作关闭。
  }
}

async function resolveClangd(context: ProjectContext): Promise<ClangdResolution | undefined> {
  const compilerPath = context.analysis.compilerPath;
  if (compilerPath === undefined) {
    return undefined;
  }

  const compilerVersion = await runToolVersion(compilerPath);
  const configuredPath = projectConfiguration(context.project).get<string>("clangd.path", "").trim();
  const candidates = configuredPath.length > 0
    ? [configuredPath]
    : deriveClangdCandidates(compilerPath);
  let fallback: ClangdResolution | undefined;

  for (const candidate of candidates) {
    if (candidate !== "clangd" && !existsSync(candidate)) {
      continue;
    }

    const version = await runToolVersion(candidate);
    if (version.exitCode !== 0 || version.identity === undefined) {
      continue;
    }

    const comparison = compareToolIdentities(compilerVersion.identity, version.identity);
    const resolution = { path: candidate, version, comparison };
    if (comparison.compatible) {
      return resolution;
    }
    fallback ??= resolution;
  }

  return fallback;
}

async function maybeDisableCppTools(project: McppProjectDiscovery): Promise<void> {
  if (vscode.extensions.getExtension("ms-vscode.cpptools") === undefined) {
    return;
  }
  if (!projectConfiguration(project).get<boolean>("configureCppTools", true)) {
    return;
  }

  const uri = vscode.Uri.file(project.root);
  const configuration = vscode.workspace.getConfiguration("C_Cpp", uri);
  if (configuration.get<string>("intelliSenseEngine") === "disabled") {
    return;
  }

  const disable = "关闭 IntelliSense";
  const choice = await vscode.window.showWarningMessage(
    "clangd 和 Microsoft C/C++ IntelliSense 都可能报告诊断。是否只关闭当前工作区的 cpptools IntelliSense？",
    disable,
    "保留 IntelliSense",
  );
  if (choice === disable) {
    await configuration.update(
      "intelliSenseEngine",
      "disabled",
      configurationTarget(uri),
    );
  }
}

const CLANGD_RESTART_TIMEOUT_MS = 15_000;

async function restartClangd(output: vscode.OutputChannel): Promise<boolean> {
  if (vscode.extensions.getExtension("llvm-vs-code-extensions.vscode-clangd") === undefined) {
    return false;
  }
  try {
    const timedOut = {};
    const result = await withTimeout(
      vscode.commands.executeCommand("clangd.restart"),
      CLANGD_RESTART_TIMEOUT_MS,
      timedOut,
    );
    if (result === timedOut) {
      appendOutputLine(output, `[clangd] 重启命令超过 ${CLANGD_RESTART_TIMEOUT_MS / 1000} 秒未完成，已释放 IDE 操作队列。`);
      return false;
    }
    return true;
  } catch {
    // clangd 扩展可能尚未激活，但配置仍然已经写入。
    return false;
  }
}

async function configureClangd(
  context: ProjectContext,
  status: vscode.StatusBarItem,
  output: vscode.OutputChannel,
  mode: ConfigureMode,
  forceRestart: boolean = false,
): Promise<boolean> {
  const interactive = mode === "interactive";
  if (context.analysis.capability === "syntax-only") {
    if (interactive) {
      void vscode.window.showWarningMessage(
        `${context.analysis.kind.toUpperCase()} 模块产物无法由 clangd 读取。语法高亮仍然可用，但模块语义诊断需要 LLVM mcpp 工具链。`,
      );
    }
    updateStatusBar(status, context);
    return false;
  }
  if (context.analysis.capability !== "full" || context.analysis.compilerPath === undefined) {
    if (interactive) {
      void vscode.window.showWarningMessage(
        `${context.analysis.reason} 请先运行“mcpp: 刷新编译数据库”。`,
      );
    }
    return false;
  }
  if (!workspaceAllowsToolExecution(vscode.workspace.isTrusted)) {
    const message = "当前工作区未受信任，mcpp 不会执行 CDB 中的编译器或 clangd，也不会接管 clangd 配置。";
    if (interactive) {
      void vscode.window.showWarningMessage(message);
    } else {
      appendOutputLine(output, `[自动配置] ${message}`);
    }
    return false;
  }

  const clangd = await resolveClangd(context);
  if (clangd === undefined) {
    const message = "没有找到可用的 clangd。请安装与 mcpp LLVM 编译器来自同一 revision 的 clangd，或设置 mcpp.clangd.path；clangd 可以来自 xlings llvm-tools，也可以独立安装。";
    if (interactive) {
      void vscode.window.showErrorMessage(message);
    } else {
      appendOutputLine(output, `[自动配置] ${message}`);
    }
    return false;
  }
  if (!clangd.comparison.compatible && !interactive) {
    appendOutputLine(
      output,
      `[自动配置] 跳过不匹配的 clangd ${clangd.path}：${clangd.comparison.reason}。`,
    );
    return false;
  }

  const clangdConfiguration = officialClangdConfiguration(context.project);
  const modulesSupport = projectConfiguration(context.project)
    .get<ModulesSupportMode>("modulesSupport", "auto");
  const plan = buildClangdConfigurationPlan(
    clangdConfiguration.get<string>("path", "clangd"),
    clangdConfiguration.get<string[]>("arguments", []),
    clangd.path,
    {
      compilerPath: context.analysis.compilerPath,
      compilationArguments: context.analysis.arguments,
      modulesSupport,
      clangdIdentity: clangd.version.identity,
      platform: process.platform,
      hasPrebuiltModules: context.analysis.hasPrebuiltModules,
      workspaceFolder: context.project.root,
    },
  );

  if (plan.changed) {
    // clangd.arguments 不是资源域设置，必须与 clangd.path 一起写到工作区层级。
    await clangdConfiguration.update("path", plan.path, vscode.ConfigurationTarget.Workspace);
    await clangdConfiguration.update("arguments", plan.arguments, vscode.ConfigurationTarget.Workspace);
  }
  if (interactive) {
    await maybeDisableCppTools(context.project);
  }
  const restartRequired = shouldRestartClangd(plan.changed, interactive, forceRestart);
  const restartSucceeded = restartRequired ? await restartClangd(output) : false;
  if (!configurationReadyAfterRestart(restartRequired, restartSucceeded)) {
    const message = "clangd 配置已写入，但无法重启语言服务器。请查看 mcpp 输出频道，或手动执行 clangd 重启命令。";
    if (interactive) {
      void vscode.window.showErrorMessage(message);
    } else {
      appendOutputLine(output, `[自动配置] ${message}`);
    }
    return false;
  }
  updateStatusBar(status, context);

  if (!clangd.comparison.compatible) {
    void vscode.window.showWarningMessage(
      `clangd 已配置，但 LLVM 身份与 mcpp 编译器不匹配：${clangd.comparison.reason}。`,
    );
  } else if (interactive) {
    void vscode.window.showInformationMessage("mcpp 已为当前工作区配置匹配的 clangd。");
  } else if (plan.changed) {
    appendOutputLine(output, `[自动配置] clangd.path = ${plan.path}`);
  }

  return true;
}

function renderModuleStatus(status: vscode.StatusBarItem, moduleStatus: ModuleStatus): void {
  status.command = COMMAND_CHECK;
  status.show();
  status.text = moduleStatus.state === "available"
    ? "$(pass) mcpp: 模块可用"
    : "$(warning) mcpp: 模块不可用";
  status.tooltip = moduleStatus.message;
}

function invalidateModuleStatus(projectRoot: string): void {
  moduleCheckOperations.invalidate(projectRoot);
  moduleStatusByProject.delete(projectRoot);
}

function storeModuleStatus(
  status: vscode.StatusBarItem,
  context: ProjectContext,
  moduleStatus: ModuleStatus,
  checkToken?: number,
): boolean {
  if (
    checkToken !== undefined
    && !moduleCheckOperations.isCurrent(context.project.root, checkToken)
  ) {
    return false;
  }
  moduleStatusByProject.set(context.project.root, moduleStatus);
  if (shouldRenderProjectStatus(findCurrentProject()?.root, context.project.root)) {
    renderModuleStatus(status, moduleStatus);
  }
  return true;
}

function updateStatusBar(status: vscode.StatusBarItem, context?: ProjectContext): void {
  const currentProjectRoot = findCurrentProject()?.root;
  if (context === undefined) {
    if (currentProjectRoot === undefined) {
      status.hide();
    }
    return;
  }

  if (context.analysis.capability !== "full") {
    invalidateModuleStatus(context.project.root);
  }
  if (!shouldRenderProjectStatus(currentProjectRoot, context.project.root)) {
    return;
  }

  status.command = statusCommandForCapability(context.analysis.capability);
  status.show();
  if (context.analysis.capability === "full") {
    const moduleStatus = moduleStatusByProject.get(context.project.root);
    if (moduleStatus !== undefined) {
      renderModuleStatus(status, moduleStatus);
      return;
    }
    status.text = "$(symbol-interface) mcpp: LLVM 模块";
    status.tooltip = "正在等待 clangd 检查模块编译命令和 PCM。";
    return;
  }
  if (context.analysis.capability === "syntax-only") {
    status.text = `$(info) mcpp: 仅${context.analysis.kind.toUpperCase()}语法`;
    status.tooltip = `${context.analysis.reason} 模块语法高亮仍然可用。`;
    return;
  }

  status.text = "$(warning) mcpp: 缺少模块 CDB";
  status.tooltip = context.analysis.reason;
}

function checkResultMessage(classification: CheckResult): string {
  switch (classification) {
    case "ready":
      return "clangd 已加载 mcpp 编译命令和模块产物。";
    case "pcm-mismatch":
      return "clangd 与 mcpp 编译器或 PCM 来自不同的 LLVM 构建。建议运行“一键配置模块代码提示”安装匹配的 llvm-tools，或设置 mcpp.clangd.path。";
    case "module-unavailable":
      return "clangd 无法加载所需模块产物，请运行“mcpp: 刷新编译数据库”，并检查 CDB 中的 PCM 路径。";
    case "wrong-language-mode":
      return "clangd 没有为当前文件读取 C++20 或更高版本的编译命令。";
    default:
      return "clangd 模块检查失败，完整诊断请查看 mcpp 输出频道。";
  }
}

async function runModuleSupportCheck(
  context: ProjectContext,
  status: vscode.StatusBarItem,
  output: vscode.OutputChannel,
  mode: ConfigureMode,
): Promise<ModuleStatus | undefined> {
  const interactive = mode === "interactive";
  if (context.analysis.capability === "syntax-only") {
    const message = `${context.analysis.kind.toUpperCase()} 模块产物不能由 clangd 消费，模块代码提示不可用。语法高亮仍然可用。`;
    updateStatusBar(status, context);
    if (interactive) {
      const configure = "一键配置";
      const choice = await vscode.window.showWarningMessage(
        `${message}\n\n如需启用模块代码提示，请切换到 LLVM 工具链后重新构建。`,
        configure,
        "关闭",
      );
      if (choice === configure) {
        await vscode.commands.executeCommand(CLI_COMMANDS.autoConfigureModules);
      }
    }
    return undefined;
  }
  if (
    context.analysis.capability !== "full"
    || context.analysis.compilerPath === undefined
    || context.analysis.sourceFile === undefined
  ) {
    invalidateModuleStatus(context.project.root);
    const message = context.analysis.capability === "full"
      ? "compile_commands.json 没有可供 clangd 检查的源文件。"
      : context.analysis.reason;
    if (context.analysis.capability === "full") {
      storeModuleStatus(status, context, { state: "unavailable", message });
    }
    if (interactive) {
      void vscode.window.showWarningMessage(message);
    }
    return context.analysis.capability === "full"
      ? { state: "unavailable", message }
      : undefined;
  }

  if (!workspaceAllowsToolExecution(vscode.workspace.isTrusted)) {
    invalidateModuleStatus(context.project.root);
    const message = "当前工作区未受信任，不会执行 clangd 模块检查。信任工作区后扩展会自动重新检查。";
    const moduleStatus = { state: "unavailable", message } as const;
    storeModuleStatus(status, context, moduleStatus);
    if (interactive) {
      void vscode.window.showWarningMessage(message);
    } else {
      appendOutputLine(output, `[自动检查] ${message}`);
    }
    return moduleStatus;
  }

  const checkToken = moduleCheckOperations.begin(context.project.root);
  moduleStatusByProject.delete(context.project.root);
  if (shouldRenderProjectStatus(findCurrentProject()?.root, context.project.root)) {
    status.command = COMMAND_CHECK;
    status.text = "$(sync~spin) mcpp: 正在检查模块";
    status.tooltip = "正在使用 clangd 检查模块编译命令和 PCM。";
    status.show();
  }

  const clangd = await resolveClangd(context);
  if (clangd === undefined) {
    const message = "当前 LLVM 工具链没有找到可用的 clangd。请设置 mcpp.clangd.path。";
    const moduleStatus = { state: "unavailable", message } as const;
    if (!storeModuleStatus(status, context, moduleStatus, checkToken)) {
      return undefined;
    }
    if (interactive) {
      void vscode.window.showErrorMessage(message);
    } else {
      appendOutputLine(output, `[自动检查] ${message}`);
    }
    return moduleStatus;
  }

  const arguments_ = buildClangdArguments(
    officialClangdConfiguration(context.project).get<string[]>("arguments", []),
    {
      compilerPath: context.analysis.compilerPath,
      compilationArguments: context.analysis.arguments,
      modulesSupport: projectConfiguration(context.project)
        .get<ModulesSupportMode>("modulesSupport", "auto"),
      clangdIdentity: clangd.version.identity,
      platform: process.platform,
      hasPrebuiltModules: context.analysis.hasPrebuiltModules,
      workspaceFolder: context.project.root,
    },
  );
  const result = await runClangdCheck(
    clangd.path,
    context.analysis.sourceFile,
    context.project.root,
    arguments_,
  );
  appendProcessOutput(
    output,
    interactive ? "检查模块支持" : "自动检查模块支持",
    clangd.path,
    [`--check=${context.analysis.sourceFile}`, ...arguments_],
    result,
  );
  if (interactive) {
    output.show(true);
  }

  const message = checkResultMessage(result.classification);
  const moduleStatus = {
    state: moduleSupportState(result.classification),
    message,
  };
  if (!storeModuleStatus(status, context, moduleStatus, checkToken)) {
    return undefined;
  }
  if (interactive) {
    if (moduleStatus.state === "available") {
      void vscode.window.showInformationMessage(message);
    } else {
      void vscode.window.showErrorMessage(message);
    }
  } else {
    appendOutputLine(output, `[自动检查] ${message}`);
  }
  return moduleStatus;
}

async function updateModuleSupportForContext(
  context: ProjectContext,
  configured: boolean,
  status: vscode.StatusBarItem,
  output: vscode.OutputChannel,
): Promise<boolean> {
  if (shouldCheckModuleSupport(
    context.analysis.capability,
    configured,
    context.analysis.sourceFile,
  )) {
    const moduleStatus = await runModuleSupportCheck(context, status, output, "automatic");
    return moduleStatus?.state === "available";
  }

  if (context.analysis.capability === "full") {
    invalidateModuleStatus(context.project.root);
    const message = configured
      ? "compile_commands.json 没有可供 clangd 检查的源文件。"
      : "clangd 未完成配置，模块语义当前不可用。详情请查看 mcpp 输出频道。";
    storeModuleStatus(status, context, { state: "unavailable", message });
  }
  return false;
}

async function executeXlingsInstallTask(
  xlingsPath: string,
  args: string[],
  cwd: string,
): Promise<TaskCompletion> {
  const task = new vscode.Task(
    { type: "mcpp-xlings", command: args[0] ?? "xlings" },
    vscode.TaskScope.Workspace,
    "mcpp: 安装 llvm-tools",
    "mcpp",
    new vscode.ProcessExecution(xlingsPath, args, { cwd }),
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

async function autoConfigureModulesWizard(
  context: ProjectContext,
  status: vscode.StatusBarItem,
  output: vscode.OutputChannel,
  cliController: McppCliController,
): Promise<void> {
  appendOutputLine(output, "[一键配置] 开始一键配置模块代码提示...");

  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(moduleSetupBlockedMessage("untrusted"));
    return;
  }
  const inventory = await cliController.readToolchainInventory(context.project);
  if (inventory === undefined) {
    return;
  }
  const decision = buildModuleSetupPlan(
    inventory,
    context.analysis.capability,
    vscode.workspace.isTrusted,
    cliController.isBusy(),
  );
  if (decision.kind === "blocked") {
    void vscode.window.showWarningMessage(moduleSetupBlockedMessage(decision.reason));
    return;
  }

  const confirmation = moduleSetupConfirmation(context.analysis.capability, decision);
  const choice = await vscode.window.showWarningMessage(
    confirmation.message,
    { modal: true, detail: confirmation.detail },
    "确认一键配置",
  );
  if (choice !== "确认一键配置") {
    return;
  }

  let currentContext = context;
  const outcome = await executeModuleSetup(decision, {
    preparePlan: () => cliController.runAutomaticModuleSetup(decision),
    reload: async (): Promise<ModuleSetupStepResult> => {
      const refreshed = loadProjectContext(context.project);
      if (refreshed === undefined) {
        return { stage: "reload", state: "failed", detail: "无法重新加载 mcpp 工程。" };
      }
      currentContext = refreshed;
      updateStatusBar(status, currentContext);
      if (currentContext.analysis.capability !== "full" || currentContext.analysis.kind !== "llvm") {
        return {
          stage: "reload",
          state: "failed",
          detail: "构建后没有得到可供 clangd 使用的 LLVM 编译数据库。",
        };
      }
      return { stage: "reload", state: "succeeded" };
    },
    ensureClangd: async (): Promise<ModuleSetupStepResult> => {
      const clangd = await resolveClangd(currentContext);
      if (clangd?.comparison.compatible) {
        const configured = await configureClangd(currentContext, status, output, "automatic", true);
        return configured
          ? { stage: "clangd", state: "succeeded" }
          : { stage: "clangd", state: "failed", detail: "clangd 配置未完成。" };
      }

      const xlingsPath = await resolveXlingsExecutable(
        cliController.mcppExecutable(currentContext.project),
      );
      const compilerPath = currentContext.analysis.compilerPath;
      if (xlingsPath === undefined || compilerPath === undefined) {
        return {
          stage: "clangd",
          state: "failed",
          detail: "未找到 xlings 或 LLVM 编译器，无法安装匹配的 llvm-tools。",
        };
      }
      const compilerVersion = await runToolVersion(compilerPath);
      const installArgs = xlingsInstallArgs(
        compilerVersion.identity === undefined ? undefined : llvmToolsVersionSpec(compilerVersion.identity),
      );
      const installed = await executeXlingsInstallTask(xlingsPath, installArgs, currentContext.project.root);
      appendOutputLine(
        output,
        `[一键配置] xlings install 完成（退出码 ${installed.exitCode ?? "未知"}）`,
      );
      if (installed.state !== "succeeded") {
        return {
          stage: "clangd",
          state: installed.state,
          exitCode: installed.exitCode,
          detail: installed.state === "cancelled" ? "llvm-tools 安装已取消。" : "llvm-tools 安装失败。",
        };
      }

      const refreshed = loadProjectContext(currentContext.project);
      if (refreshed === undefined) {
        return { stage: "clangd", state: "failed", detail: "安装 llvm-tools 后无法重新加载工程。" };
      }
      currentContext = refreshed;
      updateStatusBar(status, currentContext);
      const resolved = await resolveClangd(currentContext);
      if (resolved === undefined || !resolved.comparison.compatible) {
        return { stage: "clangd", state: "failed", detail: "未找到与 LLVM 编译器匹配的 clangd。" };
      }
      const configured = await configureClangd(currentContext, status, output, "automatic", true);
      return configured
        ? { stage: "clangd", state: "succeeded" }
        : { stage: "clangd", state: "failed", detail: "clangd 配置未完成。" };
    },
    checkModules: async (): Promise<ModuleSetupStepResult> => {
      const moduleStatus = await runModuleSupportCheck(currentContext, status, output, "automatic");
      return moduleStatus?.state === "available"
        ? { stage: "check", state: "succeeded" }
        : { stage: "check", state: "failed", detail: "模块支持检查未通过。" };
    },
  });

  if (outcome.state === "succeeded") {
    if (outcome.degraded) {
      void vscode.window.showWarningMessage("构建失败，语言服务已刷新。请查看任务终端获取构建错误。");
    } else {
      void vscode.window.showInformationMessage("mcpp 模块代码提示一键配置完成。");
    }
  } else if (outcome.state === "cancelled") {
    void vscode.window.showWarningMessage(`一键配置已取消（${outcome.stage}）。`);
  } else {
    void vscode.window.showErrorMessage(`一键配置失败（${outcome.stage}）。${outcome.steps.at(-1)?.detail ?? "请查看 mcpp 输出频道。"}`);
  }
}

// mcpp.toml 结构补全：建议由纯函数 computeMcppTomlCompletions 计算，这里只做
// vscode 类型映射。范围：段头 snippet + 开放词汇段的写法模板；不含字段键/枚举
// 与依赖数据（分别等上游版本化 schema 与批量 catalog 接口）。
const mcppTomlCompletionKinds = {
  section: vscode.CompletionItemKind.Folder,
  template: vscode.CompletionItemKind.Snippet,
} as const;

const mcppTomlCompletionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(document, position) {
    // mcpp.toml 结构补全由 mcpp.tomlCompletion 控制，按文档作用域读取。
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
  moduleStatusByProject.clear();
  moduleCheckOperations.clear();
  forceConfigureOnlyByProject.clear();
  lastReconciledProjectRoot = undefined;
  const output = vscode.window.createOutputChannel("mcpp");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  const refreshStatus = (): void => updateStatusBar(status, loadProjectContext());
  const runGuarded = (operation: () => Promise<void>): (() => Promise<void>) => async () => {
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputLine(output, `发生未预期错误：${message}`);
      void vscode.window.showErrorMessage(`mcpp：${message}`);
    }
  };
  const showInteractiveIdeStart = (title: string): void => {
    appendOutputLine(output, `\n[IDE] ${title}：已接收，正在等待 IDE 操作队列。`);
    output.show(true);
  };
  let cliController: McppCliController;
  const runConfigureOnlyForProject = async (
    project: McppProjectDiscovery,
    interactive: boolean,
  ): Promise<ProcessResult | undefined> => {
    if (!workspaceAllowsToolExecution(vscode.workspace.isTrusted)) {
      appendOutputLine(output, "[CDB 配置] 工作区未受信任，跳过 mcpp build --configure-only。");
      if (interactive) {
        void vscode.window.showWarningMessage(
          "当前工作区未受信任，不会刷新编译数据库。请先信任工作区。",
        );
      }
      return undefined;
    }
    const result = await cliController.runConfigureOnly(project);
    if (result === undefined) {
      appendOutputLine(output, "[CDB 配置] 已有 mcpp 操作正在运行，本次刷新已跳过。");
      if (interactive) {
        void vscode.window.showWarningMessage(
          "已有 mcpp 操作正在运行，暂不能刷新编译数据库。请等待当前操作完成后重试。",
        );
      }
    }
    return result;
  };
  const manifestWatcher = vscode.workspace.createFileSystemWatcher(MCPP_MANIFEST_GLOB);
  const compilationDatabaseWatcher = vscode.workspace.createFileSystemWatcher("**/compile_commands.json");
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
  const executeWithWorkspaceClangd = createSerialExecutor();
  const reconcileProjectContext = async (
    project: McppProjectDiscovery | undefined,
    forceRestart: boolean,
    forceConfigureOnly: boolean = false,
    allowConfigureOnly: boolean = true,
  ): Promise<ProjectReconciliation> => {
    let context = loadProjectContext(project);
    if (context === undefined) {
      updateStatusBar(status, context);
      return {
        context,
        databaseFound: false,
        configured: false,
      };
    }

    // 缺少可用 CDB 时只运行配置阶段；完整 build/test 后则只重读已有 CDB。
    if (allowConfigureOnly) {
      try {
        const outcome = await ensureIdeConfigured({
          projectRoot: context.project.root,
          compilationDatabasePath: context.project.compilationDatabasePath,
          trusted: vscode.workspace.isTrusted,
          force: forceConfigureOnly,
          databaseValid: () => hasUsableCompilationDatabase(context!.project),
          configure: async () => {
            const result = await runConfigureOnlyForProject(context!.project, false);
            if (result === undefined) {
              throw new Error("已有 mcpp 操作正在运行");
            }
            if (forceConfigureOnly) {
              forceConfigureOnlyByProject.delete(context!.project.root);
            }
            return result;
          },
        });
        if (outcome.state === "configured") {
          context = loadProjectContext(context.project) ?? context;
        } else if (outcome.state === "failed") {
          appendOutputLine(output, `[自动配置] mcpp configure-only 失败（退出码 ${outcome.exitCode}）。`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendOutputLine(output, `[自动配置] ${message}`);
      }
    }

    updateStatusBar(status, context);

    const configured = await configureClangd(
      context,
      status,
      output,
      "automatic",
      forceRestart,
    );
    await updateModuleSupportForContext(context, configured, status, output);
    return {
      context,
      databaseFound: existsSync(context.project.compilationDatabasePath),
      configured,
    };
  };
  const reconcileProjectByRoot = createKeyedSingleFlightReconciler(
    (projectRoot: string, forceRestart) => executeWithWorkspaceClangd(
      async () => {
        const project = findNearestMcppProject(projectRoot);
        if (!shouldUseWorkspaceClangd(findCurrentProject()?.root, projectRoot)) {
          const context = loadProjectContext(project);
          return {
            context,
            databaseFound: context !== undefined
              && existsSync(context.project.compilationDatabasePath),
            configured: false,
          };
        }
        return reconcileProjectContext(
          project,
          forceRestart,
          forceConfigureOnlyByProject.has(projectRoot),
        );
      },
    ),
  );
  const reconcilePublishedCdbByRoot = createKeyedSingleFlightReconciler(
    (projectRoot: string, forceRestart) => executeWithWorkspaceClangd(
      async () => {
        const project = findNearestMcppProject(projectRoot, projectRoot);
        if (project === undefined) {
          return {
            context: undefined,
            databaseFound: false,
            configured: false,
          };
        }
        return reconcileProjectContext(project, forceRestart, false, false);
      },
    ),
  );
  const reconcileProject = (
    project: McppProjectDiscovery,
    forceRestart: boolean = false,
  ): Promise<ProjectReconciliation> => {
    invalidateModuleStatus(project.root);
    return reconcileProjectByRoot(project.root, forceRestart);
  };
  const requestAutomaticReconciliation = (
    compilationDatabase: vscode.Uri,
    forceRestart: boolean,
  ): void => {
    const project = findProjectForUri(compilationDatabase);
    if (project === undefined) {
      return;
    }
    invalidateModuleStatus(project.root);
    if (!shouldUseWorkspaceClangd(findCurrentProject()?.root, project.root)) {
      return;
    }
    // CDB watcher 只重读已经发布的数据库，避免配置阶段写 CDB 后再次启动 mcpp。
    void reconcilePublishedCdbByRoot(project.root, forceRestart).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputLine(output, `[自动配置] ${message}`);
    });
  };
  const requestCurrentProjectReconciliation = (forceRestart: boolean): void => {
    const project = findCurrentProject();
    if (project === undefined) {
      lastReconciledProjectRoot = undefined;
      refreshStatus();
      return;
    }
    lastReconciledProjectRoot = project.root;
    void reconcileProject(project, forceRestart).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputLine(output, `[自动配置] ${message}`);
    });
  };
  const requestManifestReconciliation = (manifestUri: vscode.Uri): void => {
    refreshStatus();
    cliController.refreshStatus();
    const currentProject = findCurrentProject();
    const project = projectAffectedByManifest(
      manifestUri.fsPath,
      currentProject,
      findProjectForUri(manifestUri),
    );
    if (project === undefined) {
      return;
    }
    forceConfigureOnlyByProject.add(project.root);
    if (!shouldUseWorkspaceClangd(findCurrentProject()?.root, project.root)) {
      return;
    }
    lastReconciledProjectRoot = project.root;
    void reconcileProject(project, true).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputLine(output, `[自动配置] ${message}`);
    });
  };
  const requestDeletedManifestReconciliation = (manifestUri: vscode.Uri): void => {
    refreshStatus();
    cliController.refreshStatus();
    const deletedProjectRoot = manifestProjectRoot(manifestUri.fsPath);
    forceConfigureOnlyByProject.delete(deletedProjectRoot);
    invalidateModuleStatus(deletedProjectRoot);
    if (!shouldReconcileDeletedManifest(lastReconciledProjectRoot, manifestUri.fsPath)) {
      return;
    }

    lastReconciledProjectRoot = undefined;
    const fallbackProject = findCurrentProject();
    if (
      fallbackProject !== undefined
      && isPathWithinProject(manifestProjectRoot(manifestUri.fsPath), fallbackProject.root)
    ) {
      forceConfigureOnlyByProject.add(fallbackProject.root);
    }
    requestCurrentProjectReconciliation(true);
  };
  const configurationWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    const currentProject = findCurrentProject();
    let currentExecutionChanged = false;
    for (const project of findWorkspaceProjects(currentProject)) {
      const uri = vscode.Uri.file(project.root);
      if (!configurationAffectsMcppExecution(
        (section) => event.affectsConfiguration(section, uri),
      )) {
        continue;
      }
      forceConfigureOnlyByProject.add(project.root);
      currentExecutionChanged ||= project.root === currentProject?.root;
    }
    if (currentExecutionChanged) {
      requestCurrentProjectReconciliation(true);
      return;
    }
    if (currentProject === undefined) {
      return;
    }
    const uri = vscode.Uri.file(currentProject.root);
    if (configurationAffectsModuleSupport(
      (section) => event.affectsConfiguration(section, uri),
    )) {
      requestCurrentProjectReconciliation(true);
    }
  });
  const trustWatcher = vscode.workspace.onDidGrantWorkspaceTrust(() => {
    const project = findCurrentProject();
    if (project !== undefined) forceConfigureOnlyByProject.add(project.root);
    requestCurrentProjectReconciliation(true);
  });

  const afterProjectTask = async (
    project: McppProjectDiscovery,
    kind: "build" | "run" | "test" | "clean",
    completion: { state: "succeeded" | "failed" | "cancelled"; exitCode?: number },
  ): Promise<void> => {
    if (!shouldUseWorkspaceClangd(findCurrentProject()?.root, project.root)) {
      invalidateModuleStatus(project.root);
      refreshStatus();
      return;
    }

    const configureOnlyPending = forceConfigureOnlyByProject.has(project.root);
    const reconciled = await executeWithWorkspaceClangd(
      () => reconcileProjectContext(
        project,
        true,
        configureOnlyPending,
        configureOnlyPending,
      ),
    );
    if (kind === "build") {
      if (reconciled.context?.analysis.capability === "syntax-only") {
        const buildMessage = completion.state === "succeeded" ? "mcpp 构建完成" : "mcpp 构建失败";
        void vscode.window.showWarningMessage(
          `${buildMessage}；${reconciled.context.analysis.reason}。模块语法高亮仍然可用。`,
        );
        return;
      }
      const outcome = describeRefreshOutcome(
        completion.exitCode ?? 1,
        reconciled.databaseFound,
        reconciled.configured,
      );
      if (outcome.level === "information") {
        void vscode.window.showInformationMessage(outcome.message);
      } else if (outcome.level === "warning") {
        void vscode.window.showWarningMessage(outcome.message);
      } else {
        void vscode.window.showErrorMessage(outcome.message);
      }
      return;
    }

    if (completion.state === "succeeded") {
      const label = kind === "run" ? "运行" : kind === "test" ? "测试" : "清理";
      void vscode.window.showInformationMessage(`mcpp ${label}完成；clangd/CDB 状态已重新检查。`);
    }
  };
  cliController = new McppCliController({
    output,
    currentProject: findCurrentProject,
    afterProjectTask,
    isTrusted: () => vscode.workspace.isTrusted,
  });

  extensionContext.subscriptions.push(
    output,
    status,
    ...cliController.register(),
    vscode.languages.registerCompletionItemProvider(
      { language: "mcpp-toml" },
      mcppTomlCompletionProvider,
      "[",
    ),
    vscode.commands.registerCommand(COMMAND_CONFIGURE, runGuarded(async () => {
      const project = findCurrentProject();
      if (project === undefined) {
        await vscode.window.showWarningMessage("当前工作区没有找到 mcpp.toml。");
        return;
      }
      showInteractiveIdeStart("配置 clangd");
      await executeWithWorkspaceClangd(async () => {
        if (!shouldUseWorkspaceClangd(findCurrentProject()?.root, project.root)) {
          return;
        }
        const context = loadProjectContext(project);
        if (context === undefined) {
          return;
        }
        const configured = await configureClangd(context, status, output, "interactive");
        await updateModuleSupportForContext(context, configured, status, output);
      });
    })),
    vscode.commands.registerCommand(COMMAND_REFRESH, runGuarded(async () => {
      const project = findCurrentProject();
      if (project === undefined) {
        await vscode.window.showWarningMessage("当前工作区没有找到 mcpp.toml。");
        return;
      }
      showInteractiveIdeStart("刷新编译数据库");
      await executeWithWorkspaceClangd(async () => {
        const hadUsableDatabase = hasUsableCompilationDatabase(project);
        const result = await runConfigureOnlyForProject(project, true);
        if (result === undefined) {
          return;
        }
        const reconciled = await reconcileProjectContext(project, true, false, false);
        const databaseValid = reconciled.context?.analysis.capability !== "unavailable";
        const outcome = describeConfigureOnlyOutcome(
          result.exitCode,
          databaseValid,
          hadUsableDatabase && result.exitCode !== 0,
          reconciled.configured,
        );
        if (outcome.level === "information") {
          void vscode.window.showInformationMessage(outcome.message);
        } else if (outcome.level === "warning") {
          void vscode.window.showWarningMessage(outcome.message);
        } else {
          void vscode.window.showErrorMessage(outcome.message);
        }
      });
    })),
    vscode.commands.registerCommand(COMMAND_CHECK, runGuarded(async () => {
      const project = findCurrentProject();
      if (project === undefined) {
        await vscode.window.showWarningMessage("当前工作区没有找到 mcpp.toml。");
        return;
      }
      showInteractiveIdeStart("检查模块支持");
      await executeWithWorkspaceClangd(async () => {
        if (!shouldUseWorkspaceClangd(findCurrentProject()?.root, project.root)) {
          return;
        }
        const ctx = loadProjectContext(project);
        if (ctx === undefined) {
          return;
        }

        // When module support is already known to be unavailable, offer actionable choices
        const currentStatus = moduleStatusByProject.get(ctx.project.root);
        if (currentStatus?.state === "unavailable" && ctx.analysis.capability === "full") {
          interface StatusActionItem extends vscode.QuickPickItem {
            action: "auto-configure" | "recheck" | "rebuild";
          }
          const choice = await vscode.window.showQuickPick<StatusActionItem>([
            {
              label: "$(rocket) 一键配置模块代码提示",
              description: "自动安装匹配的 llvm-tools 并配置 clangd",
              action: "auto-configure",
            },
            {
              label: "$(check) 重新检查模块支持",
              description: "再次运行 clangd 模块检查",
              action: "recheck",
            },
            {
              label: "$(database) 刷新编译数据库",
              description: "重新生成 compile_commands.json",
              action: "rebuild",
            },
          ], {
            title: "mcpp 模块代码提示不可用",
            placeHolder: "选择操作以修复模块代码提示",
          });
          if (choice === undefined) {
            return;
          }
          switch (choice.action) {
            case "auto-configure":
              await autoConfigureModulesWizard(ctx, status, output, cliController);
              return;
            case "recheck":
              await runModuleSupportCheck(ctx, status, output, "interactive");
              return;
            case "rebuild":
              await vscode.commands.executeCommand(COMMAND_REFRESH);
              return;
          }
        }

        // QuickPick for syntax-only (GCC/MSVC) projects — no module code intelligence available
        if (ctx.analysis.capability === "syntax-only") {
          interface SyntaxOnlyActionItem extends vscode.QuickPickItem {
            action: "auto-configure" | "install-toolchain" | "select-default";
          }
          const kindLabel = ctx.analysis.kind.toUpperCase();
          const choice = await vscode.window.showQuickPick<SyntaxOnlyActionItem>([
            {
              label: "$(rocket) 一键配置模块代码提示",
              description: `当前为 ${kindLabel} 工具链，查看如何切换到 LLVM`,
              action: "auto-configure",
            },
            {
              label: "$(cloud-download) 安装 LLVM 工具链",
              description: "通过 mcpp 下载并安装 LLVM 工具链",
              action: "install-toolchain",
            },
            {
              label: "$(settings-gear) 选择全局默认工具链",
              description: "从已安装的工具链中选择默认",
              action: "select-default",
            },
          ], {
            title: `mcpp: 当前为 ${kindLabel} 工具链，模块代码提示不可用`,
            placeHolder: "切换到 LLVM 工具链以启用模块代码提示",
          });
          if (choice === undefined) {
            return;
          }
          switch (choice.action) {
            case "auto-configure":
              await autoConfigureModulesWizard(ctx, status, output, cliController);
              return;
            case "install-toolchain":
              await vscode.commands.executeCommand(CLI_COMMANDS.installToolchain);
              return;
            case "select-default":
              await vscode.commands.executeCommand(CLI_COMMANDS.selectDefaultToolchain);
              return;
          }
        }

        // Original flow: run module check
        await runModuleSupportCheck(ctx, status, output, "interactive");
      });
    })),
    vscode.commands.registerCommand("mcpp.autoConfigureModules", runGuarded(async () => {
      const project = findCurrentProject();
      if (project === undefined) {
        await vscode.window.showWarningMessage("当前工作区没有找到 mcpp.toml。");
        return;
      }
      showInteractiveIdeStart("一键配置模块代码提示");
      await executeWithWorkspaceClangd(async () => {
        if (!shouldUseWorkspaceClangd(findCurrentProject()?.root, project.root)) {
          return;
        }
        const ctx = loadProjectContext(project);
        if (ctx !== undefined) {
          await autoConfigureModulesWizard(ctx, status, output, cliController);
        }
      });
    })),
    configurationWatcher,
    trustWatcher,
    inProjectContext,
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshStatus();
      const current = findCurrentProject();
      if (current !== undefined && current.root !== lastReconciledProjectRoot) {
        lastReconciledProjectRoot = current.root;
        requestCurrentProjectReconciliation(false);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshStatus();
      lastReconciledProjectRoot = undefined;
      requestCurrentProjectReconciliation(true);
    }),
    manifestWatcher,
    compilationDatabaseWatcher,
  );

  extensionContext.subscriptions.push(
    manifestWatcher.onDidCreate((manifestUri) => requestManifestReconciliation(manifestUri)),
    manifestWatcher.onDidChange((manifestUri) => {
      requestManifestReconciliation(manifestUri);
    }),
    manifestWatcher.onDidDelete((manifestUri) => requestDeletedManifestReconciliation(manifestUri)),
    ...registerCompilationDatabaseReconciliation(
      compilationDatabaseWatcher,
      requestAutomaticReconciliation,
    ),
  );

  try {
    const project = findCurrentProject();
    if (project === undefined) {
      await reconcileProjectContext(undefined, false);
    } else {
      lastReconciledProjectRoot = project.root;
      await reconcileProject(project, false);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendOutputLine(output, `[自动配置] ${message}`);
  }
}

export function deactivate(): void {
  moduleStatusByProject.clear();
  moduleCheckOperations.clear();
  forceConfigureOnlyByProject.clear();
  lastReconciledProjectRoot = undefined;
  // VS Code 会释放 activate() 注册的所有订阅。
}
