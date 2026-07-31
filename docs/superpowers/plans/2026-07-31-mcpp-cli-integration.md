# mcpp CLI 基础功能实施计划

> 面向执行代理：按任务逐项执行；每个任务先写失败测试，再写最小实现，并在任务边界提交一次。用户已选择在新建的 mcpp-vscode Git 仓库中直接执行本计划。

目标：在保留现有 clangd/CDB 自动协调的前提下，增加状态栏快捷菜单、工具链管理以及 build/run/test/clean 基础命令。

架构：src/cli.ts 负责工具链输出解析和 mcpp 参数；src/tasks.ts 负责任务计划、退出结果和并发状态；src/commands.ts 负责无 vscode 依赖的命令模型；src/cliController.ts 负责 VS Code Task、Quick Pick、确认框和状态栏；src/extension.ts 只接入控制器并复用现有 clangd 重协调。长任务使用 ProcessExecution，短命令继续使用参数数组的 execFile。

技术栈：TypeScript 5.9、Node.js node:test、VS Code Extension API 1.90、@vscode/vsce。

---

## 文件地图

新增：src/cli.ts、src/tasks.ts、src/commands.ts、src/cliController.ts，以及对应的 test/cli.test.ts、test/tasks.test.ts、test/commands.test.ts。

修改：src/extension.ts、src/process.ts（如需通用短命令入口）、src/workflow.ts（只在需要复用纯判定时）、package.json、package-lock.json、test/artifacts.test.ts、README.md、CHANGELOG.md。

保留：此前未跟踪的 docs/superpowers 旧设计和计划文件，不删除、不纳入本次提交。

## Task 1：工具链 CLI 模型与解析器

文件：创建 src/cli.ts、test/cli.test.ts。

### 1.1 红灯测试

先在 test/cli.test.ts 写固定输出测试，不访问本机工具链目录：

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import { mcppCommandArguments, normalizeToolchainSpec, parseToolchainList } from "../src/cli";

const plainOutput = [
  "Toolchains:",
  "  *  llvm 22.1.8             (default)",
  "     gcc 16.1.0",
  "",
  "Targets:",
  "  *  aarch64-macos           host                  llvm 22.1.8       installed",
  "",
  "Available toolchains:",
  "     llvm 20.1.7",
  "",
].join("\n");

test("解析已安装、默认和可安装项", () => {
  const inventory = parseToolchainList(plainOutput);
  assert.equal(inventory.recognized, true);
  assert.equal(inventory.projectOverridesGlobal, false);
  assert.equal(inventory.globalDefaultSpec, "llvm@22.1.8");
  assert.equal(inventory.effective?.spec, "llvm@22.1.8");
  assert.deepEqual(inventory.installed.map((item) => item.spec), ["llvm@22.1.8", "gcc@16.1.0"]);
  assert.deepEqual(inventory.available.map((item) => item.spec), ["llvm@20.1.7"]);
});

test("项目覆盖时分开记录有效项和全局默认", () => {
  const output = [
    "Toolchains:",
    "  *  llvm 22.1.8             (default)",
    "     gcc 16.1.0",
    "  (* = effective toolchain from project mcpp.toml [toolchain]; global default is 'gcc@16.1.0')",
  ].join("\n");
  const inventory = parseToolchainList(output);
  assert.equal(inventory.projectOverridesGlobal, true);
  assert.equal(inventory.effective?.spec, "llvm@22.1.8");
  assert.equal(inventory.globalDefaultSpec, "gcc@16.1.0");
});

test("支持系统 MSVC 和合法的空安装状态", () => {
  const system = parseToolchainList([
    "System:",
    "  *  msvc 17.10             C:\\\\Program Files\\\\MSVC\\\\cl.exe",
  ].join("\n"));
  assert.equal(system.effective?.spec, "msvc");
  assert.equal(system.installed[0]?.source, "system");

  const empty = parseToolchainList("(no toolchains installed - run mcpp build to auto-install the default)\\n");
  assert.equal(empty.recognized, true);
  assert.deepEqual(empty.installed, []);
});

test("未知输出不伪造工具链", () => {
  const inventory = parseToolchainList("unexpected output\\n");
  assert.equal(inventory.recognized, false);
  assert.deepEqual(inventory.installed, []);
  assert.equal(inventory.rawOutput, "unexpected output\\n");
});

