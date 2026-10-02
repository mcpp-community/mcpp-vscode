## 0.6.0 - 2026-10-02

The sidebar was reorganised around one rule: **the body shows state, the actions sit
next to it, and the two are visually separate.**

### Changed

- **Three views instead of four**: 工程 / mcpp 库生态 / 缓存. The C++ Modules view is
  gone as a view; its state is now one row inside 工程 → 基本信息, collapsed by
  default. **The collapsed row always carries a status icon**, so a degraded language
  service is visible without expanding it.
- **The project view** is two labelled sections: 基本信息 (identity, target, toolchain,
  dependencies, the language service) and 常用命令 (build/run/test/clean/toolchain/
  search-and-add/self-check/settings, each with its keybinding).
- **Dependencies are shown as two levels**: what `mcpp.toml` declares, and the version
  `mcpp.lock` resolved for it. No connector lines — `mcpp.lock` has no parent/child
  edges, and drawing them would be inventing a tree.
- **The cache view is a sidebar webview**, not an editor tab. 项目缓存 is always
  visible; 全局缓存 is collapsed and shows its summary on one line. One 6px bar and a
  single-line legend replace the previous stack.
- **The activity bar can be switched off** with `mcpp.views.enabled`; the icon
  disappears with the last visible view.
- The extension icon is now mcpp's official logo — the same file the C++ Modules
  extension uses.

### Added

- **mcpp 库生态** — browse the package index already on this machine, offline:
  search, namespace and surface filters, `已添加` / `有更新` state, and a per-package
  detail page in the editor with the real **example code** the index's CI builds and
  runs (172 example projects), the version matrix per platform, licence, repository and
  a one-click **mcpp add** — which is the only thing that writes `mcpp.toml`.
- Searching the *other* registries is a separate switch, `mcpp.library.networkSearch`,
  **off by default**: that tier runs `mcpp search`, which may use the network and can
  only be read from human output on a best-effort basis.
- Labels use the official index site's own vocabulary — `import` / `#include` / `tool`
  / 上游 mcpp.toml — read from `mcpp xpkg parse --json`, so the editor and the site say
  the same thing.

> From 0.5.0 on, entries are written in English. Earlier entries remain as they
> were written.

## 0.5.0 - 2026-10-02

A groundwork release: the extension now says what it is doing, in the user's
language, and every claim about mcpp or the C++ Modules extension is checked by a
test or a generated snapshot rather than by a comment.

### Added

- **Three views** under a new `mcpp` Activity Bar container: **Project** (identity,
  toolchain, targets and the build/run/test buttons), **Cache** (project artifacts
  and the shared build cache, with its size, age distribution, largest packages
  and incomplete entries) and **C++ Modules** (the language service's state,
  issues and every action, forwarded to `sunrisepeak.mcpp-language-server`).
- **A settings panel** (`mcpp: Open Settings Panel`) built from a single registry:
  search, "only modified", per-section collapse, four presets, each row showing
  where its value comes from, when it takes effect, and a link to the native
  Settings editor.
- **64 settings**, 29 of them public and the rest behind "show advanced". A new
  `data/config-registry.json` is the single source of truth; `package.json` and
  `docs/settings.md` are held to it by CI.
- **Cache cleanup as a table of plans**, with five levels of confirmation: reading
  is free, `mcpp clean` asks once, `--stale`/`gc`/`prune` show a preview first,
  `mcpp cache clean --all` additionally requires an explicit acknowledgement naming
  every project on the machine, and emptying the shared cache during a project
  clean is a separate, unticked choice.
- **`mcpp: Environment Self-check`**: one copyable snapshot of every version, the
  mcpp protocol and advertised kinds, each C++ Modules capability and its fate,
  the cache figures and every setting changed from its default.
- **`build.mcpp` intelligence** without a language server: completion and hover for
  the 31 build directives and the five action roles, snippets, document symbols and
  seven static SPEC-007 diagnostics, generated from mcpp's own directive table.
  `import std;` and `import mcpp;` are recognised and never reported as missing —
  measured behaviour, see `docs/build-script.md`.
