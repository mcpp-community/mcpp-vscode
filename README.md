# mcpp VS Code 扩展

本扩展把 mcpp 工程接入官方
`llvm-vs-code-extensions.vscode-clangd` 扩展。它不实现第二套语言服务器，
也不会改写 `compile_commands.json` 或模块文件。

## 首版范围

- LLVM/Clang mcpp 工程：配置匹配的 clangd，并直接检查 mcpp 编译数据库和
  PCM 文件。扩展激活时会自动把官方 clangd 扩展切换到匹配的真实可执行文件，
  不会继续使用未激活版本的 xlings shim。
- GCC 和 MSVC mcpp 工程：保留 C++ 模块语法高亮，并明确提示 `.gcm`、
  `.ifc` 不能由 clangd 消费。
- `.cppm`、`.ixx`、`.mpp`、`.ccm` 关联到内置 `cpp` 语言。注入语法规则覆盖 `module`、
  `export module`、`import`、`export import`、模块名和分区。

clangd 的 C++20 模块支持仍处于实验阶段。语法颜色正常不代表语义诊断可用。
clangd、mcpp 编译器、libc++ 和 PCM/BMI 应来自同一个 LLVM 构建；只匹配版本号
并不足够。

## 使用条件

1. VS Code 1.90 或更高版本。
2. 官方 `llvm-vs-code-extensions.vscode-clangd` 扩展。它是功能依赖，VS Code
   会随本扩展一起安装。
3. mcpp，以及包含 `mcpp.toml` 的 mcpp 工程。mcpp 可以由 xlings 安装，也可以使用
   官方独立安装脚本；扩展不依赖 mcpp 的安装来源。
4. 要获得模块语义诊断，需要 LLVM mcpp 工具链和匹配的 clangd。扩展会优先使用
   `mcpp.clangd.path`，否则依次查找编译器同目录、同一工具包根目录中的
   `xim-x-llvm-tools/<version>/bin`、从 `.mcpp` 工具链映射到用户目录下的
   `.xlings/data/xpkgs/xim-x-llvm-tools/<version>/bin`，最后查找 `PATH`。

mcpp 会把 `compile_commands.json` 写到工程根目录。扩展只读取它，不会修改它。

## 当前版本行为

1. 工程已有可用的 `compile_commands.json` 时，扩展激活后会分析其中的 LLVM
   编译器，选择匹配的 clangd，并应用工作区配置；随后自动执行一次 `clangd --check`，
   状态栏直接显示“模块可用”或“模块不可用”，不需要先点击状态栏按钮。
2. 工程缺少编译数据库时，状态栏显示“缺少模块 CDB”；在受信任工作区点击该状态
   会执行 **mcpp: 刷新编译数据库**。未受信任工作区只保留模块语法高亮，不会执行
   CDB 中的编译器、mcpp 或 clangd，也不会接管 clangd 配置。扩展在受信任工作区中
   也不会仅因打开工程而静默构建。
3. `compile_commands.json` 创建或变化后，扩展会自动重新分析、重启 clangd 并再次
   检查模块支持，不再要求手动点击检查按钮或 Reload Window。检查结果按工程缓存，
   工程内的重复事件会合并，所有共享 clangd 操作全局串行。多根工作区仅由当前活动
   mcpp 工程接管窗口级 clangd 配置；后台工程只失效缓存，切换过去时再自动配置，
   因此迟到检查不会覆盖当前工程状态。
4. 修改 `mcpp.clangd.path` 或 `mcpp.modulesSupport` 后，扩展会自动重新配置和检查。
   单次 `clangd --check` 最长等待 60 秒，避免异常进程让激活流程一直停住。
5. `mcpp build` 即使因普通源码错误返回非零，只要工程中已经出现可用 CDB，
   扩展仍会配置 clangd，并明确提示“构建失败，但 IDE 数据已就绪”。

## 命令

- **mcpp: 配置 clangd**：手动重新应用自动配置。命令会查找最近的工程，保留已有
  `clangd.arguments`，将其中的
  `${workspaceFolder}`/`${workspaceRoot}`解析为 mcpp 工程根目录，添加精确的 mcpp
  编译器 `--query-driver`，并应用模块支持策略。如果 cpptools IntelliSense 已启用，
  会先询问是否只关闭它的 IntelliSense 引擎。
