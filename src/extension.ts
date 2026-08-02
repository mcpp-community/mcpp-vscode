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
  type McppProjectDiscovery,
} from "./discovery";
import {
  findXlingsExecutable,
  llvmToolsVersionSpec,
  xlingsInstallArgs,
} from "./llvmTools";
import { CLI_COMMANDS } from "./commands";
import { McppCliController } from "./cliController";
import { runClangdCheck, runToolVersion, type ToolVersionResult } from "./process";
import {
  configurationReadyAfterRestart,
  configurationAffectsModuleSupport,
  createKeyedSingleFlightReconciler,
  createLatestOperationTracker,
  createSerialExecutor,
  describeRefreshOutcome,
  moduleSupportState,
  registerCompilationDatabaseReconciliation,
  shouldRestartClangd,
  shouldCheckModuleSupport,
  shouldRenderProjectStatus,
  shouldUseWorkspaceClangd,
  statusCommandForCapability,
  workspaceAllowsToolExecution,
  type ModuleSupportState,
} from "./workflow";
import { classifyTaskExit, type TaskCompletion } from "./tasks";

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
let lastReconciledProjectRoot: string | undefined;

function findCurrentProject(): McppProjectDiscovery | undefined {
  const activePath = vscode.window.activeTextEditor?.document.uri.scheme === "file"
    ? vscode.window.activeTextEditor.document.uri.fsPath
    : undefined;
  const searchPaths = [
    ...(activePath === undefined ? [] : [activePath]),
    ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []),
  ];

  for (const searchPath of searchPaths) {
    const project = findNearestMcppProject(searchPath);
    if (project !== undefined) {
      return project;
    }
  }
  return undefined;
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

