# 与 mcppls 的集成契约

> 对象：`sunrisepeak.mcpp-language-server`（显示名 **C++ Modules Language Server**，仓库
> `Sunrisepeak/mcpp-language-server`，下称 mcppls）。本文记录本扩展**依赖的**契约与
> **不确定的**部分。撰写时对照 mcppls `0.0.9`。

## 1. 依赖声明

```json
"extensionDependencies": ["sunrisepeak.mcpp-language-server"]
```

VS Code 的 `extensionDependencies` **只接受扩展 ID，没有版本范围语法**。因此：

- 安装期：VS Code 自动安装当前平台可用的 mcppls（平台由 mcppls 的
  `vsce package --target <platform>` 决定），无需用户操作；
- 升级：用户升级 mcppls 后本扩展立即使用新版本，无需重装；
- **没有版本下限、没有版本上限、没有安装期兼容性校验**。

mcppls 侧**没有** `extensionDependencies`：依赖是单向的。

## 2. 本扩展调用的命令（全部耦合面）

### 2.1 第一批（v1 已有）

| 命令 ID | 本扩展中的用途 |
| --- | --- |
| `mcppls.selectContext` | `mcpp.configureLanguageServer`（+ 弃用别名 `mcpp.configureClangd`） |
| `mcppls.restartServer` | `mcpp.checkModuleSupport`；build 之后 |
| `mcppls.showModuleGraph` | `mcpp.showModuleGraph` |
| `mcppls.showLogs` | `mcpp.showLanguageServerLogs` |

### 2.2 第二批（§3.9「C++ Modules」视图）

| 命令 ID | 用途 | 危险级 |
| --- | --- | --- |
| `mcppls.restartServer` | 重启语言服务 | none |
| `mcppls.restartClangd` | 重启核心引擎（服务器命令 `mcppls.restartEngine`） | confirm |
| `mcppls.resetWorkspaceCache` | **重置本工作区的模型缓存**（服务器命令 `mcppls.resetCache`） | **destructive** |
| `mcppls.selectContext` | 选择分析上下文 | none |
| `mcppls.showModuleGraph` | 模块图 | none |
| `mcppls.showLogs` | 打开日志频道 | none |
| `mcppls.collectReport` | 收集诊断报告 | none |
| `mcppls.exportDiagnosticBundle` | 导出诊断包（服务器命令 `mcppls.exportBundle`） | none |
| `mcppls.runBuildToolInTerminal` | 在集成终端运行构建工具 | confirm |
| `mcppls.turnOffOtherCppFeatures` / `mcppls.restoreOtherCppFeatures` | 关闭/恢复其它 C++ 扩展的语言特性（**会写别的扩展自己的设置**，由 mcppls 执行） | confirm |
| `mcppls.turnOnInWorkspace` / `mcppls.turnOffInWorkspace` | 在本工作区启用/停用 C++ Modules（**会写 `mcppls.enable`**，由 mcppls 执行） | confirm |
| `mcppls.installCommandLineTools` | macOS 命令行工具 | confirm |
| `mcppls.review.run` / `mcppls.review.clear` | Review Changes（**服务器广告**的命令，服务器运行后才存在；受 `mcppls.ai.enabled` 约束） | none |

调用前只检查 `vscode.extensions.getExtension(id) !== undefined`，成功与否由
`vscode.commands.executeCommand` 是否抛出决定。**任何 `mcppls.*` 设置都由 mcppls 自己写**，
本扩展只在用户显式点击时转发它自己的命令。

**这些命令 ID 不是 mcppls 文档化的跨扩展 API。** mcppls 的 `docs/` 里从未出现这些 ID 的
字面量，`package.json` 也没有 `exports`/public API 章节。它们是 mcppls 自己的 UI 命令
（`editors/vscode/src/commands.ts:516-530` 的 `registerCommands`），随 mcppls 版本自由变动。
当前唯一的护栏是**本仓库的测试**。

## 3. 不可违反的规则：不要注册 `mcppls.*` 命令

mcppls 的 S3 规范第 **S3-5.6-3** 条（`docs/specs/s3-lsp-extensions.md:267`）：

