# mcpp-language-server 迁移实现计划

> **执行约定：**按任务顺序实施。每个任务先写失败测试，再写最小实现，最后运行该任务列出的验证命令。不要跨任务顺手改无关功能。

**目标：**让 `mcpp-community.mcpp-vscode` 不再安装、配置、探测或启动官方 clangd 扩展；把 C++ 模块语言服务职责交给 `sunrisepeak.mcpp-language-server`，同时保留 mcpp 的构建、工具链、任务和项目 UI。

**基线：**本计划编写于 `main@736ecbb`、扩展 `0.2.7`；本次迁移发布版本为 `0.4.0`（远端已占用 v0.3.0/v0.3.1）；上游 `sunrisepeak.mcpp-language-server@v0.0.4`（commit `04b186a`）。实现前重新核对上游 tag、VS Code 引擎要求、平台矩阵与 `extensionDependencies` 行为。

**架构：**本插件不引入 `vscode-languageclient`，不创建第二个 LanguageClient，不打包 mcppls payload。它只通过 VS Code 命令边界与语言服务依赖协作。语言服务依赖负责 LSP、内置语义引擎、项目描述、诊断、状态和模块请求；本插件负责 mcpp CLI。

**技术栈：**TypeScript、VS Code Extension API、Node `node:test`、Mocha + `@vscode/test-electron`、GitHub Actions。

## 执行状态（2026-09-25）

- [x] Task 1：manifest、依赖声明、隔离 VSIX 安装验证
- [x] Task 2：mcppls 公开命令桥接与命令契约
- [x] Task 3：build 任务后的语言服务刷新
- [x] Task 4：一键流程改为 build + mcppls restart
- [x] Task 5：删除 clangd/CDB/PCM 专属实现与测试
- [x] Task 6：E2E clangd stub 替换为 mcppls stub
- [x] Task 8：弃用设置、README、CHANGELOG 与兼容 alias
- [x] Task 9：版本、CI、残留审计、打包与隔离安装门禁
- [ ] Task 7：真实 mcppls 跨工具链语义验收（LLVM 22.1.8 单次通过，需 CI 复验；GCC 16 需 Linux runner）

实现结果：本地 `npm test`、`npm run test:e2e`、`npm run package`、VSIX 隔离安装均通过；
安装的 VSIX 自动解析到 `sunrisepeak.mcpp-language-server@0.0.4`。真实 mcppls 在 LLVM 22.1.8
mcpp 工程中已完成一次空诊断、定义、悬停、引用和补全验证；重复运行时 references 查询曾超时，
因此 Task 7 仍不是发布门禁。GCC 16 fixture 因当前 macOS 无对应工具链包未完成。当前仍按计划明确
记录 `darwin-x64` 尚无上游平台包。

---

## 先冻结决策

以下决策在实现期间不再重新讨论，除非上游发生破坏性变化：

1. **使用独立扩展依赖，不内置 payload。** `extensionDependencies` 只写 `sunrisepeak.mcpp-language-server`。
2. **不保留官方 clangd 扩展作为 fallback。** 两条语言服务不能并行，否则诊断、跳转与补全重复。
3. **不 fork mcppls，不在本插件内启动 `mcppls serve`。** 那会复制上游的客户端、状态 UI 和冲突处理。
4. **不向 `mcppls.*` 写入本插件的 `mcpp.path`。** 配置属于语言服务扩展；本插件只让 `mcpp.path` 作用于自己的 CLI 调用。
5. **保留稳定 ID 兼容映射。** 新的 mcpp 命令使用 mcppls 语义；旧 `mcpp.configureClangd` 作为弃用 alias 转发到新实现。
6. **本插件不再拥有 C++ 模块语义状态栏。** mcppls 已提供 C++ Language Status Item；本插件只保留 mcpp 快捷菜单状态栏。
7. **旧 mcpp 不阻断安装。** mcppls 会从 `compile_commands.json` 或源码扫描降级；本插件只在用户主动构建时执行 mcpp。
8. **先迁移命令、再删旧设置。** 旧 `mcpp.clangd.*` 与 `clangd.*` 工作区设置在兼容窗口内保留为无效配置，不再被本插件读取或写入。

