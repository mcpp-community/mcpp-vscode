# mcpp-vscode 0.5.0 实施计划：任务拆分、依赖关系与验收

- 日期：2026-10-02
- 上游设计：[`2026-10-02-plugin-optimisation-plan.md`](2026-10-02-plugin-optimisation-plan.md)（方案 v4）
- 分支：`feat/plugin-optimisation-v0.5.0`，**单 PR**，目标版本 `0.5.0`
- 本文只讲"怎么落地"：任务、依赖、并行分组、每个任务自己的验收方式。

---

## 1. 六个评审角度 → 落到哪条硬约束

| 角度 | 硬约束（可机械检查） | 落在 |
|---|---|---|
| **架构** | `src/` 按用途分组；纯逻辑模块不 import `vscode`；每个新模块有对应测试 | T01、T03、T18、T24、T30、T33 |
| **稳定性** | 所有 `runProcess` 有超时；解析优先 JSON；任何上游失败都不能把成功的 `mcpp build` 变成失败 | T05–T09、T14 |
| **优雅简洁** | 单一事实源（配置 registry、i18n bundle、schema 快照）；无重复的命令 ID 字面量；无死代码 | T02、T03、T24、T30 |
| **用户体验** | modal 只用于不可逆操作；每个视图有三态；每个清理有两步以上确认；文案跟随语言 | T15、T20–T23、T34、T37、T02 |
| **兼容性** | 不注册 `mcppls.*` 命令；`extensionDependencies` 语义不变；旧命令/旧设置保留为别名 | T11–T14、T04、T38 |
| **跨平台** | 无平台假设的路径/分隔符；CI 覆盖 linux-x64 + darwin-arm64；平台矩阵只在文档与 release note 声明 | T39、T40、T42 |
| **一致性** | 命令 ID / 设置键 / 文案 key 三者在 registry 与 package.json 之间由 CI 校验 | T03（check-config）、T02（l10n-check） |
| **无感升级** | 0.4.x 用户的设置、键位、命令 ID 全部继续工作；新增行为默认"不打扰"；CHANGELOG 写迁移说明 | T04、T10、T38、T41 |

---

## 2. 任务表

> **并行组**：同一组内的任务互不触碰同一文件，可以同时做；跨组有依赖。
> **状态**：✅ 已完成 / 🔄 进行中 / ⬜ 未开始

### P0 地基（必须先做：后面所有任务都往这三处加东西）

| ID | 任务 | 产物 | 依赖 | 并行组 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| T01 | 目录按用途分组 | `src/{cli,projects,toml,mcppls,commands,workflows}/` | — | P0-a | `npm test` 179 通过；`git log --follow` 可用 | ✅ |
| T02 | i18n 机制 | `data/i18n/{en,zh-cn}.json`、`l10n/bundle.l10n*.json`（生成）、`package.nls*.json`、`src/i18n/t.ts`、`tools/generate-l10n.mjs`、`tools/l10n-check.mjs` | T01 | P0-b | 缺 key 时 `l10n-check` 退出 1；`mcpp.ui.language` 三态有单测 | ⬜ |
| T03 | 配置模块 | `data/config-registry.json`、`src/config/{registry,access,validate,migrate}.ts`、`tools/check-config.mjs` | T01 | P0-c | registry ↔ package.json 语义一致的 CI 门禁；60 项全部可读且默认值正确 | ⬜ |
| T04 | 版本与迁移说明 | `package.json` 0.5.0、`CHANGELOG.md`（英） | — | P0-d | tag 与版本一致（release workflow 已有校验） | ⬜ |

### P1 稳定性基座