async function restartClangd(): Promise<boolean> {
  if (vscode.extensions.getExtension("llvm-vs-code-extensions.vscode-clangd") === undefined) {
    return false;
  }
  try {
    await vscode.commands.executeCommand("clangd.restart");
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
      await vscode.window.showWarningMessage(
        `${context.analysis.kind.toUpperCase()} 模块产物无法由 clangd 读取。语法高亮仍然可用，但模块语义诊断需要 LLVM mcpp 工具链。`,
      );
    }
    updateStatusBar(status, context);
    return false;
  }
  if (context.analysis.capability !== "full" || context.analysis.compilerPath === undefined) {
    if (interactive) {
      await vscode.window.showWarningMessage(
        `${context.analysis.reason} 请先运行“mcpp: 刷新编译数据库”。`,
      );
    }
    return false;
  }
  if (!workspaceAllowsToolExecution(vscode.workspace.isTrusted)) {
    const message = "当前工作区未受信任，mcpp 不会执行 CDB 中的编译器或 clangd，也不会接管 clangd 配置。";
    if (interactive) {
      await vscode.window.showWarningMessage(message);
    } else {
      appendOutputLine(output, `[自动配置] ${message}`);
    }
    return false;
  }

  const clangd = await resolveClangd(context);
  if (clangd === undefined) {
    const message = "没有找到可用的 clangd。请安装与 mcpp LLVM 编译器来自同一 revision 的 clangd，或设置 mcpp.clangd.path；clangd 可以来自 xlings llvm-tools，也可以独立安装。";
    if (interactive) {
      await vscode.window.showErrorMessage(message);
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
  const restartSucceeded = restartRequired ? await restartClangd() : false;
  if (!configurationReadyAfterRestart(restartRequired, restartSucceeded)) {
    const message = "clangd 配置已写入，但无法重启语言服务器。请查看 mcpp 输出频道，或手动执行 clangd 重启命令。";
    if (interactive) {
      await vscode.window.showErrorMessage(message);
    } else {
      appendOutputLine(output, `[自动配置] ${message}`);
    }
    return false;
  }
  updateStatusBar(status, context);

  if (!clangd.comparison.compatible) {
    await vscode.window.showWarningMessage(
      `clangd 已配置，但 LLVM 身份与 mcpp 编译器不匹配：${clangd.comparison.reason}。`,
    );
  } else if (interactive) {
    await vscode.window.showInformationMessage("mcpp 已为当前工作区配置匹配的 clangd。");
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
      await vscode.window.showWarningMessage(message);
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
      await vscode.window.showWarningMessage(message);
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
      await vscode.window.showErrorMessage(message);
    } else {
      appendOutputLine(output, `[自动检查] ${message}`);
    }
    return moduleStatus;
  }

  const arguments_ = buildClangdArguments(
    officialClangdConfiguration(context.project).get<string[]>("arguments", []),
    {
      compilerPath: context.analysis.compilerPath,
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
      await vscode.window.showInformationMessage(message);
    } else {
      await vscode.window.showErrorMessage(message);
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

  // Step 1: Guard checks
  if (context.analysis.capability === "unavailable") {
    await vscode.window.showErrorMessage(context.analysis.reason);
    return;
  }
  if (context.analysis.capability === "syntax-only") {
    const kind = context.analysis.kind.toUpperCase();
    const install = "安装 LLVM 工具链";
    const select = "选择默认工具链";
    const choice = await vscode.window.showErrorMessage(
      `当前工具链是 ${kind}，其模块产物不能被 clangd 消费，模块代码提示功能不可用。\n\n如需使用模块代码提示，请先切换到 LLVM 工具链后重新构建项目。`,
      install,
      select,
      "关闭",
    );
    if (choice === install) {
      await vscode.commands.executeCommand(CLI_COMMANDS.installToolchain);
    } else if (choice === select) {
      await vscode.commands.executeCommand(CLI_COMMANDS.selectDefaultToolchain);
    }
    return;
  }
  if (context.analysis.compilerPath === undefined) {
    await vscode.window.showErrorMessage("compile_commands.json 中没有可用的编译器路径。");
    return;
  }
  if (!workspaceAllowsToolExecution(vscode.workspace.isTrusted)) {
    await vscode.window.showWarningMessage(
      "当前工作区未受信任，不会执行外部程序。请先信任工作区。",
    );
    return;
  }

  // Step 2: Check current clangd state
  const compilerVersion = await runToolVersion(context.analysis.compilerPath);
  appendOutputLine(
    output,
    `[一键配置] 编译器版本：LLVM ${llvmToolsVersionSpec(compilerVersion.identity ?? { major: 0, minor: 0, patch: 0 })}`,
  );

  const clangd = await resolveClangd(context);
  if (clangd?.comparison.compatible) {
    appendOutputLine(output, "[一键配置] 已找到兼容的 clangd，跳过安装步骤。");
    // Skip to configuration
  } else {
    if (clangd !== undefined) {
      appendOutputLine(
        output,
        `[一键配置] 未找到兼容的 clangd。原因：${clangd.comparison.reason}`,
      );
    } else {
      appendOutputLine(output, "[一键配置] 未找到任何可用的 clangd。");
    }

    // Step 3: Check xlings
    const xlingsPath = findXlingsExecutable();
    if (xlingsPath === undefined) {
      const installXlings = "安装 xlings";
      const setPath = "设置自定义 clangd 路径";
      const choice = await vscode.window.showErrorMessage(
        "未找到 xlings，无法自动下载匹配的 clangd。请先安装 xlings（https://xlings.org），\n或手动安装与编译器版本匹配的 llvm-tools，或在设置中指定 clangd 路径。",
        installXlings,
        setPath,
        "跳过",
      );
      if (choice === installXlings) {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://xlings.org"),
        );
      } else if (choice === setPath) {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "mcpp.clangd.path",
        );
      }
      return;
    }

    // Step 4: Offer installation
    const version = compilerVersion.identity !== undefined
      ? llvmToolsVersionSpec(compilerVersion.identity)
      : "latest";
    const install = "$(cloud-download) 安装 llvm-tools（推荐）";
    const setPath = "$(settings-gear) 设置自定义 clangd 路径";
    const choice = await vscode.window.showWarningMessage(
      `未找到与 mcpp 编译器匹配的 clangd（LLVM ${version}）。是否通过 xlings 安装 llvm-tools？`,
      { modal: true, detail: "xlings 将自动下载并安装匹配版本的 clangd、clang-format 和 clang-tidy。" },
      install,
      setPath,
      "跳过",
    );
    if (choice === setPath) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "mcpp.clangd.path",
      );
      return;
    }
    if (choice !== install) {
      return;
    }

    // Check concurrency
    if (cliController.isBusy()) {
      await vscode.window.showWarningMessage(
        "已有 mcpp 操作正在运行，请等待完成后再试。",
      );
      return;
    }

    // Note: xlings install is not tracked by McppOperationRegistry because it
    // operates on xlings-managed paths (not mcpp). The serial executor
    // (executeWithWorkspaceClangd) prevents concurrent wizard runs, and the
    // isBusy() check catches active mcpp operations before install starts.

    // Execute xlings install
    appendOutputLine(output, `[一键配置] 正在通过 xlings 安装 llvm-tools（${xlingsPath}）...`);
    const installArgs = xlingsInstallArgs(
      compilerVersion.identity !== undefined ? version : undefined,
    );
    const xlingsResult = await executeXlingsInstallTask(
      xlingsPath,
      installArgs,
      context.project.root,
    );
    appendOutputLine(
      output,
      `[一键配置] xlings install 完成（退出码 ${xlingsResult.exitCode ?? "未知"}）`,
    );
    if (xlingsResult.state !== "succeeded") {
      await vscode.window.showErrorMessage(
        `llvm-tools 安装${xlingsResult.state === "cancelled" ? "已取消" : "失败"}。请查看任务终端获取详细信息。`,
      );
      return;
    }
  }

  // Step 5: Re-resolve clangd
  const resolvedClangd = await resolveClangd(context);
  if (resolvedClangd === undefined || !resolvedClangd.comparison.compatible) {
    await vscode.window.showErrorMessage(
      "llvm-tools 安装完成，但未找到匹配的 clangd。请检查 xlings 安装日志或手动设置 mcpp.clangd.path。",
    );
    return;
  }
  appendOutputLine(output, `[一键配置] 已找到 clangd：${resolvedClangd.path}`);

  // Step 6: Configure clangd
  await configureClangd(context, status, output, "interactive", true);

  // Step 7: Offer rebuild
  const rebuild = "$(sync) 刷新编译数据库";
  const done = "$(close) 完成";
  const postChoice = await vscode.window.showInformationMessage(
    "clangd 配置完成。建议刷新编译数据库以生成模块 PCM。",
    rebuild,
    done,
  );
  if (postChoice === rebuild) {
    await cliController.runProjectTask("build");
  }

  // Step 8: Refresh module status and update status bar
  await runModuleSupportCheck(context, status, output, "automatic");
  appendOutputLine(output, `[一键配置] 一键配置完成。clangd：${resolvedClangd.path}`);
}