## 不可越过的门禁

- 不得在 `package.json` 中保留 `llvm-vs-code-extensions.vscode-clangd`。
- 不得在 `src/`、`test/`、`README.md` 中保留“本插件启动/匹配/配置 clangd”的行为描述。
- 不得启动第二个 LSP 客户端，也不得把 mcppls payload 复制进本 VSIX。
- 不得静默修改用户已有的 `clangd.path`、`clangd.arguments`、`clangd.enable`。
- 不得删除 `mcpp.path`，直到 Task 8 明确 mcppls 能获得同一个 mcpp 可执行文件，或用户接受它只对 mcpp-vscode 生效。
- 不得在普通 `npm test` 中下载 Marketplace 扩展。

## 暂不处理

- 不合并两个 Marketplace 扩展。
- 不把 mcppls 的 `cxxModules/*` 协议复制成第二套客户端协议。
- 不处理上游未发布的平台；`darwin-x64` 缺失是明确的支持边界，在上游发布前不宣称支持。
- 不重写 mcpp.toml 补全、工具链管理、任务互斥、多根工程发现与新工程流程。
- 不处理与迁移无关的既有失败：`test/mcppTomlContract.test.ts` 的 3 个 `[xlings.envs]` 失败来自本机 mcpp 2026.9.25.1 移除了该段，应独立修复或固定测试用 mcpp 版本。

---

## File Map

| 文件 | 计划中的责任 |
| --- | --- |
| `package.json` | 用 mcppls 替换 clangd 依赖；VS Code 下限升到 1.91；声明新命令。旧设置先保留、最终在 Task 8 删除。 |
| `package-lock.json` | 只随 manifest 的必要变化更新；不新增语言客户端依赖。 |
| `src/languageServer.ts` | 纯命令桥接：探测 mcppls 是否存在、调用其公开命令、把失败映射为稳定结果。 |
| `src/extension.ts` | 删除 clangd 生命周期；保留 mcpp.toml provider、CLI controller 与命令注册。 |
| `src/commands.ts` | 统一公开命令 ID；快捷菜单改为 mcppls 语义。 |
| `src/moduleSetup.ts` | 一键流程改为“构建 + 刷新语言服务”，不再修改工具链。 |
| `src/cliController.ts` | 任务完成回调交给语言服务桥接；一键向导直接复用 `runProjectTask("build")`，删除专用 setup 锁与 command 序列。 |
| `src/workflow.ts` | 删除 CDB/clangd 单飞与状态渲染，只保留桥接需要的纯函数。 |
| `src/discovery.ts` | 保留 mcpp 工程发现并删除 `compilationDatabasePath`；删除 clangd 候选推导。 |
| `src/process.ts` | 保留 `runProcess`；删除 `runClangdCheck`、`runToolVersion`。 |
| `test/languageServer.test.ts` | 桥接契约：依赖 ID、命令 ID、参数、失败与去重。 |
| `test/artifacts.test.ts` | manifest、VSIX 依赖、禁止 clangd 行为残留。 |
| `test/e2e/fixtures/mcppls-stub/` | 隔离 Extension Host 测试中的 mcppls 依赖，不启动真实 LSP。 |
| `README.md`、`CHANGELOG.md` | 能力矩阵、依赖说明、升级迁移说明。 |
| `.github/workflows/ci.yml` | 增加 VSIX 依赖安装与桥接 E2E 检查。 |

---

# Task 1：锁定依赖、平台与发布门禁