- **mcpp: 刷新编译数据库**：在最近的工程中显式执行 `mcpp build`，随后无论构建
  是否成功都会重新读取 CDB；只要 CDB 和 clangd 可用，就会刷新配置并重启
  clangd。扩展激活时不会自动执行构建。
- **mcpp: 检查模块支持**：立即重新执行 clangd 直接检查，报告检查成功、模块文件
  缺失、语言模式错误或 PCM/LLVM 不匹配。扩展激活和 CDB 变化时已经会自动检查；
  此命令用于主动复查。完整输出位于 `mcpp` 输出频道。

## 设置

```json
{
  "mcpp.path": "/path/to/mcpp",
  "mcpp.clangd.path": "/path/to/matching/clangd",
  "mcpp.modulesSupport": "auto",
  "mcpp.configureCppTools": true
}
```

`mcpp.path` 只用于“刷新编译数据库”命令执行 `mcpp build`，用于解决 macOS GUI
启动的 VS Code 没有继承终端 `PATH` 的情况。留空时扩展直接执行 `mcpp`；也可以设置
独立安装的绝对路径，例如 `/opt/homebrew/bin/mcpp`。工程实际使用的编译器始终从
`compile_commands.json` 读取，与 `mcpp.path` 相互独立。

`mcpp.clangd.path` 只指定语言服务器。独立安装的 mcpp LLVM 工具链即使只包含
`clang`/`clang++`，也仍可配合其他位置的 clangd 使用；关键是 clangd、编译器和
PCM/BMI 来自同一 LLVM revision。可以单独安装 xlings 的 `xim-x-llvm-tools` 并让
扩展自动映射，也可以显式填写其他匹配的 clangd。当前版本不调用 `clang-tidy` 或
`clang-format`，缺少这两个工具不会影响模块诊断、悬停、补全和跳转。

`mcpp.modulesSupport` 可设为 `auto`、`on` 或 `off`。`auto` 检测到 mcpp CDB 已经
包含显式 `-fmodule-file`/`-fprebuilt-module-path` 时，会直接使用这些 PCM；否则
clangd 21 及更高版本会请求 `--experimental-modules-support`。`on` 强制启用 clangd
实验模块构建，`off` 始终禁用它。已有的 clangd 参数会保留；扩展只替换自己管理的
`--query-driver` 和实验模块参数。

## 限制

- clangd 模块实现仍处于实验阶段，编译数据库必须包含有效的 mcpp PCM 映射。单独
  添加开关不能生成缺失的 BMI。
- GCC `.gcm` 和 MSVC `.ifc` 是编译器专用产物。本版本不会为这两类工程额外构建
  LLVM 分析副本。
- 语法规则只负责词法着色。红色诊断来自语言服务器，需要兼容的 LLVM 工具链。
- 扩展不会静默执行无缓存构建，也不会自动下载工具链。
- 未受信任工作区不执行任何由工程文件或设置选择的外部工具；信任工作区后会自动开始
  配置和模块检查。

## 长期完整计划

### 理想最终效果

用户打开一个受信任的 mcpp 工程后，不需要先执行 `mcpp build`，也不需要 Reload
Window。扩展应自动读取 `mcpp.toml` 对应的工程模型，准备依赖和工具链，生成专供
IDE 使用的完整模块图、BMI/PCM 和 `compile_commands.json`，然后启动匹配的
clangd。即使普通源码暂时存在语法或编译错误，编辑器仍应具备：

- 对错误模块名和不可见模块给出诊断；
- 对模块导出的声明提供悬停、补全、查找引用和定义跳转；
- 在修改 `mcpp.toml` 后增量刷新依赖和模块图；
- 在没有网络时复用本机缓存和最后一次可用的 IDE 数据。

这应当接近 Cargo 与 rust-analyzer 的分工：构建工具提供稳定、可查询的工程模型，
语言服务器消费该模型；VS Code 扩展只负责生命周期、用户授权和状态展示，不在插件
中重新实现一套 mcpp TOML 解析器或包管理器。

### mcpp 核心需要提供的接口

mcpp 核心需要先提供带版本的机器可读协议，例如：

```sh
mcpp metadata --format-version=1
mcpp configure --ide --json
```

