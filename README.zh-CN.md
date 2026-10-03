<p align="center">
  <img src="media/logo.png" width="160" alt="mcpp 标志">
</p>

# mcpp for VS Code

[English](README.md) | 简体中文

[mcpp](https://github.com/mcpp-community/mcpp)（C++23 构建工具）的 VS Code 前端：发现 mcpp
工程，把 `mcpp build` / `run` / `test` / `clean` 作为 VS Code 任务运行，管理工具链，为
`mcpp.toml` 与 `build.mcpp` 提供编辑帮助，浏览包库生态，并展示构建缓存的占用与分级清理。
C++ 模块语义——诊断、补全、悬停、定义、引用、模块图——来自
`sunrisepeak.mcpp-language-server`；本扩展不会自行启动 LSP 客户端，对它只**转发**不重写
（[docs/architecture.md](docs/architecture.md)）。

## 相关项目

| 项目 | 是什么 | 入口 |
| --- | --- | --- |
| [mcpp](https://github.com/mcpp-community/mcpp) | 本扩展驱动的 C++23 构建工具 | — |
| [mcpp-language-server](https://github.com/Sunrisepeak/mcpp-language-server) | C++ Modules 语言服务；本扩展的硬依赖 | [Marketplace](https://marketplace.visualstudio.com/items?itemName=sunrisepeak.mcpp-language-server) · [Open VSX](https://open-vsx.org/extension/sunrisepeak/mcpp-language-server) |
| mcpp-vscode（本扩展） | VS Code 前端 | [Marketplace](https://marketplace.visualstudio.com/items?itemName=mcpp-community.mcpp-vscode) · [Open VSX](https://open-vsx.org/extension/mcpp-community/mcpp-vscode) · [Releases](https://github.com/mcpp-community/mcpp-vscode/releases) |

## 安装

三个渠道装到的是同一个扩展：

- **Marketplace**：点上面的链接，或在 VS Code 里搜索 "mcpp"。
- **Open VSX**：点上面的链接（VSCodium、Gitpod 等；自 0.6.0 起上架）。
- **GitHub Releases**：下载 VSIX 后用 **Extensions: Install from VSIX...**，或执行
  `code --install-extension mcpp-vscode-<version>.vsix`。

`package.json` 声明了 `extensionDependencies: ["sunrisepeak.mcpp-language-server"]`，因此在有
对应平台包的机器上 VS Code 会自动安装它——该字段只接受扩展 ID，无法固定版本范围
（[docs/compatibility.md](docs/compatibility.md)）。

| 平台 | mcppls 包 | 本扩展 |
| --- | --- | --- |
| `linux-x64`、`linux-arm64`、`darwin-arm64`、`win32-x64` | 有 | 可用 |
| `darwin-x64`、`win32-arm64` | 无包 | 不会被激活 |

## 快速开始

1. 打开包含 `mcpp.toml` 的文件夹（或运行 **mcpp: 新建工程**）。
2. 运行 **mcpp: 构建**（`mcpp.build`）；它会在专用任务终端里执行。
3. 打开活动栏的 **mcpp** 容器：**工程**、**库生态** 与 **缓存**（默认折叠）；C++ Modules 的
   状态与操作在 **工程 → 基本信息** 里。

打开工程本身不会执行 `mcpp`，也不会下载或切换工具链。

## 功能

- **mcpp CLI 与任务** —— 构建、运行、测试、清理、快捷菜单、工具链：[docs/commands.md](docs/commands.md)。
- **`mcpp.toml` 编辑** —— 结构补全、悬停、跳转与七条结构诊断，不做格式化：[docs/mcpp-toml.md](docs/mcpp-toml.md)。
- **`build.mcpp` 智能** —— `mcpp::…` 与 `import` 的补全悬停、七条 SPEC-007 诊断，且永不误报「模块找不到」：[docs/build-script.md](docs/build-script.md)。
- **库生态** —— 离线浏览本机已刷新的包索引；详情页展示真实示例代码、版本矩阵，以及工程是否已依赖它。
- **缓存视图与清理** —— 工程产物与共享缓存，删除前一律先给出预览：[docs/cache.md](docs/cache.md)。
- **C++ Modules** —— 对方扩展的状态与操作，集中在工程视图与状态栏快捷菜单，只转发不重写：[docs/commands.md](docs/commands.md)。
- **设置与诊断** —— 注册表驱动的设置面板（`mcpp.openSettings`）与可复制的环境自检（`mcpp.selfCheck`）：[docs/settings.md](docs/settings.md)。`mcpp.ui.language` 只覆盖本扩展的运行时提示与面板；命令面板标题始终跟随 VS Code（[docs/architecture.md](docs/architecture.md#language)）。

## 故障排查

先看 **mcpp** 输出频道，再运行 **mcpp: 环境自检**（`mcpp.selfCheck`）。常见情形——依赖缺失、
语言服务停在「暂无状态」、`mcpp.path` 与 `PATH`、构建结束后语言服务没刷新——见
[docs/troubleshooting.md](docs/troubleshooting.md)。

## 开发

`npm ci`、`npm run compile`、`npm test`（先门禁后单测）、`npm run test:e2e`、
`npm run package`，以及 `node tools/dev-profile.mjs`（在 `.dev-profile/` 下建一次性 profile，
不会碰你自己的）。

发布：把 `package.json` 与 `package-lock.json` 的版本号改好并提交，推送与版本完全一致的
tag。工作流会跑测试、打包同一只 VSIX，并把它发到 GitHub Releases 与 Open VSX——Marketplace
在配置了 token 时同样自动发布。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