**Files:**
- Modify: `test/artifacts.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 先改 manifest 测试为新契约**

将“声明官方 clangd 依赖”改成：

```ts
assert.equal(manifest.engines?.vscode, "^1.91.0");
assert.deepEqual(manifest.extensionDependencies, ["sunrisepeak.mcpp-language-server"]);
assert.ok(!manifest.extensionDependencies?.includes("llvm-vs-code-extensions.vscode-clangd"));
assert.ok(manifest.activationEvents?.includes("onCommand:mcpp.configureLanguageServer"));
assert.ok(!manifest.activationEvents?.includes("onCommand:mcpp.configureClangd"));
```

保留 `workspaceContains:mcpp.toml`、`onCommand:mcpp.run`、editor title 按钮和 TOML 补全断言。

- [ ] **Step 2: 写禁止行为测试**

断言以下内容不存在：

- manifest 中的官方 clangd 扩展 ID；
- `mcpp.clangd.path`、`mcpp.modulesSupport`、`mcpp.configureCppTools` 的新功能描述；
- `vscode-languageclient` 依赖；
- `clangd.restart` 调用；
- `runClangdCheck` / `resolveClangd` 等源码符号。

- [ ] **Step 3: 改 manifest**

- `engines.vscode` 改成 `^1.91.0`；
- `extensionDependencies` 改成 `["sunrisepeak.mcpp-language-server"]`；
- 新增 `mcpp.configureLanguageServer`、`mcpp.showModuleGraph`、`mcpp.showLanguageServerLogs`；
- 新 ID 与旧 ID 的 alias 在 Task 8 完成；
- 暂时保留旧设置，但本插件不再读取。

- [ ] **Step 4: 验证本地 VSIX 会拉取依赖**

```sh
code --extensions-dir "$TMP/extensions" --user-data-dir "$TMP/user-data" \
  --install-extension "$VSIX"
code --extensions-dir "$TMP/extensions" --user-data-dir "$TMP/user-data" \
  --list-extensions --show-versions
```

必须同时看到 `sunrisepeak.mcpp-language-server` 与本插件。若自动拉取失败，保留依赖声明，但 README 与发布脚本必须明确先装 mcppls，并将该行为升级为发布阻断。

- [ ] **Step 5: 确认平台矩阵**

Task 1 结束前记录 CI runner 覆盖的 `darwin-arm64`、`linux-x64`、`win32-x64`；`darwin-x64` 明确标为不支持，不能宣称全平台支持。

**Gate:** manifest 测试、VSIX 隔离安装、平台结论三项通过。

---

# Task 2：建立 mcppls 命令桥接

**Files:**
- Create: `src/languageServer.ts`
- Create: `test/languageServer.test.ts`
- Modify: `src/commands.ts`
- Modify: `test/commands.test.ts`

- [ ] **Step 1: 定义与 VS Code 分离的内部接口**

```ts
export const MCPPLS_EXTENSION_ID = "sunrisepeak.mcpp-language-server";

export const MCPPLS_COMMANDS = {
  restart: "mcppls.restartServer",
  selectContext: "mcppls.selectContext",
  graph: "mcppls.showModuleGraph",
  logs: "mcppls.showLogs",
} as const;

export interface LanguageServerCommandResult {
  state: "completed" | "unavailable" | "failed";
  message: string;
}