- **`mcpp.toml` editing**: key completion, enum values, hover with the type, default,
  plane and legacy advice, seven manifest diagnostics and navigation for
  `workspace = true`, `path = …` and `features = […]`.
- **English and Chinese**: every command title, setting and runtime message follows
  the editor's language. `mcpp.ui.language` can override the runtime messages and
  our panels; the Command Palette and the Settings UI always follow VS Code.

### Changed

- User-visible strings in `package.json` are now `%nls%` references; the text lives
  in `package.nls.json` and `package.nls.zh-cn.json`.
- Activation is narrower: the `onCommand:*` events are gone (VS Code derives them
  from `contributes.commands` since 1.74), as is `onLanguage:cpp`.
- `mcpp template`-free: `mcpp: Clean` is now `mcpp: Clean Project Artifacts`, and
  the language-service commands moved under the `mcpp.languageServer.*` namespace.

### Fixed

- The toolchain inventory is read from `mcpp toolchain list --format json` when mcpp
  speaks the machine-output protocol, instead of scraping the human table — the
  human table no longer prints the line the old parser depended on.
- A failing C++ Modules call can no longer be mistaken for a failing mcpp build, and
  a command that a newer or older mcppls does not offer is remembered and hidden
  rather than retried on every click.

### Removed

- `src/configureOnly.ts` and `src/ideWorkflow.ts`: dead since 0.4.0 moved the build
  database to the language service, and at odds with the documented boundary.

### Migration

Nothing has to be changed by hand. Every 0.4.x command id and setting key still
works: the old language-service ids forward to the new ones, `mcpp.clean` is an
alias of `mcpp.cleanProjectArtifacts`, and `mcpp.tomlCompletion` is read as
`mcpp.toml.completion` with a one-time offer to move the value.

## 0.3.1 - 2026-08-11

- 修复缺少 CDB 时 IDE 命令看似无响应的问题：配置 clangd、刷新编译数据库、检查模块支持和一键配置现在会立即显示进度并打开 `mcpp` 输出频道；clangd 重启与 `mcpp build --configure-only` 增加超时，避免异步操作永久占用 IDE 队列。
- 增加删除 `compile_commands.json` 后刷新 CDB、配置 clangd、检查模块支持和一键配置的 Extension Host 回归测试。

## 0.3.0 - 2026-08-11

- 将编译数据库刷新迁移到 `mcpp build --configure-only`：不解析 stdout 人类文本，以退出码
  和可解析 CDB 作为成功条件，失败时保留 last-known-good CDB。
- 删除旧 `mcpp ide configure --format ndjson` 解析层和重复的 `mcpp.configureIde` 命令；
  configure-only 与 build/run/test 共用项目操作锁，manifest 与 `mcpp.path` 变化按工程协调。
- CDB watcher 只重读已发布数据库，不反向触发 configure-only；多根工作区按事件 URI 路由，
  显式刷新会分别报告 CDB 生成与 clangd 协调结果。
- 对齐 mcpp #387 的最终 workspace 契约：virtual workspace 根不作为单一 clangd 工程，
  扩展消费当前活动 member 根的 CDB；rooted workspace 仍按根 package 处理。
## 0.4.0 - 2026-09-26

### Changed

- 将 C++ 模块语言服务依赖从官方 `llvm-vs-code-extensions.vscode-clangd` 切换为
  `sunrisepeak.mcpp-language-server`（C++ Modules Language Server / mcppls）；VS Code 最低版本
  提升到 1.91。
- 删除本扩展中的 clangd 解析、匹配、配置、PCM 检查、CDB 监听和自动重启逻辑。mcpp-vscode
  不再启动第二个 LSP 客户端，也不再打包语言服务 payload。
- mcpp build 完成后只通过 mcppls 公开命令刷新语言服务；新增模块图、语言服务日志和分析
  上下文转发命令。
- 一键模块配置改为一次确认后执行 `mcpp build` 并刷新 mcppls，不再安装 llvm-tools、切换
  LLVM 全局默认或修改 clangd 配置。

