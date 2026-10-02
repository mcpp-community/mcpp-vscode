# mcpp-vscode 架构

> 状态：0.4.0（mcppls 语言服务迁移之后）。本文记录**当前**结构；变动请同步更新。

## 1. 一句话定位

mcpp-vscode 是 **mcpp CLI 的 IDE 前端**：工程发现、任务（build/run/test/clean）、工具链管理、
`mcpp.toml` 的语法与结构补全。C++ 模块语义（诊断/补全/跳转/引用/模块图/状态）由扩展依赖
`sunrisepeak.mcpp-language-server`（mcppls）提供，本扩展**不创建 LSP 客户端**。

## 2. 分层

```
extension.ts                 VS Code 装配层：激活、命令注册、provider 注册、资源释放
├── cliController.ts         CLI 编排层：快捷菜单、任务、工具链、新工程、操作互斥
│   ├── newProject.ts        新建工程流程（纯函数 + 注入的动作）
│   └── commands.ts          命令 ID 与快捷菜单清单（纯数据）
├── languageServer.ts        mcppls 桥接层：只调用 4 个公开 VS Code 命令
├── moduleSetup.ts           一键流程状态机（build → 刷新语言服务）
├── inProject.ts             `mcpp.inProject` 上下文键
├── mcppTomlCompletion.ts    mcpp.toml 补全查询层（段头 + 写法模板）
├── mcppTomlParser.ts        容错 TOML 解析器（纯函数）
├── discovery.ts             最近的 mcpp.toml 发现（纯函数）
├── cli.ts                   mcpp CLI 输出解析（工具链清单）
├── process.ts               runProcess 封装
└── tasks.ts                 任务计划、退出码分类、操作注册表（纯函数）
```

**约束**：`tasks.ts` / `moduleSetup.ts` / `discovery.ts` / `cli.ts` / `mcppTomlParser.ts` /
`newProject.ts` 不 import `vscode`，因此可用 `node --test` 直接测。`extension.ts` 与
`cliController.ts` 是唯一接触 VS Code API 的地方。

## 3. 运行时边界

| 触发 | 行为 |
| --- | --- |
| 打开含 `mcpp.toml` 的工作区 | 激活；不执行 `mcpp`，不下载工具链 |
| 执行 mcpp 命令 | 通过 `vscode.Task` + `ProcessExecution` 在专用终端运行 |
| build 结束（含失败） | 调用一次 `mcppls.restartServer`（单飞，取消除外） |
| run/test/clean 结束 | 不触碰语言服务 |
| 未受信任工作区 | 只保留语法高亮与 TOML 结构补全 |

## 4. 并发模型

`McppOperationRegistry`（`tasks.ts`）做两级互斥：

- **项目级**（键 = 工程根）：build/run/test/clean 互斥；
- **全局**：工具链安装 / 设置全局默认，与所有项目级操作互斥。

任务结束**先释放锁、再刷新语言服务**，避免刷新期间用户操作被拒。该顺序由
`test/artifacts.test.ts` 钉住。

## 5. 与 mcppls 的唯一接口

`languageServer.ts` 是全部耦合面：

| 本扩展命令 | 转发到 |
| --- | --- |
| `mcpp.configureLanguageServer`（+ 弃用别名 `mcpp.configureClangd`） | `mcppls.selectContext` |
| `mcpp.checkModuleSupport` | `mcppls.restartServer` |
| `mcpp.showModuleGraph` | `mcppls.showModuleGraph` |
| `mcpp.showLanguageServerLogs` | `mcppls.showLogs` |
| build 之后 | `mcppls.restartServer` |

不读 `mcppls.*` 设置、不解析 LSP、不写跨扩展配置。详见
[`mcppls-integration.md`](mcppls-integration.md)。

## 6. 已知的结构性债务

- `src/configureOnly.ts`、`src/ideWorkflow.ts` 在 0.4.0 迁移后已无生产调用者（仅被自身测试引用），
  它们描述的是 `compile_commands.json` 时代的行为，与当前职责边界冲突。
- `cli.ts` 用正则解析 `mcpp toolchain list` 的**人类输出**，而 mcpp 已提供
  `--format json` 的稳定契约。
- 命令 ID `mcpp.refreshCompilationDatabase` / `mcpp.checkModuleSupport` 是历史拼写，与当前语义
  （build / restart）不符。

具体建议见 `.agents/reviews/` 下的评审报告。