export interface LanguageServerCommandExecutor {
  extensionInstalled(id: string): boolean;
  executeCommand<T>(command: string, ...args: unknown[]): Thenable<T>;
}
```

刷新构建描述不是上游贡献的 VS Code 命令，而是一次 LSP execute-command 请求；本插件不能直接发起该请求。因此桥接采用下面的有限能力：

- 可直接调用 `mcppls.restartServer`、`mcppls.selectContext`、`mcppls.showModuleGraph`、`mcppls.showLogs`；
- 构建后调用 `mcppls.restartServer`，不在本插件伪造 `mcppls.reloadBuildDescription`；
- 未来若上游贡献一个公开的刷新命令，再替换 Task 3 的 build 后动作。

- [ ] **Step 2: 写失败测试**

覆盖：依赖存在时调用正确命令；依赖缺失返回 `unavailable`；命令抛错返回 `failed`；同一任务只刷新一次；错误文字包含 mcppls 扩展 ID，方便用户定位。

- [ ] **Step 3: 实现最小桥接**

提供：

- `restartLanguageServer()`；
- `selectContext()`；
- `showModuleGraph()`；
- `showLanguageServerLogs()`；
- `refreshLanguageServerAfterBuild()`（内部调用 restart）。

桥接不解析 mcppls 状态、不读取 `mcppls.*` 设置、不 spawn 子进程。

- [ ] **Step 4: 更新命令与 Quick Pick**

命令 ID：

```ts
export const CLI_COMMANDS = {
  showMenu: "mcpp.showMenu",
  newProject: "mcpp.newProject",
  build: "mcpp.build",
  run: "mcpp.run",
  test: "mcpp.test",
  clean: "mcpp.clean",
  showToolchains: "mcpp.showToolchains",
  installToolchain: "mcpp.installToolchain",
  selectDefaultToolchain: "mcpp.selectDefaultToolchain",
  configureLanguageServer: "mcpp.configureLanguageServer",
  refreshCompilationDatabase: "mcpp.refreshCompilationDatabase",
  checkModuleSupport: "mcpp.checkModuleSupport",
  autoConfigureModules: "mcpp.autoConfigureModules",
  showModuleGraph: "mcpp.showModuleGraph",
  showLanguageServerLogs: "mcpp.showLanguageServerLogs",
} as const;
```

旧 `mcpp.configureClangd` 保留为弃用 alias，迁移说明从本版本开始保留。快捷菜单标题改为“配置 C++ 模块语言服务”“刷新模块构建描述”“查看模块图”“打开 C++ Modules 日志”。

- [ ] **Step 5: 验证**

```sh
npm run compile
node --test dist/test/languageServer.test.js dist/test/commands.test.js
```

**Gate:** 桥接测试不依赖真实 VS Code 进程；命令 ID 全部在 `package.json` 与 `src/commands.ts` 一致。

---

# Task 3：迁移构建任务后的协调

**Files:**
- Modify: `src/tasks.ts`
- Modify: `src/cliController.ts`
- Modify: `src/extension.ts`
- Modify: `test/tasks.test.ts`
- Modify: `test/artifacts.test.ts`
- Modify: `test/e2e/suite/extension.test.ts`

- [ ] **Step 1: 先写任务回调契约**

- build 成功：调用一次 `refreshLanguageServerAfterBuild`；
- build 失败：也调用一次，使 mcppls 使用最后一次可用描述或显示降级；
- build 取消：不调用；
- run/test/clean：不调用；
- 桥接失败：不把成功的 mcpp build 改成失败，只追加 warning。

- [ ] **Step 2: 修改任务层**

把 `shouldReconcileAfterTask` 改为 `shouldRefreshLanguageServerAfterTask`，并只允许 `kind === "build" && completion.state !== "cancelled"`。

- [ ] **Step 3: 修改控制器与扩展**

`cliController.afterProjectTask` 调用桥接；删除：

- `executeWithWorkspaceClangd`；
- `reconcileProjectContext` / `reconcileProjectByRoot`；
- `compilationDatabaseWatcher`；
- `configurationWatcher` / `trustWatcher` 中的 clangd 配置重启；
- `lastReconciledProjectRoot`。

manifest watcher 仍负责 mcpp 项目状态，不负责语言服务。

- [ ] **Step 4: 改用户文案**

- “clangd/CDB 状态已重新检查” → “C++ 模块语言服务已刷新”；
- “mcpp 构建完成，clangd 配置已刷新” → “mcpp 构建完成，模块语言服务已刷新”；
- “刷新编译数据库”保留 ID，标题改成“刷新模块构建描述”；
- “检查模块支持”改成“重启 C++ Modules 语言服务”，直接调用 mcppls restart。

- [ ] **Step 5: 验证**

```sh
node --test dist/test/tasks.test.js dist/test/artifacts.test.js
```

**Gate:** 本插件不再因 build 事件主动读取 `compile_commands.json` 或启动任何语言服务器。

---

# Task 4：重写一键模块配置

**Files:**
- Modify: `src/moduleSetup.ts`
- Modify: `test/moduleSetup.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/cliController.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/artifacts.test.ts`

- [ ] **Step 1: 先定义新状态机测试**

```ts
export type ModuleSetupStage =
  | "prepare"
  | "build"
  | "language-server";