### Fixed

- 移除 mcpp 已删除的 `[xlings.envs]` manifest 补全，并将 `[xlings.workspace]` 示例版本更新为
  当前索引可用的 Node 条目。

## 0.2.7

- 修复「一键配置模块代码提示」在标准 mcpp 安装（install.sh / AUR）下无法发现 mcpp 内置
  xlings 的问题：xlings 发现以 `mcpp self env` 为权威来源（项目级契约），路径探测仅作回退；
  为 `mcpp self env` 调用增加超时保护，并补齐测试（PR #11）。

## 0.2.6

- 新增 **mcpp: 一键配置模块代码提示** 向导：按「安装/切换工具链 → 构建 → 重载 → clangd
  配置 → 模块检查」链恢复 IDE，支持取消与失败降级；仅在受信任工作区执行（issues #6/#7，
  PR #10）。
- 新增 `mcpp.toml` 结构补全：段头 snippet（26 段）与依赖/feature 等写法模板，所有建议
  携带显式替换范围并经真实 mcpp 契约测试；由 `mcpp.tomlCompletion` 设置控制（默认开启），
  未受信任工作区仅纯文本分析（PR #9）。

## 0.2.5

- 编辑器标题栏的 mcpp 运行/测试操作按当前活动文件所属的 mcpp member 作用域执行；工作区外
  打开的文件不会显示这些按钮。
- 将状态栏快捷菜单名称明确为 `$(tools) mcpp: 快捷菜单`，与模块可用性状态按钮区分。

## 0.2.4

- 修复 hermetic mcpp 编译数据库被插件追加 `--query-driver` 后导致的 clangd 标准库和
  模块误诊断；仅在编译命令未自带 `--no-default-config`、`-nostdinc++` 和显式 libc++
  路径时补充 query driver。
- 模块检查优先选择项目源码，避免误选 `.mcpp` 依赖缓存或 `target` 生成源码，改善补全、
  跳转和诊断稳定性。
- 将 `build.mcpp` 作为独立的语法高亮语言处理，不再让 clangd 把 mcpp 构建脚本当作普通
  C++ 翻译单元。

## 0.2.3

- 为精确文件名 `build.mcpp` 增加 C++ 语言关联，复用 VS Code 内置 C++ 高亮和现有模块
  语法注入；不扩大到所有 `*.mcpp` 文件。
- 为精确文件名 `mcpp.toml` 内置独立 TOML 语法高亮，不依赖额外扩展，也不接管普通
  `*.toml` 文件。

## 0.2.2

- 新增 **mcpp: 一键配置模块代码提示**：自动检测匹配的 clangd，缺失时通过 xlings 下载
  对应版本的 llvm-tools，配置 clangd 并刷新模块状态，无需重启 VS Code。
- 检测 PCM 版本不匹配（`ast_file_version_too_new`、`ast_file_version_too_old`、
  `ast_file_different_branch`），并在诊断信息中引导一键配置。
- 非 LLVM 工具链（GCC/MSVC）项目提供清晰的引导说明而非催促安装：状态栏点击弹出
  QuickPick，一键配置向导显示原因并提供工具链安装/选择入口。
- 优化编辑器标签切换性能：相同工程内切换文件不再重复协调 clangd。
- 序列执行器使用 AsyncLocalStorage 范围标记替代全局深度计数，修复不相关并发调用
  绕过队列的问题。
- 完善 xlings 检测：检查 PATH 中是否实际存在 xlings 而非无条件返回路径名，确保
  未安装时的引导分支可达。

## 0.2.1

- 修复项目任务已经结束后，clangd/CDB 重协调仍占用项目锁，导致下一条 CLI 命令误报
  “已有 mcpp 操作正在运行”的问题。
- 增加 GitHub tag Release 工作流：校验 tag 与扩展版本，运行测试和打包，并发布 VSIX
  及其 SHA-256 校验文件。

## 0.2.0

- 新增 `$(tools) mcpp` 状态栏快捷菜单和命令面板命令：构建、运行、测试、清理 target、
  查看工具链、安装工具链、选择全局默认工具链。
