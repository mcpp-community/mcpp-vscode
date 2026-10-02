<p align="center">
  <img src="images/logo.png" width="160" alt="mcpp 标志">
</p>

# mcpp for VS Code

[English](README.md) | 简体中文

这是 [mcpp](https://github.com/mcpp-community/mcpp)（C++23 构建工具）的 VS Code 前端：
发现 mcpp 工程，把 `mcpp build` / `run` / `test` / `clean` 作为 VS Code 任务运行，管理工具链，
为 `mcpp.toml` 与 `build.mcpp` 提供编辑帮助，并展示共享构建缓存的占用与清理。C++ 模块语义
——诊断、补全、悬停、定义、引用、模块图——**不由本扩展实现**，它们来自
`sunrisepeak.mcpp-language-server`；本扩展不会自行启动 LSP 客户端。

## 职责边界

| 领域 | 负责方 |
| --- | --- |
| mcpp CLI、工程发现、build/run/test/clean 任务、工具链 | mcpp-vscode |
| `mcpp.toml` 与 `build.mcpp` 编辑、缓存视图与清理命令 | mcpp-vscode |
| 设置注册表、设置面板、环境自检、`mcpp` 输出频道 | mcpp-vscode |
| C++ 模块诊断、补全、悬停、定义、引用、模块图、缓存重置、自带 clangd/状态栏项/输出频道 | `sunrisepeak.mcpp-language-server` |

本扩展的「C++ Modules」视图只**展示**对方的状​​态并**转发**对方的命令。详见
[docs/architecture.md](docs/architecture.md)。

## 安装

从 [GitHub Releases](https://github.com/mcpp-community/mcpp-vscode/releases) 下载 VSIX，使用
**Extensions: Install from VSIX...**，或者执行
`code --install-extension mcpp-vscode-0.5.0.vsix`。

`package.json` 声明了 `extensionDependencies: ["sunrisepeak.mcpp-language-server"]`，因此在有对应
平台包的机器上 VS Code 会自动安装它。该字段只接受扩展 ID——无法固定版本范围
（[docs/compatibility.md](docs/compatibility.md)）。

| 平台 | mcppls 包 | 本扩展 |
| --- | --- | --- |
| `linux-x64`、`linux-arm64`、`darwin-arm64`、`win32-x64` | 有 | 可用 |
| `darwin-x64`、`win32-arm64` | 无包 | 不会被激活 |

## 快速开始

1. 打开包含 `mcpp.toml` 的文件夹（或运行 **mcpp: 新建工程**）。
2. 运行 **mcpp: 构建**（`mcpp.build`）；它会在专用任务终端里执行。
3. 打开活动栏的 **mcpp** 容器，查看 **工程**、**缓存** 与 **C++ Modules** 三个视图。

打开工程本身不会执行 `mcpp`，也不会下载或切换工具链。

## 功能

- **mcpp CLI 与任务** —— 构建、运行、测试、清理、快捷菜单、工具链：[docs/commands.md](docs/commands.md)。
- **`mcpp.toml` 编辑** —— 结构补全与七条结构诊断：[docs/mcpp-toml.md](docs/mcpp-toml.md)。
- **`build.mcpp` 智能** —— 补全、悬停、七条 SPEC-007 诊断，且永不误报「模块找不到」：[docs/build-script.md](docs/build-script.md)。
- **缓存视图与清理** —— 工程产物与共享缓存，删除前一律先给出预览：[docs/cache.md](docs/cache.md)。
- **C++ Modules 视图** —— 对方扩展的状态与操作集中在一处，只转发不重写：[docs/commands.md](docs/commands.md)。
- **设置与诊断** —— 由注册表驱动的设置面板与可复制的环境自检：[docs/settings.md](docs/settings.md)。

## 命令

每个贡献命令的 ID、文案 key 与行为都在 [docs/commands.md](docs/commands.md) 中。常用的：

| 命令 ID | 作用 |
| --- | --- |
| `mcpp.showMenu` | 用一个选择器汇总工程、工具链、缓存与 C++ Modules 操作 |
| `mcpp.build` / `run` / `test` / `clean` | 运行对应的 mcpp 任务 |
| `mcpp.installToolchain`、`mcpp.selectDefaultToolchain` | 交给 mcpp CLI 执行 |
| `mcpp.openSettings` | 本扩展自己的设置面板 |
| `mcpp.showCachePanel`、`mcpp.cleanStaleArtifacts`、`mcpp.cleanProjectArtifacts` | 缓存摘要与两级工程清理 |
| `mcpp.languageServer.restart`、`mcpp.selfCheck` | 转发给对方扩展；可复制的自检快照 |

## 设置

全部 64 项设置的类型、默认值、作用域与生效时机见 [docs/settings.md](docs/settings.md)。设置面板
（**mcpp: 打开设置面板**，`mcpp.openSettings`）按组展示生效值与来源，并链接到原生设置页；它
**不取代**原生设置页。有若干已声明的设置当前还不会被运行时代码读取；下文各页会点出与它相关的
那些。
`mcpp.ui.language` 只覆盖**本扩展的**运行时提示与面板：命令面板标题与设置项名称始终跟随
VS Code 的显示语言，因为 VS Code 在启动时只解析一次 `package.nls.*`
（[docs/architecture.md](docs/architecture.md#language)）。

## 编辑 `mcpp.toml` / `build.mcpp`

`mcpp.toml`：在 `[` 处按 mcpp 的 schema 补全段、键与枚举值，悬停显示类型／默认值／平面／
`since`，跳转覆盖 `workspace = true`、`path = "…"` 与 `features = […]`，并有七条诊断
（语法、未知段、未知键、平面混用、`mcpp` 下限、legacy 键、数组表），**不做**格式化。
悬停与跳转各由 `mcpp.toml.hover` / `mcpp.toml.navigation` 控制——
[docs/mcpp-toml.md](docs/mcpp-toml.md)。

`build.mcpp`：为 `mcpp::…` 与 `import` 提供补全，为已知模块提供悬停，七条 SPEC-007 诊断。
`std`、`std.compat` 与 `mcpp.*` 的导入永不被报缺失；也没有它们内部的符号级补全——
[docs/build-script.md](docs/build-script.md)。

## 故障排查

- [C++ Modules 视图提示依赖缺失](docs/troubleshooting.md#c-modules-视图提示依赖缺失)
- [语言服务一直停在“暂无状态”](docs/troubleshooting.md#语言服务一直停在暂无状态)
- [命令提示该操作不被提供](docs/troubleshooting.md#命令提示该操作不被提供)
- [找不到 mcpp（`mcpp.path` 与 `PATH`）](docs/troubleshooting.md#找不到-mcpp)
- [构建结束了但语言服务没有刷新](docs/troubleshooting.md#构建结束了但语言服务没有刷新)

先看 **mcpp** 输出频道，再看 **mcpp: 环境自检**（`mcpp.selfCheck`）。更多内容见
[docs/troubleshooting.md](docs/troubleshooting.md)。

## 开发

`npm ci`、`npm run compile`、`npm test`、`npm run test:e2e`、`npm run package`，以及
`node tools/dev-profile.mjs`（在 `.dev-profile/` 下建一个临时 profile，不会碰你自己的）。
`npm test` 先跑 `npm run check`——`tools/check-config.mjs`、`tools/l10n-check.mjs` 与
`tools/check-generators.mjs`——再对 `dist/test` 执行 `node --test`。只有存在 mcpp 检出
（`MCPP_REPO`，默认 `../mcpp`）时快照漂移门禁才会真正比对，否则会打印提示并跳过。

发布：把 `package.json` 与 `package-lock.json` 的版本号改好并提交，然后推送与版本完全一致的
tag。`.github/workflows/release.yml` 会校验 tag、运行测试、打包 VSIX、生成 SHA-256 文件并创建
GitHub Release。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