```

不再有 `default`、`clangd`、`check` 阶段。测试覆盖：

- 未受信任 / 忙碌 → blocked；
- 工具链清单无法识别 → blocked；
- GCC/MSVC/LLVM 项目均允许继续；
- `build` 固定执行普通 `mcpp build`；
- build 成功 → 只刷新语言服务一次；
- build 失败且 command 未被取消 → 仍刷新，让 mcppls 显示降级；
- build 失败但已有可用描述 → 结果为 degraded；
- 语言服务依赖缺失 → failed，不自动安装；
- 取消不产生后续调用。

- [ ] **Step 2: 简化 planner**

`buildModuleSetupPlan` 不再分析 CDB 工具链家族，也不再阻塞非 LLVM 项目。计划只决定是否已忙碌；默认无需修改工具链。

删除 `installLlvm`、`switchDefault` 与 `project-toolchain-override` 阻塞；一键命令固定执行普通 `mcpp build`，因为 mcppls 能从任意 mcpp 工具链读取构建描述。不得继续切换 LLVM。

- [ ] **Step 3: 改执行接口**

```ts
export interface ModuleSetupOperations {
  build(): Promise<ModuleSetupStepResult>;
  refreshLanguageServer(): Promise<ModuleSetupStepResult>;
}
```

删除 `preparePlan()`、`runAutomaticModuleSetup()`、专用 `executeAutomaticModuleSetupCommand()` 与独立 clangd check。`build()` 直接调用普通 `runProjectTask("build")` 的任务执行器，避免嵌套项目锁。

- [ ] **Step 4: 改向导 UI**

一次 modal 确认后只执行普通 `mcpp build` → mcppls restart。确认文案明确：不会安装官方 clangd 扩展，不会修改 `clangd.*`。

- [ ] **Step 5: 验证**

```sh
node --test dist/test/moduleSetup.test.js dist/test/artifacts.test.js
```

**Gate:** 测试与源码中不再出现 `llvmToolsVersionSpec`、`xlingsInstallArgs`、`ensureClangd`、`runClangdCheck`。

---

# Task 5：拆除 clangd 专属实现

**Files:**
- Delete: `src/analysis.ts`
- Delete: `src/llvmTools.ts`
- Delete: `test/analysis.test.ts`
- Delete: `test/llvmTools.test.ts`
- Modify: `src/process.ts`
- Modify: `test/process.test.ts`
- Modify: `src/discovery.ts`
- Modify: `test/discovery.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/workflow.ts`
- Modify: `test/workflow.test.ts`

- [ ] **Step 1: 用引用图确认删除范围**

```sh
rg -n -i 'clangd|compile_commands|PCMs?|ToolIdentity|ModuleCapability|CheckResult' src test package.json README.md
```

逐项分类：历史 CHANGELOG、迁移说明可保留；活动代码、旧测试和当前能力描述必须清除。

- [ ] **Step 2: 精简 process**

保留 `runProcess`（`cliController` 与契约测试仍需要）；删除 `runToolVersion`、`runClangdCheck`、`runMcppBuild` 及 ToolIdentity 类型。

- [ ] **Step 3: 精简 discovery**

保留 `McppProjectDiscovery`、manifest glob 与 nearest member 逻辑；删除 `compilationDatabasePath` 和 `deriveClangdCandidates` 及对应测试。任务/工具链逻辑只需要 `root`。

- [ ] **Step 4: 精简 workflow**

保留与 CLI 任务/操作注册相关且有非 clangd 用户的函数；删除：

- `shouldRestartClangd`；
- `configurationReadyAfterRestart`；
- `registerCompilationDatabaseReconciliation`；
- `configurationAffectsModuleSupport`；
- `shouldUseWorkspaceClangd`；
- `describeRefreshOutcome`；
- `statusCommandForCapability`；
- `shouldCheckModuleSupport`；
- `moduleSupportState`。

纯 single-flight/serial executor 若没有生产调用者，一并删除；不要为了测试保活死代码。

- [ ] **Step 5: 精简 extension**

删除 ProjectContext、CDB 读取、状态栏、clangd resolver/config、模块检查、CDB watcher、自动重协调与所有相关命令分支。`activate()` 最终只保留：

- mcpp.toml completion provider；
- mcpp project context；
- `McppCliController`；
- 语言服务桥接命令；
- 新的一键向导；
- 输出频道与资源释放。

- [ ] **Step 6: 清理测试**

删除纯 clangd 测试；重写 `artifacts.test.ts` 和 `workflow.test.ts`，只钉住迁移后仍有生产价值的行为。不得把“源码没有 clangd 字符串”作为唯一断言，行为测试优先。

- [ ] **Step 7: 验证**

```sh
npm run compile
node --test dist/test/process.test.js dist/test/discovery.test.js dist/test/workflow.test.js dist/test/artifacts.test.js
```

**Gate:** `rg -n 'llvm-vs-code-extensions.vscode-clangd|clangd.restart|runClangdCheck|resolveClangd|configureClangd' src test package.json` 无结果（历史文档除外）。

---

# Task 6：替换 E2E clangd stub 为 mcppls stub

**Files:**
- Delete: `test/e2e/fixtures/clangd-stub/`
- Create: `test/e2e/fixtures/mcppls-stub/package.json`
- Create: `test/e2e/fixtures/mcppls-stub/extension.js`
- Modify: `test/e2e/runTest.ts`
- Modify: `test/e2e/suite/extension.test.ts`

- [ ] **Step 1: 写 stub 契约**

stub 扩展：

- ID 为 `sunrisepeak.mcpp-language-server`；
- 激活时注册 `mcppls.restartServer`、`mcppls.showModuleGraph`、`mcppls.showLogs`；
- 每次调用向环境变量指定的日志文件追加 JSON；
- 不启动 LSP，不读取 workspace，不改配置。

- [ ] **Step 2: 改 Extension Host runner**

隔离目录中复制 mcppls stub，而不是 clangd stub。E2E 断言：

1. mcpp-vscode 激活；
2. `mcpp.refreshCompilationDatabase` 执行 fake mcpp build；
3. build 结束后调用 mcppls restart；
4. `mcpp.showModuleGraph` 与 `mcpp.showLanguageServerLogs` 只转发一次；
5. build 取消时不调用 restart。

- [ ] **Step 3: 加依赖缺失测试**

用一个不安装 mcppls stub 的显式环境测试桥接返回 `unavailable`，不抛出未处理异常。该测试不得依赖 Marketplace。

- [ ] **Step 4: 验证**

```sh
npm run test:e2e
```

在 Linux CI 继续用：

```sh
xvfb-run -a npm run test:e2e
```

**Gate:** E2E 证明任务与 mcppls 命令桥接正确，但不冒充真实 LSP 语义测试。

---

# Task 7：补真实 mcppls 契约与跨工具链验收

**Files:**
- Create: `test/e2e/suite/mcppls-contract.test.ts`（opt-in）
- Modify: `test/e2e/runTest.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Create: `test/e2e/fixtures/mcpppls-project/`（如需要）