> A client **MUST NOT** register a command of its own under an id the server advertises.

因为 `vscode-languageclient` 会为服务器 `executeCommandProvider` 广告的每个命令注册一个
VS Code 命令，重名会让 mcppls 的语言客户端启动失败。mcppls 因此成对存在：

| 扩展自有命令 | 服务器命令 |
| --- | --- |
| `mcppls.resetWorkspaceCache` | `mcppls.resetCache` |
| `mcppls.exportDiagnosticBundle` | `mcppls.exportBundle` |
| `mcppls.restartClangd` | `mcppls.restartEngine` |

**本扩展的任何新命令都必须用 `mcpp.` 前缀。** 也不要为了"补上"缺失的刷新命令而自己注册
`mcppls.reloadBuildDescription` —— 它已经在服务器的命令列表里。

服务器广告的完整命令列表（`src/orchestrator/routing.cpp:158`）：
`mcppls.review.run`、`mcppls.review.clear`、`mcppls.reloadBuildDescription`、
`mcppls.describeOnline`、`mcppls.restartEngine`、`mcppls.exportBundle`、`mcppls.resetCache`。

## 4. mcppls 侧的相关事实

- **扩展版本与产品版本一致**（三段 `MAJOR.MINOR.PATCH`），由 `mcppls-devtools version --check`
  强制与四端插件同步；服务器版本另写在 payload 的 `payload.json` 里。
- **`extensionKind: ["workspace"]`**；`capabilities.untrustedWorkspaces.supported = "limited"`
  且 `restrictedConfigurations: ["mcppls.compiler"]`；**`capabilities.virtualWorkspaces: false`**。
- mcppls 的 `activate()` 返回的是**测试 API**（`TestApi`）—— 见 §4.1，本扩展**尽力而为**地
  用它读取状态，且这是它唯一的非命令行通道。
- **`mcppls.mcpp`**（mcpp 可执行文件路径）在服务器注册表里存在
  （`src/config/settings.cpp:287`），但 `Surface::server` + `clientConfigurable = false`，
  所以 VS Code 设置里看不到它，本扩展也无法传递 `mcpp.path`。
  为空时 mcppls 按 **`PATH` → `$HOME/.mcpp/bin/mcpp` → `$HOME/.xlings/subos/current/bin/mcpp`**
  查找（`src/project/provider.cpp:12-20`、`src/project/mcpp.cpp:341`），**不使用 `mcpp self env`**。
- mcppls 用 `mcpp --protocol-version` 协商，只有声明了 `mcpp.build-database` 才运行
  `mcpp emit build-database --format json`；最后兜底才是 `mcpp build --configure-only`
  （`src/project/mcpp.cpp:226,249-258,277,373-395`）。
- mcppls 内部通过 LSP `workspace/executeCommand` 暴露 `mcppls.reloadBuildDescription`，
  并在窗口重新获得焦点时自行调用（`editors/vscode/src/extension.ts:647`）；但它
  **没有注册为 VS Code 命令**，所以本扩展无法调用（上游诉求 U.2）。
- payload 有强校验：`payload-version ∈ {1,2,3}`、`manifest.platform` 必须等于
  `${process.platform}-${process.arch}`（`editors/vscode/src/payload.ts:25-27,124-129`）。
- mcppls 只读 **`mcppls.*`** 设置，从不读 `mcpp.*`。
- mcppls 的诊断报告会读取 `mcpp-community.mcpp-vscode` 的 `packageJSON.version`
  作为环境信息（`editors/vscode/src/commands.ts:269`），并把 mcpp-vscode 明确排除在
  C++ 语言服务冲突候选之外（`editors/vscode/src/conflictCandidates.ts:23`）——
  这是 mcppls 对 mcpp-vscode 的单向了解，不构成兼容性判断。

### 4.1 状态读取：`extension.exports`（⚠ 非契约）

`activate()` 返回的对象在 mcppls 内部被命名为 **TestApi**，不是公开 API。但其中若干字段
**在非测试模式下也有效**，是本扩展获得 LSP 状态的唯一通道（我们没有 LSP 客户端，
也禁止再建一个）：

