# Issue #6 一键配置模块代码提示设计

## 背景

当前 `mcpp.autoConfigureModules` 把 LLVM 工具链安装、全局默认切换、
`compile_commands.json` 刷新和 clangd 安装拆成多轮选择与确认。Issue #6 要求把
入口收敛为“用户主动执行命令，再确认一次”，确认后自动完成其余步骤。

本设计基于 `origin/main@1a8ae33`。该基线不包含 `mcpp ide configure` 集成，因此
CDB 仍由 `mcpp build` 生成；不依赖尚未进入 mcpp 主线的 IDE snapshot 协议。

## 目标

- 从命令面板或现有快捷入口执行“一键配置模块代码提示”后，最多出现一次模态确认。
- 确认后自动安装所需 LLVM 工具链、切换全局默认、构建并刷新 CDB、安装匹配的
  clangd、重新配置语言服务并检查模块状态。
- 不静默修改 `mcpp.toml`、workspace manifest 或 target 配置。
- 安装、default、clangd 安装或配置失败后立即停止；构建失败仅在产生可用 LLVM CDB
  时进入明确的降级刷新路径，不继续使用旧上下文宣称成功。
- 保留现有手动“安装工具链”“选择全局默认”“刷新编译数据库”命令。

## 非目标

- 不引入或回移 `mcpp ide configure`。
- 不自动安装 xlings 本体，不执行在线安装脚本。
- 不覆盖项目 `[toolchain]` 或 `[target.*].toolchain`。
- 不在本次改动中解决真实 LLVM/clangd 跨平台兼容矩阵。
- 不升级与 issue 无关的 npm 依赖或修复现有 `npm audit` 报告。

## 用户流程

### 预检

扩展在显示确认框前完成以下只读检查：

1. 当前资源属于 mcpp 工程且工作区已受信任。
2. 没有其他 mcpp 操作正在运行。
3. `mcpp toolchain list` 能被当前解析器识别。
4. 当前项目是否通过 manifest 或 target 覆盖全局默认。
5. host target 是否已有可用 LLVM 工具链。

若当前项目显式固定 GCC/MSVC，流程直接停止并提示用户手动修改项目配置。扩展不能
通过修改全局默认伪装成切换成功，也不能改写受版本控制的 manifest。

### 唯一确认

预检通过后显示一个居中的 modal。主文案说明当前工具链和目标 LLVM；detail 列出
即将执行的动作：可能下载 LLVM、修改 mcpp 全局默认及 host target、执行完整构建、
可能下载匹配的 llvm-tools，并重启 clangd。用户取消后不产生任何修改。

已使用 LLVM 但 clangd/CDB 需要修复时沿用同一 modal，只隐藏不需要的工具链动作。

### 自动执行

确认后按顺序执行：

1. host LLVM 不存在时运行 `mcpp toolchain install llvm`，由 mcpp 选择当前索引中的
   最高可用版本，扩展不复制版本选择策略。
2. 当前有效工具链不是 LLVM 时运行 `mcpp toolchain default llvm`。mcpp 从已安装
   版本中选择最高匹配并清空旧的 global `default_target`。
3. 运行 `mcpp build` 生成与新工具链一致的 CDB 和模块产物。
4. 构建结束后重新发现工程并重新分析 CDB；禁止继续使用切换前的 `ProjectContext`。
5. 若没有兼容 clangd，通过已安装的 xlings 执行匹配 LLVM 版本的
   `xim:llvm-tools` 安装。
6. 再次解析 clangd，写入官方 clangd 扩展配置，重启语言服务并运行模块检查。
7. 只显示一次最终成功通知；任务过程和失败细节写入现有 mcpp 输出频道/任务终端。

构建失败时仍重新读取 CDB：若 CDB 已生成且 clangd 可配置，可以保留编辑能力，但
最终结果必须说明“构建失败，语言服务已刷新”，不能报告完整成功。