| ID | 任务 | 产物 | 依赖 | 并行组 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| T05 | mcpp 协议探测 | `src/cli/protocol.ts` | T03 | P1-a | 对真实 mcpp 解析出 `mcpp.protocol`；对旧输出返回"不支持"且不抛 | ⬜ |
| T06 | 工具链清单 JSON 优先 | `src/cli/toolchain.ts` | T05 | P1-a | JSON 路径与文本路径对同一份样本给出一致结果 | ⬜ |
| T07 | 超时与输出上限 | `src/cli/process.ts` | T03 | P1-b | 超时返回可识别错误；截断保留尾部并置标志 | ⬜ |
| T08 | 错误分层（SPEC-003） | `src/cli/errors.ts` | T07 | P1-b | 2/4/1/70/127 各有断言 | ⬜ |
| T09 | `mcpp.path` 校验 | `src/cli/controller.ts` | T05 | P1-c | 配置变更时校验一次并在频道输出 | ⬜ |
| T10 | 激活面收敛 | `package.json` activationEvents | T03 | P1-c | 只留 workspaceContains + onLanguage:mcpp-* | ⬜ |

### P2 mcppls 韧性与状态（方案 §2、§3.9）

| ID | 任务 | 产物 | 依赖 | 并行组 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| T11 | 能力表 | `src/mcppls/contract.ts` | T02 | P2-a | 表驱动单测：ID 唯一、danger 合法、无 `mcppls.` 前缀的本扩展命令 | ⬜ |
| T12 | 能力探测 | `src/mcppls/capabilities.ts` | T11 | P2-a | 静态声明 + 运行期分类；`onDidChange` 失效有单测 | ⬜ |
| T13 | 状态读取适配层 | `src/mcppls/state.ts` | T11 | P2-a | 5 种输入（正常/无 API/抛异常/未知 state/字段缺失）各有断言 | ⬜ |
| T14 | 桥接改造 | `src/mcppls/bridge.ts` | T12、T13 | P2-b | 候选链回退；危险级确认；`build` 永不因 mcppls 失败 | ⬜ |
| T15 | 「C++ Modules」视图 | `src/views/languageServerView.ts` | T14、T33 | P2-c | 三态（未安装/未启用/未暴露状态）可测 | ⬜ |
| T16 | e2e 夹具 5 个 + 套件 | `test/e2e/fixtures/mcppls-stub*` | T12 | P2-d | 5 个变体各自断言降级 | ⬜ |
| T17 | 环境自检命令 | `src/cli/selfCheck.ts` | T05、T13 | P2-e | 快照含版本/协议/能力/状态/已改设置 | ⬜ |

### P3 缓存统计与两级清理（方案 §3.4）

| ID | 任务 | 产物 | 依赖 | 并行组 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| T18 | 缓存聚合（纯函数） | `src/cli/cache.ts` | T07 | P3-a | 空/单条/incomplete/大数/缺 accessed 各有用例 | ⬜ |
| T19 | 项目产物体积 | `src/cli/artifacts.ts` | T07 | P3-a | 临时目录树用例；越界与权限失败降级 | ⬜ |
| T20 | 缓存 TreeView | `src/views/cacheView.ts` | T18、T19、T33 | P3-b | 节点由纯函数产出，可单测 | ⬜ |
| T21 | 缓存面板 webview | `src/views/cachePanel.ts`、`media/*` | T18、T33 | P3-c | HTML 由纯函数生成；CSP 无外链；预算模拟器有单测 | ⬜ |
| T22 | 清理命令族 | `src/cli/clean.ts` | T18、T19 | P3-a | 五级危险分级各有参数断言 | ⬜ |
| T23 | 清理确认流 | `src/views/*` + `src/cli/clean.ts` | T22 | P3-d | L1 与 `--all` 走两步确认；`--dry-run` 预演先行 | ⬜ |

### P4 `mcpp.toml` 编辑体验（方案 §3.3）

| ID | 任务 | 产物 | 依赖 | 并行组 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| T24 | schema 快照 + 生成 | `data/toml-schema.json`、`tools/generate-toml-schema.mjs`、`src/toml/schema.ts` | T03 | P4-a | 生成物稳定；读不到源时**失败而非产出空表** | ⬜ |
| T25 | 键与枚举值补全 | `src/toml/completion.ts` | T24 | P4-b | 段/键/值三类上下文各有断言 | ⬜ |
| T26 | 悬停 | `src/toml/hover.ts` | T24 | P4-b | 段头、键、legacy 键各有断言 | ⬜ |
| T27 | 诊断 | `src/toml/diagnostics.ts` | T24 | P4-c | 7 条规则正反例；严重度可配 | ⬜ |
| T28 | 跳转 | `src/toml/navigation.ts` | T24 | P4-c | `workspace`/`path`/`features` 三类 | ⬜ |
| T29 | 依赖版本补全（默认关） | `src/cli/search.ts` | T25 | P4-d | 解析样本；超时/离线降级为空 | ⬜ |

