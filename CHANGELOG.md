# 更新日志

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
  安装入口把 mcpp 兼容 spec 原样传给 CLI，MSVC 走系统检测，隐含 target 的别名走对应 payload。
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
