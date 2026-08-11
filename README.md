<p align="center">
  <img src="images/logo.png" width="160" alt="mcpp 标志">
</p>

# mcpp VS Code 扩展

把 mcpp 工程、C++ 模块语法和官方 clangd 扩展接入 VS Code。

当前版本为 `0.3.1`。扩展负责工程发现、clangd 配置、模块状态检查以及常用
mcpp CLI 操作；它不实现新的 C++ 语言服务器，也不替代 mcpp 的构建逻辑。

> 当前完整的模块语义能力只支持 LLVM/Clang 工具链。GCC 和 MSVC 工程仍可使用
> 模块语法高亮、mcpp 命令和工具链管理，但插件不为其提供模块诊断、悬停或跳转。

## 能力矩阵

| 能力 | LLVM/Clang | GCC | MSVC |
| --- | --- | --- | --- |
| 识别 mcpp 工程 | 支持 | 支持 | 支持 |
| `mcpp.toml` TOML 语法高亮 | 支持 | 支持 | 支持 |
| `mcpp.toml` 结构补全（段头 + 写法模板） | 支持 | 支持 | 支持 |
| `build.mcpp`、`.cppm`、`.ixx`、`.mpp`、`.ccm` 文件关联 | 支持 | 支持 | 支持 |
| `module`、`export module`、`import` 语法高亮 | 支持 | 支持 | 支持 |
| 构建、运行、测试、清理命令 | 支持 | 支持 | 支持 |
| 查看、安装或选择 mcpp 工具链 | 支持 | 支持 | 系统检测与选择 |
| 自动配置语言服务 | clangd | 不支持 | 不支持 |
| 消费模块产物 | `.pcm` | 不读取 `.gcm` | 不读取 `.ifc` |
| 模块诊断、悬停、补全和跳转 | 实验性支持 | 不支持 | 不支持 |

这里的“GCC/MSVC 不支持”只表示插件当前没有对应的模块语义后端，不表示 mcpp
不能使用这些工具链构建项目。mcpp 可以生成 GCC `.gcm` 和 MSVC `.ifc`，但 clangd
不能直接消费这些编译器专用格式。

## 安装