### P5 `build.mcpp` 智能（方案 §3.2）

| ID | 任务 | 产物 | 依赖 | 并行组 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| T30 | API 快照 + 生成 | `data/buildscript-api.json`、`tools/generate-buildscript-api.mjs` | T03 | P5-a | 31 条指令 / 5 role / 协议 15；源缺失时失败 | ⬜ |
| T31 | 符号表与模块清单 | `src/buildscript/{api,modules}.ts` | T30 | P5-b | `std`/`mcpp.*` 被判为已知模块 | ⬜ |
| T32 | provider 集 | `src/buildscript/providers.ts` | T31、T24 | P5-c | 7 条静态诊断正反例；补全/hover/片段 | ⬜ |

### P6 视图、视觉与格式化

| ID | 任务 | 产物 | 依赖 | 并行组 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| T33 | 主题与格式化 | `src/views/theme.ts`、`src/util/format.ts`、`src/util/text.ts` | T02 | P6-a | 字节/时长/相对时间/截断各有断言 | ⬜ |
| T34 | 工程视图与状态栏 | `src/views/{projectView,status}.ts` | T33、T06 | P6-b | 状态栏三态由纯函数产出 | ⬜ |
| T35 | contributions | `package.json` viewsContainers/views/colors/menus | T20、T15、T34 | P6-c | `artifacts` 测试断言结构 | ⬜ |
| T36 | 命令清单落地 | `src/commands/ids.ts` + 注册 | T20–T23、T15、T37 | P6-d | 每个 ID 在 package.json 与会话中一致 | ⬜ |

### P7 配置面板（方案 §4.3）

| ID | 任务 | 产物 | 依赖 | 并行组 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| T37 | 配置面板 webview | `src/config/panel.ts`、`media/config.css/js` | T03、T33 | P7-a | HTML 由纯函数生成；scope/来源/生效时机都渲染 | ⬜ |
| T38 | 面板设置写入与边界提示 | `src/config/access.ts` | T37 | P7-b | 不写 `mcppls.*`；资源型设置带 URI | ⬜ |

### P8 CI、文档与交付

| ID | 任务 | 产物 | 依赖 | 并行组 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| T39 | CI 体系 | `.github/workflows/ci.yml`（漂移 job、l10n/check-config 门禁、linux+macos matrix、VSIX 依赖版本断言） | T02、T03、T16 | P8-a | 本地可复跑的等价命令写进 docs | ⬜ |
| T40 | 用户文档 | `README.md`(en)、`README.zh-CN.md`、`docs/*.md`（8 篇） | T02–T38 | P8-b | README 的每个链接都存在（测试断言） | ⬜ |
| T41 | CHANGELOG（英） | `CHANGELOG.md` | T04 | P8-c | 0.5.0 段含迁移与新增 | ⬜ |
| T42 | 本地验收 profile | `tools/dev-profile.mjs`（隔离 extensions/user-data + 安装 VSIX + 打印启动命令） | T39 | P8-d | 脚本自身可跑通并打印可复制的命令 | ⬜ |
| T43 | 自我 review | `.agents/reviews/` 下的 v0.5.0 review | 全部 | P8-e | 每条风险有对应的测试或文档 | ⬜ |

---

## 3. 依赖图（关键路径）

```
T01 ─┬─ T02 ─┬─ T11 ─┬─ T12 ─┐
     │       │       └─ T13 ─┼─ T14 ─┬─ T15 ─┐
     │       │               │       └─ T16  │
     │       └─ T33 ─────────┼────────────────┼─ T35 ─ T36
     ├─ T03 ─┬─ T05 ─ T06 ───┘                │
     │       ├─ T07 ─┬─ T08                   │
     │       │       └─ T18 ─┬─ T20 ──────────┤
     │       │              ├─ T21 ──────────┤
     │       │              └─ T22 ─ T23 ────┤
     │       ├─ T09                           │
     │       ├─ T10                           │
     │       ├─ T24 ─┬─ T25 ─ T29 ───────────┤
     │       │       ├─ T26                   │
     │       │       ├─ T27                   │
     │       │       └─ T28                   │
     │       ├─ T30 ─ T31 ─ T32 ─────────────┤
     │       ├─ T37 ─ T38 ───────────────────┤
     │       └─ T17 ──────────────────────────┘
     └─ T04 ─ T41
              T34 ─┘
              T39 ─ T42
   T40, T43 在最后
```