`metadata` 应稳定输出工作区成员、目标、源码、模块、依赖、工具链和缓存位置，不执行
构建。`configure --ide` 负责解析和下载依赖、准备工具链、处理 `build.mcpp` 与生成源、
扫描完整模块图、预编译语义分析所需的 BMI/PCM，并原子写入 IDE CDB；它不编译普通
实现源文件，也不链接最终可执行文件或库。命令需要结构化输出进度、诊断、产物路径和
可取消状态，不能要求插件解析面向人的终端文本。

IDE CDB 与模块图至少需要保证：

- 模块 producer 条目包含确定的 `-fmodule-output=<path>`；
- consumer 条目包含确定的 `-fmodule-file=<name>=<path>`，不依赖 clangd 猜测产物；
- 覆盖命名模块、模块分区、`std`、依赖包、工作区成员和测试目标；
- 编译器路径、语言标准、宏、包含目录、工作目录与正式构建一致；
- 先写临时文件再原子替换，失败时保留最后一次可用 CDB，避免 clangd 读到半写入 JSON；
- 协议和路径字段有版本，允许 mcpp 与插件独立升级。

### VS Code 扩展需要完成的工作

在上述核心接口可用后，扩展按以下阶段演进：

1. 打开工程或 `mcpp.toml` 变化时，在工作区受信任后调用 IDE 配置命令；涉及下载、
   执行 `build.mcpp` 或生成文件时，必须遵守 VS Code Workspace Trust。
2. 显示可取消的进度，支持在线、离线和只使用缓存三种模式；同一工程的连续事件使用
   debounce 与 singleflight 合并，避免并发下载或反复重启 clangd。
3. 配置失败时继续使用 last-known-good CDB，并在状态栏区分“正在准备”“可用但过期”
   “配置失败”和“模块语义可用”。
4. mcpp 输出新模块图和 CDB 后再切换 clangd；多根工作区按工程根目录隔离状态、进程和
   取消操作。
5. 增加协议兼容测试、无网络缓存测试、源码错误但 IDE 配置成功测试，以及真实 VS Code
   中的诊断、悬停、补全和跳转端到端测试。

### 技术边界

- clangd 要完成跨模块语义分析，所需 BMI/PCM 仍必须由兼容的 LLVM 工具链预编译；
  “不执行正式 build”不等于完全不产生模块二进制产物。
- 第一版完整语义能力只面向 LLVM。GCC `.gcm` 和 MSVC `.ifc` 不能直接交给 clangd，
  在没有独立 LLVM 分析配置前仍只保证模块语法高亮。
- clangd 负责编辑期语法和语义，不替代链接、代码生成、运行期或完整打包检查；这些错误
  仍由正式 `mcpp build`/`mcpp test` 报告。
- 当前 `0.1.5` 只是过渡方案：它能在用户显式构建后自动接管 CDB，但无法仅凭现有插件
  在无 CDB 时推导完整依赖图。最终体验依赖上述 mcpp 核心协议和 IDE 配置阶段。

## 故障排查

- mcpp 生成的 PCM 必须由同一 LLVM revision 的 clangd 读取。Homebrew clangd 即使
  版本号相同，也可能与 mcpp xlings 工具链来自不同 revision。此时应将
  `mcpp.clangd.path` 留空，让扩展自动选择 `.xlings` 中匹配的 clangd，或显式设置
  对应的 `.xlings/data/xpkgs/xim-x-llvm-tools/<version>/bin/clangd`。
- 独立 mcpp 的 LLVM 编译器通常位于 `.mcpp/registry/.../xim-x-llvm/<version>/bin`。
  扩展会尝试映射到 `.xlings/.../xim-x-llvm-tools/<version>/bin/clangd`；如果该工具包
  未安装，则只需安装匹配的 clangd 或配置 `mcpp.clangd.path`，不需要改用 xlings 版
  mcpp。
- 扩展会把已有参数中的 `${workspaceFolder}` 和 `${workspaceRoot}` 展开为当前 mcpp
  工程根目录，避免 clangd 将变量名当成字面路径后忽略编译数据库。
- 安装后应能在 `code --list-extensions` 中看到 `mcpp-community.mcpp-vscode`。仅保留在
  `~/.vscode/extensions` 目录、但没有登记到当前 VS Code profile 时，扩展不会激活，
  语法注入和 clangd 自动配置也都不会发生。

## 开发

```sh
npm install
npm test
npm run compile
```

生成的 `dist/` 是扩展运行时目录。请在 Extension Development Host 中运行上述
扩展，验证 VS Code API 集成。