test("规范化输入并构造参数数组", () => {
  assert.equal(normalizeToolchainSpec(" llvm@20 "), "llvm@20");
  assert.equal(normalizeToolchainSpec("gcc 16.1.0"), "gcc@16.1.0");
  assert.equal(normalizeToolchainSpec("gcc; rm -rf /"), undefined);
  assert.deepEqual(mcppCommandArguments("toolchain", "default", "llvm@22.1.8"), ["toolchain", "default", "llvm@22.1.8"]);
  assert.deepEqual(mcppCommandArguments("build"), ["build"]);
});
~~~

运行 npm test。预期 TypeScript 报告 src/cli.ts 不存在；确认是新功能缺失导致的红灯。

### 1.2 最小实现

src/cli.ts 提供以下无 vscode 类型：

~~~ts
export type ToolchainSource = "managed" | "system";
export interface ToolchainItem {
  family: string;
  version: string;
  spec: string;
  source: ToolchainSource;
  effective: boolean;
}
export interface ToolchainInventory {
  installed: ToolchainItem[];
  available: ToolchainItem[];
  effective: ToolchainItem | undefined;
  globalDefaultSpec: string | undefined;
  projectOverridesGlobal: boolean;
  recognized: boolean;
  rawOutput: string;
}
export function mcppCommandArguments(...args: string[]): string[];
export function normalizeToolchainSpec(input: string): string | undefined;
export function parseToolchainList(output: string): ToolchainInventory;
~~~

按 Toolchains:、System:、Available toolchains 区块识别行，不依赖列宽。管理工具链规范为 family@version，系统 MSVC 规范为 msvc。星号表示当前有效项；出现 global default is '...' 时使用其中的全局值，否则有效项就是全局值。no toolchains installed 是已识别的空状态。结果始终保留 rawOutput。

运行 npm test，预期新增 CLI 测试和原有 41 项全部通过。

提交：git add src/cli.ts test/cli.test.ts && git commit -m "feat: parse mcpp toolchain inventory"

## Task 2：任务计划、退出状态和并发登记

文件：创建 src/tasks.ts、test/tasks.test.ts。

### 2.1 红灯测试

测试基础命令、退出状态和双层锁：

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import { McppOperationRegistry, classifyTaskExit, projectTaskPlan, shouldReconcileAfterTask } from "../src/tasks";

test("基础任务不带高级参数", () => {
  assert.deepEqual(projectTaskPlan("build"), { kind: "build", title: "mcpp: 构建", args: ["build"] });
  assert.deepEqual(projectTaskPlan("run"), { kind: "run", title: "mcpp: 运行", args: ["run"] });
  assert.deepEqual(projectTaskPlan("test"), { kind: "test", title: "mcpp: 测试", args: ["test"] });
  assert.deepEqual(projectTaskPlan("clean"), { kind: "clean", title: "mcpp: 清理", args: ["clean"] });
});

test("四种项目任务都需要重协调", () => {
  for (const kind of ["build", "run", "test", "clean"] as const) {
    assert.equal(shouldReconcileAfterTask(kind), true);
  }
});

test("退出码区分成功、失败和取消", () => {
  assert.deepEqual(classifyTaskExit(0), { state: "succeeded", exitCode: 0 });
  assert.deepEqual(classifyTaskExit(2), { state: "failed", exitCode: 2 });
  assert.deepEqual(classifyTaskExit(undefined), { state: "cancelled" });
});

test("同一项目拒绝重复任务，全局锁独立", () => {
  const registry = new McppOperationRegistry<object>();
  const first = {};
  const second = {};
  assert.equal(registry.beginProject("/work/app", first), undefined);
  assert.equal(registry.beginProject("/work/app", second), first);
  assert.equal(registry.beginProject("/work/lib", second), undefined);
  assert.equal(registry.beginGlobal(first), undefined);
  assert.equal(registry.beginGlobal(second), first);
  registry.finishProject("/work/app", first);
  registry.finishGlobal(first);
  assert.equal(registry.beginProject("/work/app", second), undefined);
  assert.equal(registry.beginGlobal(second), undefined);
});
~~~

运行 npm test，预期 src/tasks.ts 缺失。

### 2.2 最小实现和验证

src/tasks.ts 提供：