**关键路径**：`T01 → T03 → T24/T30 → T32 → T35 → T36 → T39 → T40 → T43`。
`T02`（i18n）必须在任何"写文案"的任务之前完成，否则要写两遍。

---

## 4. 提交策略（单 PR、多 commit）

| # | commit | 内容 |
|---|---|---|
| 1 | `refactor: 目录按用途分组…` | ✅ T01 |
| 2 | `feat(i18n): 中英文案跟随 VS Code` | T02 |
| 3 | `feat(config): 统一配置注册表与一致性门禁` | T03 |
| 4 | `feat(cli): mcpp 协议探测、超时与错误分层` | T05–T10 |
| 5 | `feat(mcppls): 能力探测与 C++ Modules 状态视图` | T11–T17 |
| 6 | `feat(cache): 缓存统计与两级清理` | T18–T23 |
| 7 | `feat(toml): mcpp.toml 键/值补全、悬停、诊断与跳转` | T24–T29 |
| 8 | `feat(buildscript): build.mcpp 智能` | T30–T32 |
| 9 | `feat(views): 视图容器、状态栏、配色与配置面板` | T33–T38 |
| 10 | `ci+docs: CI 门禁、双语文档、0.5.0 迁移说明` | T39–T42 |
| 11 | `docs(review): 0.5.0 自我 review` | T43 |

每个 commit 必须保持 `npm test` 绿；`npm run test:e2e` 在 CI 与本地（有显示时）绿。

---

## 5. 验证矩阵

| 层 | 命令 | 覆盖 |
|---|---|---|
| 类型 | `npm run compile` | 全部 |
| 单测 | `npm test` | 纯逻辑：协议、能力、状态、缓存聚合、schema、诊断、格式化、生成物一致性 |
| 契约 | `npm test`（含 `test/toml/contract.test.ts`） | 真实 mcpp 的 `mcpp.toml` 段清单（无 mcpp 时跳过） |
| 生成物 | `tools/check-config.mjs`、`tools/l10n-check.mjs`、漂移 job | registry ↔ package.json ↔ nls ↔ docs |
| E2E | `npm run test:e2e` | 激活、命令注册、5 个 mcppls stub 变体、缓存视图节点、清理走 dry-run |
| 打包 | `npm run package` + `unzip -t` | VSIX 结构与依赖声明 |
| 人工 | `tools/dev-profile.mjs` 产出的隔离 profile | 用户在真实 VS Code 里验收 |

---

## 6. 无感升级检查表（发布前逐条确认）

- [ ] 0.4.x 的全部命令 ID 仍然存在（旧的转发命令与 `mcpp.clean` 保留为弃用别名）
- [ ] 0.4.x 的设置键仍然存在（`mcpp.path`、`mcpp.tomlCompletion`、3 个弃用设置）
- [ ] 新增设置默认值全部"不打扰"（新视图不影响既有布局的最小化：面板与视图都可关）
- [ ] `build` 之后的行为与 0.4.x 一致（刷新语言服务），只是优先用轻量重载
- [ ] 未受信任工作区的行为不放松
- [ ] CHANGELOG 写清"什么变了 / 什么没变 / 需要手动做什么"

---

## 7. 进展（round 1，2026-10-02）

分支 `feat/plugin-optimisation-v0.5.0`，`npm test` 390 通过，三个生成物/一致性门禁全绿。