- [ ] **Step 1: 建立 opt-in 环境**

新增环境变量 `MCPP_E2E_REAL_MCPPLS=1`。默认 E2E 不下载、不运行真实 payload；专用 CI job 或人工验收设置该变量。

- [ ] **Step 2: 验证 mcpp 工程**

在 mcpp 工程中验证：

- Language Status Item 出现并最终 ready/degraded，而非 error；
- `import` 补全、模块定义跳转、hover、references；
- GCC 与 LLVM 至少各一个 fixture；
- build 前后 module graph/status 变化；
- mcpp 任务完成后 mcppls 重启且重新加载。

- [ ] **Step 3: 验证降级**

- 无 `compile_commands.json`；
- mcpp 版本低于 `2026.9.15.1`；
- `mcpp.path` 自定义且 mcppls 仍从 PATH 找 mcpp；
- 非受信任 workspace；
- mcppls 依赖被禁用。

每种情况都只验证明确状态/提示，不把环境差异误报成 mcpp-vscode 构建失败。

- [ ] **Step 4: 记录平台结论**

CI 至少覆盖 `ubuntu-24.04 x64` 与 `macos-14 arm64`；Windows 可在 release 前人工/自托管 runner 验证。`darwin-x64` 在上游发布前写“不支持”。

**Gate:** 真实 mcppls 测试通过，四个公开转发命令和 build 后重启均可用。