- 项目任务使用 VS Code 的无 shell `ProcessExecution`，显示实时任务终端；同一工程任务
  互斥，工具链安装/默认值操作共享全局锁，取消不会误报成功。
- 项目任务结束后复用 CDB/clangd 自动协调；`mcpp.refreshCompilationDatabase` 与构建
  命令共用同一任务路径，避免并发写入工程构建目录。
- 按 mcpp 官方工具链契约解析 `Toolchains:`、`System:`、`Targets:` 和可安装列表：
  toolchain 与 target 分轴处理，首版 UI 不提供结构化 `--target` 选择器。
- 全局默认选择过滤普通 target-only payload，保留 mcpp 在 Windows 上将 host GCC 映射到
  MinGW payload 的官方规则，并明确设置 host 默认会清空 `default_target`；
  安装入口接受省略版本和 namespace，把兼容 spec 安全规范化为单个参数后交给 mcpp 最终解析；
  MSVC 走系统检测，已知 target 别名走对应 payload，泛化 triple 由 mcpp 校验。
- 工具链安装和全局默认修改均需要用户确认；Restricted Mode 不执行 mcpp 或其他外部工具。

## 0.1.5

- 打开已有编译数据库的 LLVM mcpp 工程时自动执行 `clangd --check`，状态栏无需点击即可显示“模块可用”或“模块不可用”。
- 编译数据库创建或变化后自动重新检查模块支持；工程内合并重复事件，共享 clangd 操作全局串行，只允许当前活动工程接管窗口级配置，并且只接受最新检查结果。
- 修改 `mcpp.clangd.path` 或模块支持模式后自动复查，并为直接 clangd 检查增加 60 秒超时。
- 收紧 Restricted Mode：未受信任工作区不执行 CDB 编译器、mcpp 或 clangd，也不修改 clangd 配置；授予信任后自动协调。
- 补充独立安装 mcpp 的配置说明；`mcpp.path`、CDB 中的编译器与 `mcpp.clangd.path` 相互独立，`clang-tidy` 和 `clang-format` 不是当前扩展的运行依赖。

## 0.1.4

- 缺少编译数据库时，状态栏改为直接执行“刷新编译数据库”；CDB 创建或变化后会自动重新配置并重启 clangd，不再要求重载窗口。
- 增加 `mcpp.path` 设置，允许 macOS GUI 环境显式指定 mcpp 可执行文件。
- `mcpp build` 失败后仍会检查现有 CDB；IDE 配置成功与构建失败分别提示，不再误报 clangd 已刷新。
- Restricted Mode 下不会执行 `mcpp build`、依赖安装或 `build.mcpp`。
- 在 README 中记录无需正式构建即可获得模块语义能力的长期核心接口、CDB 合同和插件演进计划。

## 0.1.3

- 修复 C++ 模块语法未实际注入 `source.cpp` 的问题，`import`、模块名和模块分区现在会使用扩展提供的 TextMate scope。
- 增加扩展清单回归测试，防止语法注入注册字段再次写错。

## 0.1.2

- 在扩展激活和刷新编译数据库时自动配置匹配的 clangd，避免官方 clangd 扩展启动到 xlings shim。
- 模块语法高亮支持未输入分号的编辑中间态，并补充 `.mpp`、`.ccm` 文件关联。
- 避免重载窗口期间异步检查向已关闭的输出频道写入。

## 0.1.1

- 修复 `clangd.arguments` 中 `${workspaceFolder}` 未解析导致 clangd 忽略编译数据库的问题。
- 从 mcpp 的 `.mcpp` 工具链路径自动查找用户目录下 `.xlings` 中匹配版本的 clangd。

## 0.1.0

- 为 LLVM 后端的 mcpp 工程配置官方 clangd 扩展。
- 通过直接执行 `clangd --check` 诊断 PCM 和工具链不匹配。
- 将 GCC、MSVC 模块工程降级为语法高亮，并显示明确的能力提示。
- 增加覆盖声明、导入、模块名和分区的 C++ 模块注入语法。