从 [GitHub Releases](https://github.com/mcpp-community/mcpp-vscode/releases) 下载对应版本的
VSIX，然后在 VS Code 中执行 **Extensions: Install from VSIX...**，或者运行：

```sh
code --install-extension /path/to/mcpp-vscode-0.3.1.vsix
```

安装后确认当前 VS Code profile 中同时存在 `mcpp-community.mcpp-vscode` 和
`llvm-vs-code-extensions.vscode-clangd`。当前发布流程不会自动发布到 VS Marketplace。

## 使用条件

- VS Code 1.90 或更高版本。
- 包含 `mcpp.toml` 的 mcpp 工程。
- 包含 mcpp #387（合并提交 `3f237ed`）的可执行文件；在该能力进入正式版本前，
  可使用对应主线构建。旧版 mcpp 不支持 configure-only 时，扩展会保留原有 CDB 并提示升级。
  它可以由 xlings、官方独立安装脚本或其他受支持方式安装。
- 官方 `llvm-vs-code-extensions.vscode-clangd` 扩展。它是本扩展的功能依赖。
- 要启用模块语义，需要 LLVM mcpp 工具链、工程编译数据库，以及与该工具链来自
  同一 LLVM revision 的 clangd。

安装来源彼此独立：mcpp、构建编译器和 clangd 不必位于同一个目录，也不要求都由
xlings 安装。

## 快速开始

1. 使用 VS Code 打开包含 `mcpp.toml` 的目录，并按需信任工作区。
2. 工程没有有效 `compile_commands.json` 时，扩展会运行
   `mcpp build --configure-only` 生成配置阶段数据，不编译普通对象或链接产物。
3. 扩展会分析编译数据库、选择匹配的 clangd、写入工作区配置并检查模块支持；缺少
   项目 PCM 或需要验证正式产物时，仍应执行完整构建或使用一键配置向导。
4. 查看状态栏中的 `mcpp: 模块可用`、`mcpp: 模块不可用` 或
   `mcpp: 缺少模块 CDB` 状态。

工程还没有编译数据库时，可以点击“缺少模块 CDB”，或执行
**mcpp: 刷新编译数据库**。这个命令执行 `mcpp build --configure-only`，只在退出码为
0 且新 CDB 可解析时将其视为成功；失败时继续保留并使用原有可用 CDB。

virtual workspace 根不对应单一 CDB：mcpp 会把数据库分别发布到各 member 根。扩展
因此只接管当前活动 member；请先打开该 member 的源码或 `mcpp.toml`，不会把多个 member
的 CDB 合并到虚拟根。

## 已实现功能

### 工程发现与自动激活

- 工作区包含 `mcpp.toml`，或者打开 C++ 文件时激活扩展。
- 从活动文件或工作区目录查找最近的 mcpp 工程。
- 监听 `mcpp.toml`、`compile_commands.json`、活动编辑器、工作区和相关设置变化。
- 打开已有有效 CDB 的 LLVM 工程后自动配置并检查，不需要先点击状态栏或 Reload
  Window。

扩展激活不会静默运行完整 `mcpp build`，也不会自动下载、安装或切换工具链；受信任
工程缺少有效 CDB 时会自动运行配置阶段的 `mcpp build --configure-only`。

### 语法高亮

- 将精确文件名 `mcpp.toml` 识别为独立的 mcpp TOML 语言，内置表、键、字符串、数字、
  布尔、日期时间和注释高亮。
- 将精确文件名 `build.mcpp` 识别为独立的 mcpp build language，并复用 C++ TextMate
  grammar；`.cppm`、`.ixx`、`.mpp` 和 `.ccm` 继续关联到 VS Code 内置 `cpp` 语言。
- 向 C++ 源文件注入模块语法规则。
- 覆盖 `module`、`export module`、`import`、`export import`、模块名和模块分区。
- 支持尚未输入分号的编辑中间态。

语法高亮只负责词法着色。错误模块名、不可见声明等红色诊断来自语言服务器，不能由
TextMate 语法规则提供。

`build.mcpp` 是由 mcpp 宿主执行的构建脚本，不是普通 C++ 翻译单元。当前扩展只为它
提供 C++ 风格的语法高亮和编辑器括号/注释规则，不启动 clangd 语义诊断；因此
`import mcpp;` 不会再被误报为缺少 C++ 模块。真正的 mcpp API 补全需要 mcpp 核心
未来生成宿主 helper 的 CDB 和 PCM 映射。

### mcpp.toml 结构补全

- 段头补全：26 个段（`[package]`、`[targets.<name>]`、`[dependencies]`、`[build-dependencies]`、
  `[features]`、`[indices]`、`[pack]` 等），参数化段带可跳转占位符。
- 写法模板：依赖段的依赖写法（版本 / 路径 / git / features / tools）、`[features]` 表形式、
  capabilities / xlings / tools.overrides / generated_files 等开放段的条目形态。
- 每条建议携带显式替换范围，部分输入（`[dep`、`na`）不会残留无效文本；所有语义规则有真实
  mcpp 契约测试（44 例，无 mcpp 环境自动跳过）。
- 范围边界：不提供静态字段键/枚举（等上游版本化 manifest schema），不提供依赖包名/版本候选
  （等上游批量 catalog 接口）；未知自定义段与 `[[...]]` 数组表不提供建议。
- 由 `mcpp.tomlCompletion` 设置控制（默认开启）；未受信任工作区仅做纯文本分析，不执行任何
  外部程序。

### LLVM 与 clangd 集成

扩展读取 mcpp 生成的 `compile_commands.json`，然后：

1. 识别其中的 LLVM 编译器及待检查源文件。
2. 从显式设置、编译器目录、匹配的 xlings `llvm-tools` 目录和 `PATH` 中查找 clangd。
3. 执行编译器和 clangd 的版本命令，比较 LLVM 版本与 revision。
4. 保留用户已有的 `clangd.arguments`，展开 `${workspaceFolder}` 和
   `${workspaceRoot}`；只有在 CDB 未提供 `--no-default-config`、`-nostdinc++` 和显式
   libc++ 路径时，才添加精确的 `--query-driver`。
5. 根据 CDB 中是否已有显式 PCM 映射以及 `mcpp.modulesSupport` 设置，决定是否增加
   clangd 实验模块参数。
6. 必要时重启官方 clangd 扩展，并执行一次最长 60 秒的 `clangd --check`。

检查可以区分模块可用、PCM 不匹配、模块产物不可用、语言模式错误和一般检查失败。
完整命令及输出会写入 `mcpp` 输出频道。

**mcpp: 一键配置模块代码提示** 会先读取工具链状态，再显示一次模态确认。确认后，
它可以自动安装 host LLVM、设置 mcpp 全局默认、执行 `mcpp build`，并通过已安装的
xlings 补齐匹配版本的 llvm-tools（含 clangd），最后重新读取 CDB、配置 clangd 和检查
模块状态，无需 Reload Window。项目在 `mcpp.toml` 或 target 中显式固定 GCC/MSVC 时，
一键流程会停止并提示手动处理，绝不修改项目配置或伪装成全局切换成功。

### 自动协调与多根工作区

- CDB 创建或变化后自动重新分析、配置、重启和检查；删除后更新为缺少 CDB 状态。
- 同一工程的重复事件通过 singleflight 合并，共享的 clangd 操作全局串行。
- 只接受当前工程最新一次模块检查的结果，迟到结果不会覆盖新状态。
- 多根工作区中只有活动 mcpp 工程接管窗口级 clangd 配置；后台工程只失效缓存，切换
  过去时再协调。
- 修改资源域 `mcpp.path` 时按工程标记重新生成 CDB；修改 `mcpp.clangd.path` 或
  `mcpp.modulesSupport` 时只重新配置和检查，不重复运行 mcpp。
- 完整构建即使因普通源码错误退出，只要留下可用 CDB，扩展仍会尝试恢复 IDE 状态，并把
  “构建失败”和“IDE 数据可用”分别报告。

### mcpp CLI 与工具链管理

状态栏中的 `$(tools) mcpp: 快捷菜单` 提供：

- 在当前工程根目录执行 `mcpp build`、`run`、`test` 和 `clean`。
- 在 VS Code 任务终端中实时显示完整输出。
- 同一工程同时只运行一个由扩展启动的项目任务。
- 项目任务结束后先释放任务锁，再重新协调 CDB 和 clangd。
- 清理当前工程的 `target/`；不会删除 mcpp 全局 BMI 缓存。
- 读取并展示 `mcpp toolchain list` 的当前有效工具链、全局默认、系统工具链、target
  状态和可安装版本。
- 安装 mcpp 支持的工具链 spec，或从已安装/系统项中选择全局默认工具链。

安装和修改默认值都需要确认。取消操作不会被当成成功，工具链安装、默认值修改和构建
共享一个全局互斥锁；一键配置只在开始处确认一次，之后不会弹出工具链选择或“是否刷新
编译数据库”的二次询问。

## 命令

| 命令 | 行为 |
| --- | --- |
| **mcpp: 打开快捷菜单** | 打开项目、工具链和 IDE 操作入口 |
| **mcpp: 构建** | 在当前工程执行 `mcpp build` |
| **mcpp: 运行** | 在当前工程执行 `mcpp run` |
| **mcpp: 测试** | 在当前工程执行 `mcpp test` |
| **mcpp: 清理 target** | 确认后执行 `mcpp clean` |
| **mcpp: 查看工具链** | 只读展示 `mcpp toolchain list` 的解析结果和原始输出 |
| **mcpp: 安装工具链** | 确认后执行 `mcpp toolchain install <spec>` |
| **mcpp: 选择全局默认工具链** | 确认后执行 `mcpp toolchain default <spec>` |
| **mcpp: 配置 clangd** | 手动重新应用当前 LLVM 工程的 clangd 配置 |
| **mcpp: 刷新编译数据库** | 执行 `mcpp build --configure-only`，验证 CDB 后协调 clangd；失败时保留原有可用 CDB |
| **mcpp: 检查模块支持** | 立即执行 clangd 直接检查并刷新模块状态 |
| **mcpp: 一键配置模块代码提示** | 一次确认后自动安装/切换 host LLVM、执行 `mcpp build`，通过 xlings 补齐匹配 llvm-tools，重载 CDB 并配置 clangd；项目显式固定非 LLVM 工具链时停止 |

## 设置

```json
{
  "mcpp.path": "/path/to/mcpp",
  "mcpp.clangd.path": "/path/to/matching/clangd",
  "mcpp.modulesSupport": "auto",
  "mcpp.configureCppTools": true,
  "mcpp.tomlCompletion": true
}
```

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `mcpp.path` | 空 | mcpp 可执行文件；空值表示从 VS Code 进程的 `PATH` 查找 |
| `mcpp.clangd.path` | 空 | 与 CDB 中 LLVM 编译器匹配的 clangd；空值表示自动发现 |
| `mcpp.modulesSupport` | `auto` | `auto`、`on` 或 `off`，控制 clangd 实验模块参数 |
| `mcpp.configureCppTools` | `true` | 手动配置 clangd 时，是否询问关闭当前工作区的 cpptools IntelliSense |
| `mcpp.tomlCompletion` | `true` | 为 `mcpp.toml` 提供结构补全：段头与写法模板（snippet）；所有建议带显式替换范围，并经真实 mcpp 契约测试验证 |

`mcpp.path` 只影响插件执行 mcpp CLI 命令。工程实际编译器来自
`compile_commands.json`，`mcpp.clangd.path` 只指定语言服务器，三者相互独立。

`mcpp.modulesSupport=auto` 检测到 CDB 已含 `-fmodule-file` 或
`-fprebuilt-module-path` 时，直接使用 mcpp 生成的 PCM；否则只为 clangd 21 及以上
请求实验模块构建。`on` 强制请求该参数，`off` 始终不请求。这个设置不能生成缺失的
PCM。

## 工具链管理边界

- mcpp 的规范工具链 family 是 `gcc`、`llvm` 和 `msvc`；target 是独立的
  `arch-os[-env]` 维度。
- 安装入口接受 family、`family@version`、namespace、部分版本及 mcpp 兼容旧拼写，
  例如 `gcc`、`llvm@20.1.7`、`xim:gcc@16`、`msvc` 和 `mingw`。插件只做单参数
  规范化，最终合法性和具体版本由 mcpp 判断。
- 当前 UI 只读展示 target，不提供结构化 `--target` 选择器。target 专用默认值继续
  使用 mcpp CLI 设置。
- 选择全局默认值会修改 mcpp 的全局配置；项目或工作区的 `[toolchain]`、
  `[build].target` 和命令行参数仍可按 mcpp 规则覆盖它。
- MSVC 是 Windows 系统工具链。mcpp 负责检测和构建，不负责下载、升级或删除 Visual
  Studio；缺失时只显示官方安装指引。
- 0.0.90 起 native `cl.exe` 后端支持 `import std`、命名模块、`.ifc`、增量构建和
  运行。这是 mcpp 的构建能力，不代表当前插件或 clangd 能读取 `.ifc`。
- 当 mcpp 工程位于 VS Code 工作区目录的子目录时，插件不会仅凭路径关系判断它一定是
  mcpp 工作区成员；实际工具链以 mcpp 在该目录中的解析结果为准。

## 当前限制与责任边界

### 模块语义仅支持 LLVM

GCC `.gcm` 和 MSVC `.ifc` 是编译器专用产物。mcpp 可以正常构建它们，但 clangd
不能直接消费；当前版本没有 GCC 原生模块语言服务器、cpptools 模块后端或 LLVM 影子
分析副本。因此 GCC/MSVC 工程只保证模块语法高亮和 mcpp 操作。

### 首次语义配置仍需要 mcpp 生成的数据

当前插件只读取 `compile_commands.json`，不解析 `mcpp.toml`，也不自行推导依赖和
模块图。受信任工程没有有效 CDB 时，插件会调用 `mcpp build --configure-only`，但不会
自行生成或改写 mcpp 没有输出的 CDB。完整模块语义仍取决于 CDB 引用的兼容 PCM；正式
构建、链接和测试仍由普通 `mcpp build`、`run` 或 `test` 负责。

### clangd 模块支持仍是实验能力

- CDB 必须包含正确语言标准、编译器路径和有效 PCM 映射。
- clangd、mcpp LLVM 编译器、C++ 标准库和 PCM 应来自同一个 LLVM 构建；只匹配主版本
  或版本号并不足够。
- 语法颜色正常不代表语义诊断可用，`clangd --check` 成功也不替代完整构建和测试。
- clangd 负责编辑期诊断、悬停、补全和跳转；链接、代码生成、运行期和打包错误仍由
  `mcpp build`、`run` 或 `test` 报告。
- 当前扩展不调用 `clang-tidy` 或 `clang-format`，缺少它们不会影响本扩展的模块检查。

### 工作区信任与外部操作

未受信任工作区只启用文件关联和语法高亮，不执行 CDB 中的编译器、mcpp、clangd 或
工程指定程序，也不接管 clangd 配置。授予信任后，扩展会自动重新协调当前工程；仍不
会在没有用户操作时下载或切换工具链，也不会发起完整构建；缺少有效 CDB 时可以执行
配置阶段的 configure-only。该命令不是只读操作：mcpp 仍可能执行 `build.mcpp`、解析或
安装缺失依赖和工具链，并写入 lock、构建目录与相关元数据。

## 当前版本能达到的效果

在 LLVM 工程已经具有有效 CDB、完整 PCM 映射和匹配 clangd 的前提下，当前版本可以：

- 打开工程后自动恢复 clangd 配置和模块状态；
- 由 clangd 对错误导入、不可用模块及跨模块声明提供诊断；
- 由 clangd 提供悬停、补全、定义跳转、引用查找和后台索引；
- 在重新构建或 CDB 变化后自动刷新，不要求 Reload Window；
- 通过 VS Code 任务完成常用 mcpp 项目和工具链操作。

这些能力受 clangd 实验模块实现和 PCM 兼容性约束。工程没有 CDB 时，扩展可以请求
mcpp 生成配置阶段 CDB；若 mcpp 版本不支持该命令、配置失败或仍缺少兼容 PCM，则只能
提供语法高亮、mcpp 命令和引导操作。

## 理想最终效果

理想目标仍聚焦 LLVM 模块语义。用户打开一个受信任的 mcpp 工程后，不需要先执行
完整的 `mcpp build`，也不需要 Reload Window：

1. mcpp 解析工作区、目标、依赖、工具链、生成源和完整模块图。
2. 按用户授权准备缺失依赖和工具链，并生成专供 IDE 使用的 CDB 和 PCM。
3. 插件显示可取消进度，成功后原子切换到新 IDE 数据并启动匹配 clangd。
4. 即使普通实现源码暂时无法编译或链接，编辑器仍能对错误模块名、不可见模块和导入
   关系给出精确诊断。
5. 模块导出的声明可以稳定悬停、补全、跳转定义、查找引用和重命名。
6. 修改源码或 `mcpp.toml` 后增量刷新；离线时复用本机缓存和最后一次可用数据。
7. 多根工作区中的工程拥有独立状态、进度、取消操作和 last-known-good 数据。

这里的“不需要完整构建”是指不编译普通对象文件、不链接最终程序或库。clangd 要进行
跨模块语义分析，仍然必须由兼容 LLVM 工具链生成 IDE 专用 PCM，因此不等于完全不运行
编译器。

## 达到理想效果所需支持

下面按完成程度区分必要工作。`mcpp build --configure-only` 是当前扩展采用的已实现接口；
其余机器可读工程模型和结构化诊断仍是后续协议工作。

| 支持项 | 当前程度 | 理想完成标准 | 优先级 |
| --- | --- | --- | --- |
| 机器可读工程模型 | 插件只能读取 CDB，mcpp 主要输出面向人的文本 | mcpp 输出带版本 schema 的成员、目标、源码、模块、依赖、工具链、缓存与诊断 | 必需 |
| IDE 配置阶段 | 已使用 `mcpp build --configure-only` 生成并验证 CDB | 增加结构化进度、取消和能力协商，不把人类 stdout 当协议解析 | 部分完成 |
| IDE 专用模块产物 | PCM 是正式构建的副产物 | 只构建 `std`、依赖和项目模块 PCM，不编译普通对象或链接，并按工具链身份隔离缓存 | 必需 |
| 完整 CDB 与模块图 | LLVM CDB 已有部分显式 PCM 参数 | producer 和 consumer 都使用确定的绝对 PCM 路径，覆盖分区、依赖包、成员和测试目标 | 必需 |
| 结构化诊断 | 未知导入等信息主要来自构建或 clangd 文本 | mcpp 输出文件、行、列、严重级别和稳定错误码，插件可精确定位配置期错误 | 必需 |
| 原子快照与回退 | CDB 变化后直接重新读取 | 新数据完整后原子切换，失败时保留 last-known-good CDB、PCM 和状态 | 必需 |
| 插件生命周期 | 已有监听、singleflight、串行化和工作区信任 | 增加进度、取消、在线/离线/仅缓存模式、过期状态和按工程隔离的配置任务 | 必需 |
| 增量更新 | CDB 变化后整体重新协调 | 只重扫受影响模块并复用兼容 PCM，`mcpp.toml` 变化时增量解析依赖 | 增强 |
| 端到端验证 | 主要是单元测试和直接 `clangd --check` | 在真实 VS Code、LLVM 和示例工程中验证诊断、悬停、补全、跳转、离线及多根行为 | 发布门槛 |
| GCC/MSVC 模块语义 | 仅语法高亮 | 等待成熟原生语言服务，或另行设计 LLVM 影子分析；不属于当前路线 | 暂缓 |

推荐的职责边界接近 Cargo 与 rust-analyzer：mcpp 提供稳定、可查询的工程模型和 IDE
产物，clangd 消费 CDB 与 PCM，VS Code 扩展只负责授权、生命周期、状态和错误展示。
插件不应重新实现一套 `mcpp.toml` 解析器、依赖解析器或包管理器。

## 路线图

### 阶段 1：当前版本

- 缺少有效 CDB 时，在受信任工作区自动执行 `mcpp build --configure-only`；失败时保留
  last-known-good CDB。
- 使用 configure-only 或用户完整构建产生的 LLVM CDB 和已有 PCM。
- 自动配置 clangd、检查模块、监听变化并提供 CLI/工具链菜单。
- 一键自动安装匹配的 llvm-tools 并配置模块代码提示。
- GCC/MSVC 保持语法高亮和 mcpp 构建操作，不增加语义后端。

### 阶段 2：机器可读工程协议增强

- 在 mcpp 核心增加带版本的机器可读工程模型，不改变 configure-only 的退出码 + CDB
  客户端契约。
- 补充完整模块图、结构化诊断、IDE 专用 PCM 和能力协商。
- 明确定义工作区成员、配置身份、缓存路径、进度和取消协议。

### 阶段 3：完善打开即用的 LLVM 体验

- 在已有自动 configure-only 基础上增加可取消进度、离线缓存、增量刷新和过期状态。
- 完善按工程隔离的 last-known-good 数据与多根集成验证。
- 以真实 VS Code 端到端测试作为模块诊断和跳转能力的发布门槛。

### 未来重新评估 GCC/MSVC

当前不适配 GCC/MSVC 模块语义。只有满足以下条件之一时再单独设计：

- 出现能够稳定消费 `.gcm` 或 `.ifc`，并提供诊断、索引、悬停和跳转的语言服务；
- mcpp 能生成与正式 GCC/MSVC 构建隔离的 LLVM IDE 分析副本，并明确接受两套编译器
  在宏、扩展和诊断上的差异。

重新评估不会改变当前原则：正式构建结果以项目选择的 mcpp 工具链为准，IDE 分析不能
代替 `mcpp build` 和 `mcpp test`。

## 故障排查

### 扩展没有激活

- 确认工作区包含 `mcpp.toml`，或已经打开一个识别为 `cpp` 的文件。
- 执行 `code --list-extensions`，确认当前 VS Code profile 中存在
  `mcpp-community.mcpp-vscode`。
- 只有扩展目录但没有登记到当前 profile 时，语法注入和自动配置都不会发生。

### 找不到 mcpp

macOS 从图形界面启动 VS Code 时可能没有继承终端 `PATH`。将 `mcpp.path` 设置为实际
可执行文件，例如 `/opt/homebrew/bin/mcpp`。这不会改变工程编译器或 clangd 路径。

### 缺少模块 CDB

受信任工程缺少有效 CDB 时会自动尝试 `mcpp build --configure-only`，也可以手动执行
**mcpp: 刷新编译数据库**。若 mcpp 版本不支持该参数、命令失败或生成的 CDB 无法解析，
插件会保持“缺少模块 CDB”状态，并保留原有可用 CDB；请查看 `mcpp` 输出频道。需要
编译普通对象、生成完整项目产物或验证链接时，再在终端运行 `mcpp build`。

### clangd 未安装或无法匹配

- 执行 **mcpp: 一键配置模块代码提示**，扩展会自动通过 xlings 安装与当前编译器
  版本匹配的 llvm-tools（含 clangd）。
- xlings 可执行文件的定位以 `mcpp self env` 报告为准（覆盖 install.sh、AUR 等
  mcpp 内置安装布局），找不到时再回退到独立 `~/.xlings` 与 `PATH`。
- `mcpp.clangd.path` 可以指向任意安装来源的真实 clangd，不要求与 mcpp 同目录。
- 自动发现会尝试编译器同目录、匹配的 xlings `xim-x-llvm-tools/<version>/bin` 和
  `PATH`。
- 独立 mcpp 的 LLVM 编译器可以配合单独安装的 xlings llvm-tools 或其他匹配 clangd。
- Homebrew clangd 即使版本号相同，也可能与 mcpp 工具链来自不同 revision。

### 模块不可用或跳转失败

- 查看 `mcpp` 输出频道中的 `clangd --check` 完整输出。
- 确认 CDB 使用 C++20 或更高标准，并包含当前文件的编译命令。
- 确认 PCM 路径存在，且 clangd、编译器、标准库和 PCM 来自同一 LLVM 构建。
- 修改工具链或 CDB 后等待自动协调，必要时执行 **mcpp: 检查模块支持**。

### 出现两套诊断

clangd 和 Microsoft C/C++ IntelliSense 可能同时报告诊断。执行
**mcpp: 配置 clangd** 时，扩展可以询问是否仅在当前工作区关闭 cpptools
IntelliSense；也可以将 `mcpp.configureCppTools` 设为 `false` 保留它。

## 开发

```sh
npm install
npm test
npm run compile
```

生成的 `dist/` 是扩展运行时目录。请在 Extension Development Host 中验证真实 VS Code
API、状态栏、任务和 clangd 集成。

## 发布

先更新 `package.json`、`package-lock.json` 和更新日志中的版本并提交，再推送与扩展
版本完全一致的 tag：

```sh
git tag -a v0.3.1 -m "mcpp-vscode 0.3.1"
git push origin v0.3.1
```

`.github/workflows/release.yml` 会校验 tag，执行测试和打包，生成 VSIX 与 SHA-256 文件，
并创建或更新对应的 GitHub Release。工作流当前不会发布到 VS Marketplace。

项目地址：[mcpp-community/mcpp-vscode](https://github.com/mcpp-community/mcpp-vscode)

问题反馈：[GitHub Issues](https://github.com/mcpp-community/mcpp-vscode/issues)