---

# Task 8：设置、旧命令与兼容迁移

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`
- Modify: `test/artifacts.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 明确 `mcpp.path` 的作用域**

保留 `mcpp.path`，但文档写清：它只控制 mcpp-vscode 自己的 CLI；mcppls 的 `--mcpp` 当前只能从其自己的启动参数获得，本插件不能跨扩展写 `mcppls.*` 配置。

向上游提一个独立 issue/change request：增加 `mcppls.mcpp` 或由 extension 启动时把当前 mcpp-vscode 设置传给 server。上游支持前，不做同步写配置的隐式耦合。

- [ ] **Step 2: 移除旧 mcpp 设置的功能描述**

- `mcpp.clangd.path` → deprecationMessage；
- `mcpp.modulesSupport` → deprecationMessage；
- `mcpp.configureCppTools` → deprecationMessage；
- 不自动删除用户值；
- mcppls 自己管理官方 clangd/cpptools 冲突。

- [ ] **Step 3: 决定旧命令 ID 的最终形态**

本版本注册旧 `mcpp.configureClangd` 为 `mcpp.configureLanguageServer` 的弃用 alias；alias 进入 artifact test，且不得再读取 clangd 配置。

- [ ] **Step 4: 写升级说明**

README 说明：

- 安装本插件会自动安装 `sunrisepeak.mcpp-language-server`；
- 不再需要官方 `llvm-vs-code-extensions.vscode-clangd`；
- `clangd.*`、`mcpp.clangd.*` 不再生效；
- mcppls 自带服务端与语义 payload；
- mcpp 仍负责 build/run/test/toolchain；
- 旧设置可保留但应手动删除；
- `mcpp.path` 的作用域限制。

**Gate:** 新安装、已有 clangd 用户、GCC/MSVC 用户都能从 README 找到下一步。

---

# Task 9：文档、发布与清理门禁

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `test/artifacts.test.ts`

- [ ] **Step 1: 重写 README 能力矩阵**

删除“仅 LLVM 支持模块语义”的旧结论。区分两层：

| 能力 | 负责方 |
| --- | --- |
| mcpp 工程发现、build/run/test、工具链 | mcpp-vscode |
| C++ 模块诊断、补全、跳转、引用、状态、模块图 | mcppls |
| mcpp.toml 补全 | mcpp-vscode |
| 官方 clangd 扩展配置 | 不再由 mcpp-vscode 管理 |

GCC/MSVC 的支持程度引用 mcppls 自己的当前文档，不在 mcpp-vscode 复制一套可能过时的能力矩阵。

- [ ] **Step 2: 更新故障排查**

删除 clangd revision、PCM mismatch、llvm-tools 安装、`mcpp.clangd.path` 的主流程。新增：

- mcppls 没安装/被禁用；
- mcppls 平台不受支持；
- mcpp 版本太旧；
- build 后语言服务没有刷新；
- `mcpp.path` 与 mcppls 所见 PATH 不同。