export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
  moduleStatusByProject.clear();
  moduleCheckOperations.clear();
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
  const manifestWatcher = vscode.workspace.createFileSystemWatcher("**/mcpp.toml");
  const compilationDatabaseWatcher = vscode.workspace.createFileSystemWatcher("**/compile_commands.json");
  const executeWithWorkspaceClangd = createSerialExecutor();
  const reconcileProjectContext = async (
    project: McppProjectDiscovery | undefined,
    forceRestart: boolean,
  ): Promise<ProjectReconciliation> => {
    const context = loadProjectContext(project);
    updateStatusBar(status, context);
    if (context === undefined) {
      return {
        context,
        databaseFound: false,
        configured: false,
      };
    }

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
        return reconcileProjectContext(project, forceRestart);
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
    const project = findNearestMcppProject(compilationDatabase.fsPath);
    if (project === undefined) {
      return;
    }
    invalidateModuleStatus(project.root);
    if (!shouldUseWorkspaceClangd(findCurrentProject()?.root, project.root)) {
      return;
    }
    void reconcileProject(project, forceRestart).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputLine(output, `[自动配置] ${message}`);
    });
  };
  const requestCurrentProjectReconciliation = (forceRestart: boolean): void => {
    const project = findCurrentProject();
    if (project === undefined) {
      refreshStatus();
      return;
    }
    void reconcileProject(project, forceRestart).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      appendOutputLine(output, `[自动配置] ${message}`);
    });
  };
  const configurationWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    const project = findCurrentProject();
    if (project === undefined) {
      return;
    }
    const uri = vscode.Uri.file(project.root);
    if (configurationAffectsModuleSupport(
      (section) => event.affectsConfiguration(section, uri),
    )) {
      requestCurrentProjectReconciliation(true);
    }
  });
  const trustWatcher = vscode.workspace.onDidGrantWorkspaceTrust(() => {
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

    const reconciled = await reconcileProject(project, true);
    if (kind === "build") {
      if (reconciled.context?.analysis.capability === "syntax-only") {
        const buildMessage = completion.state === "succeeded" ? "mcpp 构建完成" : "mcpp 构建失败";
        await vscode.window.showWarningMessage(
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
        await vscode.window.showInformationMessage(outcome.message);
      } else if (outcome.level === "warning") {
        await vscode.window.showWarningMessage(outcome.message);
      } else {
        await vscode.window.showErrorMessage(outcome.message);
      }
      return;
    }

    if (completion.state === "succeeded") {
      const label = kind === "run" ? "运行" : kind === "test" ? "测试" : "清理";
      await vscode.window.showInformationMessage(`mcpp ${label}完成；clangd/CDB 状态已重新检查。`);
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
    status,
    ...cliController.register(),
    vscode.commands.registerCommand(COMMAND_CONFIGURE, runGuarded(async () => {
      const project = findCurrentProject();
      if (project === undefined) {
        await vscode.window.showWarningMessage("当前工作区没有找到 mcpp.toml。");
        return;
      }
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
      await cliController.runProjectTask("build");
    })),
    vscode.commands.registerCommand(COMMAND_CHECK, runGuarded(async () => {
      const project = findCurrentProject();
      if (project === undefined) {
        await vscode.window.showWarningMessage("当前工作区没有找到 mcpp.toml。");
        return;
      }
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
              await cliController.runProjectTask("build");
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
    manifestWatcher.onDidCreate(() => {
      refreshStatus();
      cliController.refreshStatus();
    }),
    manifestWatcher.onDidChange(() => {
      refreshStatus();
      cliController.refreshStatus();
    }),
    manifestWatcher.onDidDelete(() => {
      refreshStatus();
      cliController.refreshStatus();
    }),
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
  // VS Code 会释放 activate() 注册的所有订阅。
}