| 字段 | 非测试模式下是否有效 | 用途 |
| --- | --- | --- |
| `lastStatus(): CxxModulesStatus \| undefined` | ✅（`status.lastStatus()` 读的是控制器当前状态） | 视图的全部状态内容 |
| `statusBarText(): string` | ✅ | 与 mcppls 自己的状态栏文案一致 |
| `serverRunning()` / `serverEnabled()` | ✅ | 显示"运行中/已停用" |
| `serverCommands(): string[]` | ✅（服务器未运行时为空数组） | 判断服务器是否广告了某命令 |
| `environment()` | ✅ | version / vscode / appName / appHost / uiKind / platform / remote |
| `waitForState()` | ✅ | 需要等待某个状态时使用 |
| 计数器类（`notificationCount` 等） | ❌ 非测试模式下返回 `-1`/`0` | **不使用** |

**使用纪律**（写进 `mcpp-vscode/src/mcppls/state.ts`，并有单测与 e2e 覆盖）：

1. 形状探测：`exports` 是对象且 `typeof exports.lastStatus === "function"`，否则 `available: false`；
2. `try/catch` 包住调用；
3. 校验返回值的 `state` 属于 S3 的六个取值之一，否则视为**未知形状**；
4. `issues[].code` / `engines[].state` 用白名单渲染，未知值只显示文本、不解释；
5. 由 `mcpp.languageService.readState`（默认 true）可整体关闭；
6. **不轮询**：默认只在 `extensions.onDidChange`、命令完成回调、用户手动刷新时读。

`CxxModulesStatus` 的**内容**是 S3 规范级契约（`docs/specs/s3-lsp-extensions.md` §4）：
`state` / `project{root,source,level,tier}` / `profile` / `engine` / `engines[]` / `progress` /
`issues[]`（含**自带的修复 `command`**）/ `notices[]` / `onlineRun`。
不稳定的只是"能不能拿到这个对象"，所以降级路径必须存在。

**拿不到的**：mcppls 自己的缓存目录与体量。`environment()` 不含缓存路径，磁盘布局是内部实现，
本扩展**不读、不解析、不删除**；"清理"只通过 mcppls 自己的
`mcppls.resetWorkspaceCache`（调用前必须 modal 确认）。上游诉求见 U.5。

## 5. 平台矩阵

| 平台 | mcppls VSIX |
| --- | --- |
| linux-x64 | ✅ |
| linux-arm64 | ✅ |
| darwin-arm64 | ✅ |
| win32-x64 | ✅ |
| darwin-x64 | ❌ 无包 |
| win32-arm64 | ❌ 无包 |

来源：`packaging/release.manifest.json` 的 `platforms`，并由
`mcppls-devtools check platforms` 与 `packaging/payload.lock.json`、
`editors/vscode/src/payload.ts` 的 `SUPPORTED_PLATFORMS`、CI 矩阵四处比对。
在不支持的平台上，`extensionDependencies` 解析不到可安装的 mcppls，**本扩展不会被激活**
（硬依赖在安装/激活阶段解析），而不是激活后返回 `unavailable`。这条行为应在上线前用干净
extensions 目录实测确认（含离线安装场景），并记录在此。

## 6. 版本探测的可行手段（当前未使用）

```ts
const dependency = vscode.extensions.getExtension("sunrisepeak.mcpp-language-server");
const version = dependency?.packageJSON?.version;   // 标准且受支持
const commands = await vscode.commands.getCommands(true);  // 可做命令存在性探测
```

引入任何版本门禁或能力降级前，请先补齐这两项，并把结论写入本文件。

## 7. 变更流程

mcppls 侧发生以下任一变化时，本文件与 `src/languageServer.ts` 必须同步：

- 四个命令 ID 的增删改名；
- 命令语义变化（例如 `selectContext` 不再弹 QuickPick）；
- 平台矩阵变化；
- 出现新的公开刷新/状态命令；
- 服务器 `executeCommandProvider` 列表变化（影响 §3 的命名约束）。