## 代码结构

### `src/moduleSetup.ts`

新增纯 TypeScript 模块，负责：

- 根据工具链 inventory 和当前 capability 生成 `ModuleSetupPlan`。
- 返回 `project-toolchain-override`、`busy`、`unrecognized-inventory` 等明确阻断原因。
- 生成 modal 所需的动作摘要。
- 编排注入的安装、切换、构建、重载、clangd 配置和检查操作。安装/default/clangd
  失败立即终止；构建失败只允许先重载并验证新 CDB，再决定终止或降级继续。

该模块不导入 `vscode`，Node 单元测试可以覆盖完整状态机。

### `src/cliController.ts`

增加供一键流程使用的非交互复合操作，不复用会弹 QuickPick 的公开命令。复合操作
持有一个全局 operation token，直接使用现有 `executeTask`/`runProcess` 依次执行
LLVM 安装、全局默认切换和构建，完成后释放 token并返回每一阶段的
`TaskCompletion`。构建后的 clangd 重协调在 token 释放后进行，避免现有
`McppOperationRegistry` 的 global/project 互斥形成重入死锁。

手动命令保持原行为；公共底层执行逻辑只在确实消除重复时抽取。

### `src/extension.ts`

`autoConfigureModulesWizard` 缩减为 VS Code 适配层：加载 inventory、调用 planner、
显示唯一 modal、执行计划、重新加载 context、调用现有 clangd 配置与模块检查。
现有 workspace clangd 串行器继续防止两个向导同时修改窗口级 clangd 设置。

### `src/cli.ts` 与 `src/tasks.ts`

只增加 planner 需要的纯判断或执行结果类型；不改变当前 CLI 输出兼容解析规则。

## 并发与错误处理

- 预检和执行前都检查 operation registry，消除确认期间出现的竞争窗口。
- mcpp 安装、default 和 build 对其他项目/全局操作表现为一个独占事务。
- xlings/clangd 阶段仍受 workspace clangd 串行器保护。
- `cancelled` 与 `failed` 分开呈现；取消不显示错误。
- xlings 缺失时停止并提供官网链接或设置入口，但不再进入第二轮“安装/跳过”选择。
- LLVM 安装后仍无法切换、构建后仍是 GCC/MSVC、或 clangd identity 不兼容时均视为失败。
- 未受信任工作区不执行任何外部程序。

## 测试

### 单元测试

新增 `test/moduleSetup.test.ts`，至少覆盖：

- 已是 LLVM 且 clangd 就绪，只构建、重载和检查。
- GCC 且未安装 LLVM，顺序为 install -> default -> build -> reload -> clangd -> check。
- GCC 且已有 LLVM，跳过 install。
- 项目显式固定 GCC/MSVC 时阻断且没有任何副作用。
- 用户取消、operation busy、inventory 不可识别。
- 安装/default/build/重载/clangd 任一步失败后不执行后续步骤。
- 构建失败但产生可用 LLVM CDB 时返回降级结果而非完整成功。

扩展现有 controller/workflow 测试补充命令参数、锁释放顺序和旧上下文失效行为。

### Extension Host E2E

Issue #7 引入的 Extension Host smoke test 使用 fake mcpp CLI 验证扩展可激活、命令已注册、
普通项目任务可从配置的 `mcpp.path` 执行。modal 选择和下载分支由纯状态机单测覆盖，
不在 PR CI 中下载真实工具链。

## 验收标准

- 普通未固定 GCC/MSVC 工程从命令入口到开始执行只有一次 modal 确认。
- 确认后不出现工具链 QuickPick、默认选择或“是否刷新 CDB”提示。
- 显式固定工具链的工程不会修改任何 manifest 或全局默认。
- 自动流程结束时使用重新加载后的 LLVM CDB 和 clangd identity。
- 所有新增单元测试、现有 `npm test`、VSIX 打包和 Extension Host smoke E2E 通过。