~~~ts
export type ProjectTaskKind = "build" | "run" | "test" | "clean";
export type TaskState = "succeeded" | "failed" | "cancelled";
export interface ProjectTaskPlan { kind: ProjectTaskKind; title: string; args: string[]; }
export interface TaskCompletion { state: TaskState; exitCode?: number; }
export function projectTaskPlan(kind: ProjectTaskKind): ProjectTaskPlan;
export function shouldReconcileAfterTask(kind: ProjectTaskKind): boolean;
export function classifyTaskExit(exitCode: number | undefined): TaskCompletion;
export class McppOperationRegistry<T> { /* begin/finish project and global */ }
~~~

finish 只有 token 相同才清除；undefined 退出码不得归类为成功。运行 npm test，确认新测试和原有测试全部通过。

提交：git add src/tasks.ts test/tasks.test.ts && git commit -m "feat: model mcpp task lifecycle"

## Task 3：命令模型和清单声明

文件：创建 src/commands.ts、test/commands.test.ts；修改 package.json、test/artifacts.test.ts。

### 3.1 红灯测试

要求命令模型包含：

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import { CLI_COMMANDS, quickMenuItems } from "../src/commands";

test("CLI 命令覆盖项目、工具链和 IDE", () => {
  assert.deepEqual(Object.values(CLI_COMMANDS), [
    "mcpp.showMenu", "mcpp.build", "mcpp.run", "mcpp.test", "mcpp.clean",
    "mcpp.showToolchains", "mcpp.installToolchain", "mcpp.selectDefaultToolchain",
  ]);
  assert.deepEqual(quickMenuItems.map((item) => item.command), [
    "mcpp.build", "mcpp.run", "mcpp.test", "mcpp.clean",
    "mcpp.showToolchains", "mcpp.installToolchain", "mcpp.selectDefaultToolchain",
    "mcpp.configureClangd", "mcpp.refreshCompilationDatabase", "mcpp.checkModuleSupport",
  ]);
  assert.ok(quickMenuItems.every((item) => item.label.length > 0));
});
~~~

扩展清单断言完整命令清单、版本 0.2.0、全部新增命令的 activationEvents，以及 mcpp.path 描述包含“全部 mcpp CLI 命令”。先运行 npm test 确认失败。

### 3.2 最小实现和验证

src/commands.ts 导出不可变命令 ID、group、label、command，不导入 vscode。package.json 增加 mcpp.showMenu、mcpp.build、mcpp.run、mcpp.test、mcpp.clean、mcpp.showToolchains、mcpp.installToolchain、mcpp.selectDefaultToolchain 的中文标题和激活事件，版本改为 0.2.0，mcpp.path 改为“供扩展执行全部 mcpp CLI 命令使用”。

运行 npm test，确认命令模型、清单和原有测试通过。

提交：git add src/commands.ts test/commands.test.ts package.json test/artifacts.test.ts && git commit -m "feat: declare mcpp CLI commands"

## Task 4：VS Code Task 适配层

文件：创建 src/cliController.ts；修改 src/extension.ts。

### 4.1 先写边界测试

在 test/tasks.test.ts 增加一个纯判定：取消结果不调用重协调成功路径；成功、失败结果都允许刷新 CDB。先运行 npm test，确认新增断言在控制器未接入时失败。

### 4.2 实现任务启动

cliController.ts 创建长任务：

~~~ts
const task = new vscode.Task(
  { type: "mcpp", command: plan.kind, projectRoot },
  vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot)) ?? vscode.TaskScope.Workspace,
  plan.title,
  "mcpp",
  new vscode.ProcessExecution(executable, plan.args, { cwd: projectRoot }),
);
task.presentationOptions = {
  reveal: vscode.TaskRevealKind.Always,
  panel: vscode.TaskPanelKind.Dedicated,
  focus: true,
  clear: true,
  showReuseMessage: false,
};
~~~

在 executeTask 前监听 onDidEndTaskProcess，使用任务执行对象和 classifyTaskExit 解析结果。完整输出留在任务终端；mcpp 输出频道记录命令、退出状态和摘要。

用 McppOperationRegistry.beginProject 登记项目任务；重复时提示已有任务并提供 workbench.action.tasks.showTasks，不假装聚焦某个终端。finally 中用 token 解锁。工具链安装占用全局 token；默认值短命令也占用全局 token。

运行 npm run compile && npm test，预期编译成功、纯测试通过；不声称 Extension Host 图形 UI 已验证。

## Task 5：状态栏、项目命令和 clangd 协调

文件：修改 src/cliController.ts、src/extension.ts、src/process.ts（仅必要时）、test/artifacts.test.ts。