| 任务 | 状态 | 产物 |
|---|---|---|
| T01 目录重构 | ✅ | `9 个提交之一`；179→390 测试 |
| T02 i18n 机制 | ✅ | `data/i18n/zh-cn.json`、`l10n/`（生成）、`package.nls*.json`、`src/i18n/{t,translate}.ts`、`tools/{generate-l10n,l10n-check}.mjs`；`package.json` 用户可见字符串全部 `%key%` |
| T03 配置模块 | ✅ | `data/config-registry.json`（64 项/10 组/29 公开）、`src/config/{registry,validate,access,migrate,presets}.ts`、`tools/{check-config,generate-settings-docs}.mjs`、`docs/settings.md`（生成） |
| T05 协议探测 | ✅ | `src/cli/protocol.ts`（已对真实 mcpp 2026.9.30.2 交叉验证） |
| T08 错误分层 | ✅ | `src/cli/errors.ts`（SPEC-003，含 101 仅 mcpp run / 4 / 127） |
| T11–T14 mcppls | ✅ | `src/mcppls/{contract,capabilities,state,bridge,messages}.ts`；15 项能力、候选链、惰性分类、状态白名单、结构化结果 |
| T18/T19 缓存聚合 | ✅ | `src/cli/{cache,artifacts}.ts` |
| T22 清理计划 | ✅（表） | `src/cli/clean.ts`（五级危险、预演、二次确认）；命令接线待做 |
| T24/T27 TOML | ✅ | `data/toml-schema.json`（30 段/97 键）、`src/toml/{schema,diagnostics}.ts`、`tools/generate-toml-schema.mjs` |
| T30–T32 buildscript | ✅（分析层） | `data/buildscript-api.json`（31 指令/5 role/协议 15）、`src/buildscript/{api,modules,analysis,providers}.ts` |
| T33 格式化 | ✅ | `src/util/{format,text}.ts` |
| 视图模型 | ✅（模型层） | `src/views/models.ts`（三棵树，标签即 key）、`src/projects/summary.ts` |

**下一轮的起点**：`package.json` 的 contributions（commands / viewsContainers / views / colors /
menus / activationEvents）、`src/views/` 的 provider 与命令实现、`src/extension.ts` 接线、
`tools/dev-profile.mjs`、CI 工作流、README 双语与 `docs/*`、0.5.0 版本与 CHANGELOG。

**上游反馈已记录**：生成脚本对照 mcpp 源码时发现方案文档里两个不存在的键名
（`[profile.<n>].opt_level` 实为 `opt`；`bidi_schedule` 实为 `bmi_schedule`），已修正。

---

## 8. Round 2 审计出的缺口（下一轮的输入）

文档子代理在写 `docs/` 时逐项核对了代码，发现"设置已声明但无人读取"的地方。这不是文档
缺陷，而是**功能缺陷**：声明了却不生效，比没有这个设置更糟。按严重度排列：

| # | 缺口 | 证据 | 处理 |
|---|---|---|---|
| G1 | `mcpp.toml` 的 hover 与跳转不存在 | `src/toml/providers.ts` 只注册补全与诊断；`mcpp.toml.hover`/`navigation` 无人读 | 实现 `src/toml/hover.ts` + `src/toml/navigation.ts`（schema 已有键与文档锚点） |
| G2 | 键/枚举值补全不存在 | `src/toml/completion.ts` 用的是手写 25 条段头表，**没有读** `data/toml-schema.json` | 让补全读 schema（键 + 枚举 + legacy 提示） |
| G3 | 依赖版本补全不存在 | `mcpp.toml.indexCompletion*` 无人读，`mcpp search` 无人调用 | 实现 `src/cli/search.ts` + 接入补全 |
| G4 | 缓存面板不是 webview | `mcpp.showCachePanel` 打开只读 Markdown 预览 | 实现 `src/views/cachePanelHtml.ts` + `cachePanel.ts`（叠条/年龄分布/TopN/预算模拟器） |
| G5 | 未贡献任何快捷键 | `contributes.keybindings` 缺失，方案 §3.5 承诺了 ctrl+alt+b/r/t/m/, | 加 keybindings |
| G6 | `mcpp.cache.gc.confirmAboveGiB` 无人读 | gc 超过阈值不会追加确认 | 接入 |
| G7 | pre-v1 遗留缓存节点永不显示 | `state.legacyBytes` 从未赋值 | 从 `cache dir` 的 legacy 路径估算体积并赋值 |
| G8 | 大量设置无人读 | 64 项中仅 16 项被生产代码读取 | 逐项接线：`mcpp.task.*`、`mcpp.languageService.*`、`mcpp.views.*.show`、`mcpp.ui.*`、`mcpp.runtime.*`、`mcpp.log.level`、`mcpp.buildScript.intelligence/snippets/imports.knownModules`、`mcpp.cache.statusBar/warnAboveGiB/autoRefreshSeconds/showLegacy` |
| G9 | 环境自检的缓存段永远是"not read" | `showSelfCheck` 没有传 `cache` | 采集后传入 |
| G10 | `src/cli/errors.ts` 与 `src/config/migrate.ts` 没有生产调用者 | 退出码分层与旧键迁移提示都没接 | 接入错误提示与首次激活的迁移提示 |
| G11 | i18n 仍有硬编码中文 | `src/cli/controller.ts`、`src/extension.ts` 多处直接写中文 | 全部改走 `t()`，并补 zh 条目 |
| G12 | `VERIFIED_MCPPLS_RANGE` 无人读 | 没有版本提示 | 在会话头/自检里提示（不作为门禁） |
| G13 | `mcpp.ui.numberFormat` 无人读 | `formatBytes` 恒为二进制单位 | 接入 |

