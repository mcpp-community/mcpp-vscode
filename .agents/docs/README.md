# .agents/docs

本目录存放 **面向贡献者与 agent 的设计/背景文档**：对 mcpp-vscode 当前架构、跨仓库契约
与决策的记录。使用说明请看仓库根目录的 `README.md`。

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| [`architecture.md`](architecture.md) | mcpp-vscode 的分层结构、模块职责与扩展点 | 现状 |
| [`mcpp-integration.md`](mcpp-integration.md) | 与 `mcpp-community/mcpp`（mcpp CLI）的接口契约 | 现状 |
| [`mcppls-integration.md`](mcppls-integration.md) | 与 `sunrisepeak.mcpp-language-server`（mcppls）的依赖与命令桥接契约 | 现状 |
| [`2026-10-02-plugin-optimisation-plan.md`](2026-10-02-plugin-optimisation-plan.md) | 插件优化方案 **v4**：目录树与 README、mcppls 依赖韧性、稳定基座、`mcpp.toml` 与 `build.mcpp` 编辑体验、缓存统计与两级清理、配色与可视化、i18n、统一配置模块与配置面板、**mcppls 状态与管理（§3.9）** | **待评审** |

边界：

- `docs/`（仓库根）= **用户文档**（安装、命令、设置、排错）；
- `.agents/docs/` = **贡献者/agent 文档**（设计、契约、方案、决策）；
- `.agents/superpowers/` = **过程文档**（原 `docs/superpowers/`，plans/specs）；
- `.agents/reviews/` = **分析与评审记录**，已加入 `.gitignore`，不进入版本库。

背景分析见 `.agents/reviews/2026-10-02-mcpp-vscode-architecture-and-mcppls-dependency-review.md`。