### 5.1 接入状态栏菜单

控制器创建第二个状态栏项，文本 $(tools) mcpp，只在 findCurrentProject() 有结果时显示；现有模块状态栏不改。点击使用 showQuickPick 展示 quickMenuItems，并按命令 ID 执行命令。监听活动编辑器、工作区文件夹和 mcpp.toml 变化刷新可见性。

### 5.2 接入项目命令

统一流程：解析当前工程和 mcpp.path；未信任或无 mcpp.toml 时只显示中文提示；clean 使用 modal 确认 target/；使用 projectTaskPlan 创建 Task；结束后调用扩展提供的 afterProjectTask(project, kind, completion): Promise<void>；四种项目任务均调用 reconcileProject(project, true)，但只有当前活动工程接管窗口 clangd；取消不显示成功。

把旧 mcpp.refreshCompilationDatabase 的直接 runMcppBuild 替换为同一套 build 控制器，保留原 ID 和标题，避免隐藏 execFile 与 Task 并发写同一 target/。构建结果继续复用 describeRefreshOutcome。

运行 npm test，预期全部通过。

提交：git add src/cliController.ts src/extension.ts src/process.ts test/tasks.test.ts test/artifacts.test.ts && git commit -m "feat: run mcpp project tasks from VS Code"

## Task 6：工具链查看、安装和全局默认

文件：修改 src/cliController.ts、src/cli.ts（仅测试揭示缺口时）、test/cli.test.ts、README.md、CHANGELOG.md。

### 6.1 红灯测试

增加非零列表结果、解析失败回退原始输出、安装后重新列表、项目覆盖文案的测试；先运行 npm test 确认失败。

### 6.2 实现短命令与 Quick Pick

短命令调用 runProcess(executable, ["toolchain", "list"], projectRoot)，并用 appendProcessOutput 写入 mcpp 输出频道。非零直接报错；recognized 为 false 时保留原始输出并报告兼容性错误。Quick Pick 分隔当前有效、已安装、系统和可安装项；无已安装项显示安装提示。

设置默认值只允许已安装/系统项，modal 确认后执行 mcppCommandArguments("toolchain", "default", item.spec)，占用全局 token。成功提示全局配置已更新；项目覆盖时同时提示覆盖关系，并提供“立即构建”按钮，不自动构建。

安装先列出 available，附加“输入其他 family@version”，用 normalizeToolchainSpec 校验；确认后 Task 执行 mcppCommandArguments("toolchain", "install", spec)，不传 --target。成功后重新读取列表，再询问是否进入选择全局默认；不从部分版本输入猜测最终版本。

### 6.3 文档和验证

README 增加快捷菜单、四个项目命令、工具链全局作用域、项目覆盖、任务终端、Workspace Trust、独立 mcpp/clangd 路径和高级参数限制。CHANGELOG 增加 0.2.0，并明确侧边栏是后续版本。运行 npm test，确认所有测试通过且新增用户提示为中文。

提交：git add src/cliController.ts src/cli.ts test/cli.test.ts README.md CHANGELOG.md && git commit -m "feat: add mcpp toolchain controls"

## Task 7：打包、安装和最终验证

### 7.1 完整验证

运行：

~~~sh
npm test
npm run compile
npm run package
~~~

预期：测试 0 失败、编译退出码为 0，生成 mcpp-vscode-0.2.0.vsix。

检查包：

~~~sh
unzip -l mcpp-vscode-0.2.0.vsix | rg "package.json|dist/src/cli|dist/src/cliController|dist/src/tasks|README.md|CHANGELOG.md"
~~~

包中必须包含新模块和中文文档，不包含 node_modules、dist/test 或 map 测试产物。

### 7.2 安装与烟测

运行 code --install-extension mcpp-vscode-0.2.0.vsix --force，再用 code --list-extensions --show-versions 检查登记版本；若 code 命令不可用，只报告 VSIX 已生成。

在受信任 mcpp 工程中从命令面板执行“mcpp: 查看工具链”，确认输出频道记录 toolchain list；检查“选择全局默认工具链”的确认和取消路径，不在未明确确认时修改用户全局默认。

### 7.3 提交验证状态

运行 git status --short --branch 和 git log --oneline --decorate -8。保留用户已有未跟踪 docs/superpowers 文件；最终报告提交、测试数量、VSIX 路径、安装结果和未完成的真实 Extension Host UI 验证。