**验收方式**：新增一条单测，遍历 `data/config-registry.json`，断言每个设置键在 `src/`
中至少被"读取一次"（用一张显式的"由谁读取"映射表，而不是正则扫描），缺一项即失败。
这条测试是这一轮的产出物之一——它把"声明了就要生效"变成可执行的约束。

---

## 9. 进展（round 2，2026-10-02）

`npm test` 420 通过；`check-config` / `l10n-check` / `check-generators` 全绿；
VSIX 打包 69 文件 180 KB；本地隔离 profile 已就绪（含 mcppls 0.0.9 与一个可用的 mcpp 工程）。

| 任务 | 状态 | 说明 |
|---|---|---|
| T15/T20/T21/T34–T38 视图与命令 | ✅ | 三棵视图、42 个命令、视图容器、两个颜色 ID、配置面板 |
| T16 e2e 五变体 | ✅（代码）/ ⚠️（本地未跑通） | 变体生成 + 每变体一次隔离 Extension Host；本地因无法下载固定版 VS Code 未完成 |
| T39 CI | ⬜ | 工作流尚未更新 |
| T40 文档 | ✅ | README 英/中 + 7 篇 `docs/`，52 条链接全部解析 |
| T41 CHANGELOG | ✅ | 0.5.0 英文段 |
| T42 本地 profile | ✅ | `tools/dev-profile.mjs` |
| G1–G13（§8 审计缺口） | ⬜ | 下一轮的输入 |

**本地 e2e 的限制**：`@vscode/test-electron` 需要下载 135 MB 的 1.91 稳定版，本机网络在
下载中途反复中断；改用已安装的 VS Code（`MCPP_E2E_CODE`，本轮新增）时 Extension Host
以 0 退出但没有执行套件。因此 **e2e 的结论仍以 CI 为准**（CI 里有 xvfb 与固定版本），
本地只验证到"编译通过、变体生成正确、命令面完整"。这一条必须在本轮报告里如实说明。

---

## 10. 进展（round 3，2026-10-02）

`npm test` **471 通过**（round 2 为 420）；三个门禁全绿；CI 重写。