- [ ] **Step 3: 发布前完整验证**

```sh
npm ci
npm run compile
npm test
npm run package
unzip -t "$VSIX"
npm run test:e2e
```

真实语义 gate：

```sh
MCPP_E2E_REAL_MCPPLS=1 npm run test:e2e
```

- [ ] **Step 4: 发布依赖完整性**

在干净 extensions 目录安装打包 VSIX，列出扩展，确认 mcppls 被拉取。记录 mcppls 最低/推荐版本；暂不写死具体 patch 版本，发布时锁定已在 CI 验证的版本。

- [ ] **Step 5: 最终残留审计**

```sh
rg -n -i 'clangd|compile_commands|PCM|llvm-tools' \
  src test package.json README.md CHANGELOG.md
```

允许命中：迁移说明、CHANGELOG 历史、mcppls 自带语义引擎的事实说明。禁止命中：活动依赖、命令执行、设置写入、状态判断。

- [ ] **Step 6: 发布检查**

- package version / lock / CHANGELOG / tag 一致；
- VSIX 中无 payload、无第二个 LSP client；
- 官方 clangd 扩展不再是依赖；
- Marketplace/Open VSX 安装路径已验证；
- 四个上游发布平台与本项目 CI 覆盖差异在 release note 中明示；
- `darwin-x64` 有明确支持决定。

---

## 推荐提交顺序

1. `manifest + tests`：只切依赖与引擎版本；
2. `language-server bridge + unit tests`；
3. `task coordination + E2E stub`；
4. `module setup rewrite`；
5. `delete clangd layer`；
6. `real mcppls contract tests`；
7. `docs/settings/release gates`。

每个提交保持可编译；不把“删 1000 行 clangd 代码”和“改一键向导”混在同一个提交。

## 完成定义

只有同时满足以下条件，迁移才算完成：

- 本插件只依赖 mcppls，不依赖官方 clangd 扩展；
- 本插件不启动第二个 LSP、不打包 payload；
- build/run/test/toolchain/TOML 补全原有行为保持；
- build 后能可靠刷新 mcppls；
- mcppls 缺失时提示明确且不崩溃；
- 旧 clangd 设置不再被读取或写入；
- Node、package、Extension Host、真实 mcppls 跨工具链测试通过；
- 干净 VSIX 安装会自动获得 mcppls；
- README、CHANGELOG、版本与发布资产一致。

## 已知阻塞与决策点

1. **`darwin-x64` 无上游包。** 在上游发布前，mcpp-vscode 不能宣称支持 Intel macOS。
2. **上游成熟度低。** `0.0.4` 且协议 Draft；发布门槛必须是真实 mcppls conformance/E2E，而不是只跑 manifest 测试。
3. **`mcpp.path` 作用域。** 本插件不能可靠传给 mcppls；先公开限制，再推动上游正式设置。
4. **mcppls 仍内部使用 clangd。** “放弃 clangd 依赖”指放弃官方 clangd 扩展和用户 clangd 配置，不指移除 mcppls payload 内固定语义引擎。
5. **构建后刷新只能先 restart。** 公开 `mcppls.reloadBuildDescription` VS Code 命令尚未贡献；不要从本插件伪造 LSP 请求。

## 后续：Task 7 真实语义验收

Task 7 不是代码阻塞项。LLVM 22.1.8 已在当前 darwin-arm64 环境使用真实
`sunrisepeak.mcpp-language-server@0.0.4` VSIX 和真实 mcpp 工程完成过一次空诊断、定义、悬停、
引用和补全验证；重复运行时 references 查询曾超时，因此需在 CI 中重复验证。GCC 16 fixture
需要 Linux runner：当前 `xim:gcc@16.1.0` 没有 macOS build，无法在本机诚实宣称跨工具链完成。
在 GCC/Linux 验收前，不把“LLVM 与桥接通过”等同于“C++ 模块语义已在所有工具链和平台验证通过”。