| 项 | 状态 | 说明 |
|---|---|---|
| G1 `mcpp.toml` hover／跳转 | ✅ | `src/toml/{hover,navigation}.ts` + `providers.ts` 注册，两个开关生效 |
| G2 键／枚举补全读 schema | ✅ | `completion.ts` 改为快照驱动；快照没有但 mcpp 接受的段（如 `[workspace.dependencies]`）由手写清单补齐 |
| G3 依赖版本补全 | 🟡 | `src/cli/search.ts` 解析器已写并测试；尚未接进补全（唯一一处解析人类输出，注释已说明） |
| G4 缓存 webview 面板 | ✅ | `src/views/cachePanel{,Html}.ts` + `media/cache.css`，叠条／年龄分布／TopN／预算模拟器，已替换原来的 Markdown 预览 |
| G5 快捷键 | ⬜ | 仍未贡献 keybindings |
| G6 gc 阈值与遗留缓存节点 | 🟡 | `warnAboveGiB` 已在面板生效；`confirmAboveGiB` 与 `legacyBytes` 未接 |
| G8 设置接线 | 🟡 | 已接：task 参数四键、状态栏开关、菜单开关、并发作用域、超时、输出缓冲、语言服务刷新模式、视图可见性、启动自检、buildscript 总开关、数字格式。其余见下面的例外表 |
| G11 i18n | 🟡 | 新增一条"硬编码中文不得增长"的门禁（当前 162 行封顶） |
| G13 数字格式 | ✅ | `mcpp.ui.numberFormat` 已作用于缓存状态栏与面板 |
| T39 CI | ✅ | 见下 |

### 新增的两条"不得倒退"门禁

- `test/config/wiring.test.ts`：注册表里每个设置必须被代码读取，或在 `EXCEPTIONS` 里
  写明理由并指向 §8 的缺口编号。例外表当前 **40** 条，只允许变小（有一条测试专门断言这点）。
  已弃用的 4 个设置反过来断言"绝不被读取"。
- `test/i18n/hardcoded.test.ts`：`src/` 里未走 `t()` 的中文行数封顶 162，只允许下降。

### CI（`.github/workflows/ci.yml`）

| job | 内容 |
|---|---|
| `gates` | ubuntu + macos-14 矩阵跑 `npm test`（注册表／i18n／生成物漂移／单测） |
| `generated-drift` | 检出 mcpp 仓库并设置 `MCPP_REPO`，让快照漂移门禁真正执行；另断言 `docs/settings.md` 无 diff |
| `package` | 打包、`unzip -t`、清单承诺校验（依赖未变、无第二个语言客户端、无 `onCommand:*`）、VSIX 必须包含 l10n／nls／registry／css、上传产物 |
| `extension-host-e2e` | `xvfb-run` 下跑全部五种 mcppls 变体 |
| `isolated-install` | 把 VSIX 装进私有 profile，让 VS Code 解析依赖并断言 `sunrisepeak.mcpp-language-server@<版本>` 真实存在 |

---

## 11. 进展（round 4，2026-10-02）

| 项 | 状态 | 说明 |
|---|---|---|
| G5 快捷键 | ✅ | ctrl/cmd+alt + b/r/t/l/m，作用域 `mcpp.inProject`，并有断言 |
| G8 设置接线 | 🟡 | 三个并行工作流（controller 组 / views+mcppls 组 / buildscript+toml 组）在跑 |
| G10 `errors.ts`、`migrate.ts` | ✅ | 重命名提示接入激活路径（每工作区一次，旧键保留）；退出码指引由 controller 组接入 |
| G12 版本提示 | ✅ | 低于 `VERIFIED_MCPPLS_RANGE` 时在输出频道写一句，仅提示不做门禁 |
| 视图可见性 | ✅ | `setContext` + `contributes.views.*.when` |
| 例外表 | 🟡 | 31 条，新增一条'已接线的设置必须从例外表删除'的断言，防止例外表腐烂 |

---

## 12. 进展（round 5，2026-10-02）

| 项 | 状态 | 说明 |
|---|---|---|
| 设置文档中英对照 | ✅ | `gen:docs` 直接复用 `package.nls.zh-cn.json` 的描述，64 个设置中英并列，不产生第三份译文 |
| 发布流程守卫 | ✅ | `release.yml` 与 CI 同样校验 VSIX 体积与目录（那个 64 MB 的事故若发生在发布流程里会直接进 Release 附件） |
| 死代码 | ✅ | 除入口 `src/extension.ts` 外，`src/` 已无未被引用的模块 |
| G11 i18n（162 行硬编码中文） | 🟡 | 后台工作流正在清零，完成后需合并译文并把门禁上限降到实际值 |
| Windows CI | ⬜ | 仍未覆盖；macOS 也在矩阵里，但同样未经本机验证（本机只有 Linux） |
