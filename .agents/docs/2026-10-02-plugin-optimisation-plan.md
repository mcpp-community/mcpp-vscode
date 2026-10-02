# mcpp-vscode 插件优化方案（v4，待评审）

- 日期：2026-10-02
- 基线：`mcpp-vscode` `main@20f1076`（0.4.0）
- **硬约束：不改动 `mcpp` 与 `mcppls` 的任何代码。** 全部改动落在 mcpp-vscode 仓库内；
  对上游只读（贡献者机器上读源码生成快照，运行期不新增依赖）。
- 前置分析：`.agents/reviews/2026-10-02-mcpp-vscode-architecture-and-mcppls-dependency-review.md`
- 版本历史：v1 首版 → v2 用真实 mcppls payload 实测后重写 `build.mcpp` 一节、缓存收敛为两级、
  补 i18n / TOML 编辑 / 配色 / UI 对比 → v3 定稿评审意见、新增主线 D「统一配置模块与配置面板」、
  补完整设置清单、去掉模式 B 的实现（仅文档备注）、加自我 review →
  **v4 新增 §3.9「把 mcppls 的状态与管理并入 mcpp」、`cache clean --all` 的确认分级、
  第一版公开设置清单（§4.6）、mcppls 状态读取的防御式设计与两个新 e2e 夹具。**

---

## 0. 已确认的决策

| # | 决策 | 落点 |
|---|---|---|
| 1 | 目录树重构 + 两提交执行；UI 采用 **U2**（视图容器 + 2 TreeView + 1 Webview 面板） | §1.2、§3.6 |
| 2 | README 英文主 + `README.zh-CN.md`；`package.json.description` 与 `CHANGELOG.md` 改英文 | §1.3 |
| 3 | `docs/superpowers/` → `.agents/superpowers/` | §1.4 |
| 4/5 | `build.mcpp` **只做模式 A（隔离 + 自研 mcpp:: 智能）**；模式 B 不实现，仅在文档备注 | §3.2、附录 D |
| 6 | 清理收敛为**两级**：`mcpp clean` / `mcpp clean --stale` | §3.4 |
| 7 | i18n 第一版：`package.nls.*` 全量 + 关键流程文案；运行时文案渐进迁移 | §3.7 |
| 8 | 激活面收敛（去掉 `onLanguage:cpp`） | §3.1 |
| 9 | 查询类命令默认超时 30 s（`0` = 不限） | §3.1 |
| 10 | 配色 / 可视化 / `build.mcpp` / `mcpp.toml` 编辑 / mcpp 功能都要完整设计 | §3.3–§3.9 |
| 11 | `mcpp.cache.staleDays` 默认 **3** 天 | §3.4 |
| 12 | 全局缓存**暴露更多功能**，并配更好的可视化 | §3.4.3 |
| 13 | `mcpp.toml` 未知段/未知键的默认严重度 = **warning** | §3.3 |
| 14 | 依赖版本补全**进方案**（默认关，唯一的"解析人类输出"例外） | §3.3.2 |
| 15 | **凡可配置的功能都要有设置项，并由统一的配置模块管理 + 配置面板操作** | **§4（主线 D）** |
| 16 | 第一版**公开发布 29 项设置**，其余进入 `advanced` 默认隐藏 | §4.4、§4.6 |
| 17 | **保留** `mcpp.ui.language` 手动覆盖，并在面板与 docs 明确标注"部分界面不受影响" | §3.7 |
| 18 | **保留**依赖版本补全（`mcpp.toml.indexCompletion`） | §3.3.2 |
| 19 | 全局缓存**暴露 `cache clean --all`**，但点击必须走**确认提示** | §3.4.3、§3.4.4 |
| 20 | 配置面板定位：**不取代**原生设置页，只做集中 / 解释 / 预设 / 边界提示 | §4.3 |
| 21 | **把 mcppls 的核心状态与管理并入 mcpp-vscode**（LSP 状态、引擎、问题、缓存重置、诊断包…） | **§3.9** |

---

## 1. 主线 A：仓库结构与文档

### 1.1 目标

1. `src/` 从"15 个文件平铺"变成"按用途分组"，`test/` 镜像；
2. 新增的 UI、缓存、build 脚本、i18n、config 五块有明确归属；
3. `README.md` ≤ 120 行、英文，`README.zh-CN.md` 同结构；
4. 用户文档（`docs/`）、贡献者文档（`.agents/docs/`）、过程文档（`.agents/superpowers/`）边界明确。

### 1.2 目录树

```
src/
  extension.ts                  # 唯一装配点：activate/deactivate
  commands/{ids.ts,menu.ts}     # 命令 ID 与快捷菜单清单（纯数据）
  config/                       # 【新】主线 D：统一配置模块
    registry.ts                 #   读 data/config-registry.json，导出类型化条目
    access.ts                   #   类型安全读写 + 生效值来源（default/user/workspace/folder）
    validate.ts                 #   枚举/范围/正则校验，非法值回退默认并提示一次
    migrate.ts                  #   旧键 → 新键的 alias 与一次性迁移提示
    panel.ts                    #   配置面板 webview
  cli/                          # mcpp CLI 适配层
    process.ts                  #   原 process.ts（+ 默认超时、输出截断）
    protocol.ts                 #   【新】--protocol-version 探测与信封解析
    toolchain.ts                #   原 cli.ts（JSON 优先，文本 fallback）
    controller.ts               #   原 cliController.ts
    tasks.ts                    #   原 tasks.ts
    newProject.ts               #   原 newProject.ts
    artifacts.ts                #   【新】target/ 体积估算（只读）
    cache.ts                    #   【新】cache/clean 的调用与聚合（纯函数优先）
    search.ts                   #   【新】`mcpp search` 解析（依赖版本补全，默认关）
  projects/{discovery.ts,context.ts}
  toml/{parser.ts,schema.ts,completion.ts,hover.ts,diagnostics.ts,navigation.ts}
  buildscript/{api.ts,modules.ts,providers.ts}
  mcppls/{contract.ts,capabilities.ts,state.ts,bridge.ts}
  views/{status.ts,projectView.ts,cacheView.ts,cachePanel.ts,languageServerView.ts,theme.ts}
  i18n/t.ts                     # 【新】文案解析（auto → vscode.l10n；否则读自带表）
  util/{text.ts,format.ts}

data/
  config-registry.json          # 【新】主线 D 的单一事实源（提交）
  buildscript-api.json          # 【新】mcpp 构建脚本 API 快照（提交）
  toml-schema.json              # 【新】mcpp.toml 段/键/枚举快照（提交）
  i18n/{en.json,zh-cn.json}     # 【新】运行时文案的单一来源（提交）
media/                          # webview 静态资源（CSS/SVG/JS），CSP 安全、无网络
l10n/                           # 由 data/i18n 生成，勿手改
  bundle.l10n.json
  bundle.l10n.zh-cn.json
package.nls.json                # 【新】package.json 的英文文案（默认）
package.nls.zh-cn.json          # 【新】package.json 的中文文案
tools/
  generate-buildscript-api.mjs  # 从 mcpp 仓库生成 data/buildscript-api.json
  generate-toml-schema.mjs      # 从 mcpp docs/04 + SPEC-004 生成 data/toml-schema.json
  generate-l10n.mjs             # data/i18n/*.json → l10n/bundle.l10n*.json
  check-config.mjs              # 【新】registry ↔ package.json 语义一致性门禁
  l10n-check.mjs                # 文案 key 与 bundle 覆盖门禁
test/                           # 与 src/ 镜像
  e2e/fixtures/{fake-mcpp.js, mcppls-stub/, mcppls-stub-partial/, mcppls-stub-renamed/, project/}
```

**必须一起改的地方**：

| 位置 | 影响 |
|---|---|
| `tsconfig.json` | 增加 `resolveJsonModule: true`（要 `import` `data/*.json`）；`rootDir`/`outDir` 不变 |
| `package.json` `main` | 不变（`./dist/src/extension.js`） |
| `package.json` `test` | `node --test dist/test/*.test.js` → `node --test "dist/test/**/*.test.js"` |
| `test/**` 的 `import "../src/xxx"` | 全部改为新路径 |
| `test/artifacts.test.ts` | 路径 + 把"源码文本断言"改成行为断言 |
| `.vscodeignore` | **排除** `tools/**`、`docs/**`、`.agents/**`、`data/**`（JSON 在编译期被 `import`，产物在 `dist/data/`）；**必须保留** `media/**`、`l10n/**`、`package.nls*.json`、`dist/**` |
| `docs/superpowers/**` | `git mv` → `.agents/superpowers/{plans,specs}/` |

> **执行建议**：提交 1 = `git mv` + import 路径替换 + 测试 glob（零行为变化，门禁
> `npm test && npm run test:e2e`）；提交 2 起才加新文件与功能。

### 1.3 README 双语与瘦身

`README.md`（英文，≤120 行）+ `README.zh-CN.md`（中文，同结构），顶部语言切换。
章节：What this is → Why → Install（含平台矩阵）→ Quick start 60s → Features（6 条，各一行）
→ Commands（表）→ Settings（表，链接到 `docs/settings.md`）→ Editing `mcpp.toml` / `build.mcpp`
（各 3 行 + 链接）→ Troubleshooting（5 条一行 + 链接）→ Develop → License。

详情拆到 `docs/`：`architecture.md`、`commands.md`、`settings.md`、`mcpp-toml.md`、
`build-script.md`、`cache.md`、`troubleshooting.md`、`compatibility.md`。
`package.json` 的 `displayName` / `description` 改为 `%key%` 占位（见 §3.7）。

### 1.4 目录边界

| 目录 | 读者 | 进版本库 | 内容 |
|---|---|---|---|
| `docs/` | 用户 | ✅ | 用法、设置、排错、兼容性 |
| `.agents/docs/` | 贡献者/agent | ✅ | 设计、契约、决策、本方案 |
| `.agents/superpowers/` | 过程 | ✅ | 历史 plans/specs（原 `docs/superpowers/`） |
| `.agents/reviews/` | 贡献者 | ❌ 已 gitignore | 分析报告、评审记录 |

---

## 2. 主线 B：mcppls 依赖的"永不折断"设计

### 2.1 能力模型

`src/mcppls/contract.ts` 只有数据。**两类能力**：`forward`（转发 mcppls 的命令）与
`readState`（只读 mcppls 的状态，见 §3.9）。

```ts
export interface Capability {
  key: string;                  // 稳定的内部名，用作日志/设置键
  kind: "forward" | "readState";
  titleKey: string;             // 文案 key，走 §4 的 i18n
  commands: string[];           // 候选链，按优先级（readState 为空）
  required: boolean;            // 全部为 false
  /** 使用它需要多重的确认。 */
  danger: "none" | "confirm" | "destructive";
  degradedHintKey: string;
}

export const MCPPLS_EXTENSION_ID = "sunrisepeak.mcpp-language-server";
export const VERIFIED_MCPPLS_RANGE = ">=0.0.4";   // 实测 0.0.9 后收紧

export const CAPABILITIES: readonly Capability[] = [
  // ── 第一批：v1 已有 ──
  { key: "refresh",       kind: "forward", commands: ["mcppls.reloadBuildDescription", "mcppls.restartServer"], danger: "none" },
  { key: "selectContext", kind: "forward", commands: ["mcppls.selectContext"],   danger: "none" },
  { key: "moduleGraph",   kind: "forward", commands: ["mcppls.showModuleGraph"], danger: "none" },
  { key: "logs",          kind: "forward", commands: ["mcppls.showLogs"],        danger: "none" },
  // ── 第二批：§3.9 新增 ──
  { key: "readState",         kind: "readState", commands: [],                             danger: "none" },
  { key: "restartEngine",     kind: "forward", commands: ["mcppls.restartClangd"],         danger: "confirm" },
  { key: "resetCache",        kind: "forward", commands: ["mcppls.resetWorkspaceCache"],   danger: "destructive" },
  { key: "report",            kind: "forward", commands: ["mcppls.collectReport"],         danger: "none" },
  { key: "diagnosticBundle",  kind: "forward", commands: ["mcppls.exportDiagnosticBundle"], danger: "none" },
  { key: "conflicts",         kind: "forward", commands: ["mcppls.turnOffOtherCppFeatures", "mcppls.restoreOtherCppFeatures"], danger: "confirm" },
  { key: "runBuildTool",      kind: "forward", commands: ["mcppls.runBuildToolInTerminal"], danger: "confirm" },
  { key: "enableInWorkspace", kind: "forward", commands: ["mcppls.turnOnInWorkspace", "mcppls.turnOffInWorkspace"], danger: "confirm" },
  { key: "installTools",      kind: "forward", commands: ["mcppls.installCommandLineTools"], danger: "confirm" },
  { key: "review",            kind: "forward", commands: ["mcppls.review.run", "mcppls.review.clear"], danger: "none" },
];
```

`refresh` 用候选链：上游哪天注册了 `reloadBuildDescription`，本插件自动升级，**无需改代码**。
`mcpp.languageService.refreshAfterBuild`（§4）可把这条链强制成 `reload` / `restart` / `off`。

**`review.run` / `review.clear` 是服务器广告的命令**（由 `vscode-languageclient` 注册），
只在服务器运行后存在；能力探测按"调用失败即缺失"处理，无需特判。它们还受
`mcppls.ai.enabled` 约束 —— 本插件只**转发**，不读、不写该设置。

### 2.2 探测：静态声明 + 惰性运行期分类

- **不要**在激活时逐个调用探测：多数 UI 命令都有副作用（弹 QuickPick、开面板、清缓存）。
- **不要**把 `commands.getCommands()` 当唯一判据（是否包含未激活的贡献命令无保证）。
- **`readState` 特殊**：它不靠命令，靠 `extension.exports`（见 §3.9），因此有自己的探测方式
  （形状探测 + try/catch），与命令能力分开。
- **静态**：`getExtension(id)?.packageJSON.contributes.commands` —— 零副作用，激活时 +
  `extensions.onDidChange` 刷新。读不到只**置灰并带说明**，不隐藏。
- **运行期**：首次真正使用时调用一次并分类错误（`command '…' not found` → `missing`）。
  `missing` 才从菜单隐藏，并写一行日志 + 一次性提示（受
  `mcpp.languageService.notifyOnDegraded` 控制）。

### 2.3 降级矩阵与不变式

| 能力 | 缺失时 | 用户看到 |
|---|---|---|
| `refresh` | build 照常成功，不重试、不弹错 | 输出频道一行；成功提示照常 |
| `readState` | §3.9 的「C++ Modules」视图只显示版本/激活/启用 + 我们自己的刷新历史 + 转发按钮 | 状态区块显示"已安装的 mcppls 未暴露状态" |
| 其余 `forward` | 菜单/视图项隐藏（静态缺失时置灰） | 一次性 info + "查看兼容性"按钮 |

**不变式（写成测试）**：① mcppls 的任何失败都不能把成功的 `mcpp build` 变成失败；
② 不能让其它命令不可用；③ `deactivate()` 不留悬挂 Promise；
④ `readState` 抛异常或返回未知形状时，**视图仍然可用**（只剩降级内容）。

### 2.4 版本只用于提示

`getExtension(id)?.packageJSON.version` → 会话头 + 环境自检 + 低于已验证区间的一次性提示。
**不按版本开关功能**（版本号预测不了改名，能力探测才是判据）。

### 2.5 测试

五个 e2e 夹具：`mcppls-stub`（全部命令 + 同形状 `exports`）/ `mcppls-stub-partial`
（只有 `restartServer`）/ `mcppls-stub-renamed`（改名）/ **`mcppls-stub-noapi`**（不导出 API）/
**`mcppls-stub-throwing`**（`lastStatus()` 抛异常、返回未知 `state`）。
断言：降级、菜单隐藏、"build 永不因 mcppls 失败而失败"、**视图在无 API/异常时仍可用**。
另加纯单测对 `CAPABILITIES` 与 §3.9 的状态适配层做表驱动形态断言。

### 2.6 新命令 `mcpp: 环境自检`

输出可复制快照：扩展/VS Code/平台、工作区信任与根数、工程根、mcpp 路径+版本+协议+kinds、
mcppls 版本 + 全部能力状态（`forward` 与 `readState` 分开列）、**mcppls 的状态摘要**
（`state` / `project.source` / `engine` / `issues` 的 code 列表，见 §3.9）、上次刷新时间与结果、
缓存规模、**所有被改过的设置**（来自 §4 的 registry）、最近错误。把 90% 支持问题一次问清，
且不需要任何上游改动。

---

## 3. 主线 C：稳定性、编辑体验、缓存、交互与视觉

### 3.1 稳定性基座

| 项 | 目标 |
|---|---|
| 输出协议 | JSON 优先：`--protocol-version` 判协议 → `toolchain list --format json`；文本解析保留为 legacy 分支并单独测试 |
| 超时 | 查询类默认 30 s（`mcpp.runtime.timeoutSeconds`，`0` = 不限）；`build/run/test/install` 走任务终端不设硬上限；`cache gc/prune` 300 s |
| 输出上限 | 保留 16 MiB `maxBuffer`；超限按行截断并提示"完整输出见 `mcpp` 输出频道" |
| 错误分层 | SPEC-003：`2` 用法 / `4` 环境未就绪 / `1` 运行失败 / `70` 内部 / `127` 未知命令 → 不同文案 + 下一步建议 + `mcpp self explain <CODE>` 一键跳转 |
| `mcpp.path` | 配置变更时跑一次 `mcpp --protocol-version`（无副作用），版本写进输出频道；不可执行时状态栏警告 |
| 激活面 | 收敛为 `workspaceContains:mcpp.toml` + `onLanguage:mcpp-toml` + `onLanguage:mcpp-build` |
| 未受信任工作区 | 缓存视图降级为纯文件系统估算并注明；清理一律要求信任 |

### 3.2 `build.mcpp`：只做模式 A

#### 3.2.1 实测结论（本机真实 mcppls 0.0.8 payload + clangd 23.1.0）

```
$ mcppls check build.mcpp --payload <payload>
root      …/examples/11-features/greeter
database  6 entries, 2 standard library units, 0 left out
module    build.mcpp:2: module 'mcpp' not found
E [module_not_found] Line 1: module 'std' not found
E Failed to build module mcpp; due to Don't get the module unit for module mcpp
clangd    exit 3

$ mcppls check src/main.cpp --payload <payload>
database  6 entries, 2 standard library units, 0 left out
clangd    exit 0          ← 零诊断
```

并且 `mcpp emit build-database --spec compile-commands --format json` 的 6 条记录里
**没有 `build.mcpp`**；它只出现在 `data.watch` 里。

**三条硬事实**：① mcpp 有意不把构建程序放进编译数据库；② mcppls 的模型里没有
`build.mcpp`（它只处理 `target/.build-mcpp/deps/...`）；③ 因此交给 clangd 后
**`import std` 与 `import mcpp` 都会报 `module not found`**，不是"只有 mcpp 报错"。

而 **VS Code 没有公开 API 能过滤/删除另一个扩展发布的诊断**。所以"交给 C++ 语言服务、
但抹掉 `import mcpp` 的红线"在不改上游的前提下**做不到**。

#### 3.2.2 本版设计：模式 A（隔离）—— 零报错

- `build.mcpp` 保持独立语言 id `mcpp-build`，语法即 C++（现有 `include: source.cpp` +
  模块注入语法），**mcppls 不介入 → 永不报错**；
- 在此之上补 **mcpp-vscode 自研的 `mcpp::` 智能**（数据来自 mcpp 的机器可读表，见 §3.2.3）：
  补全 / 悬停 / 签名 / 静态诊断 / 片段 / 文档符号 / 折叠；
- **"认识 std 与 mcpp"**：内嵌"构建脚本可用模块名"清单
  （`std`、`std.compat`、`mcpp`、`mcpp.core`、`mcpp.plugins.*`），对其做**高亮 + 悬停说明 +
  文档链接**，并**永不对其报"找不到"**（`mcpp.buildScript.imports.knownModules`）。
  这就是"std ok"在本层的实现：**认识它、解释它、不为难你**；
- 诚实写明代价：**没有 std 的符号级补全/跳转**。

#### 3.2.3 数据来源（贡献者期生成）

`tools/generate-buildscript-api.mjs`（Node，无依赖）读 `MCPP_REPO`（默认 `../mcpp`）：

| 源 | 取什么 |
|---|---|
| `modules/buildmcpp/src/directives.cppm:297` | `kTable[31]`：wire / tag / slot / scope / transform / must / missingPrefix / missingSuffix / sinceProtocol |
| `modules/buildmcpp/src/directives.cppm:1132-1134` | 5 个 role 常量 |
| `modules/buildmcpp/src/program_protocol.cppm:121,147` | `kProtocolVersion = 15`、`kCacheEpoch = 3` |
| `modules/buildmcpp/src/provisions.cppm:80` | `tool` / `host-module` / `dep-dir` |
| `docs/specs/build-plugins.md`、`docs/30-build-mcpp.md` | 规则号与 hover 章节链接 |

输出 `data/buildscript-api.json`（含 `sourceVersion` / `sourceCommit` / `protocolVersion`）。
CI 漂移 job：用 `mcpp@main` 重新生成 + `git diff --exit-code`。

**静态诊断规则**（纯文本，不执行任何东西，未受信任工作区可用；严重度由
`mcpp.buildScript.diagnostics.severity` 控制，默认 warning）：
① 未知 `mcpp::<name>`；② `role` 用字符串字面量（R3.6）；③ `prepare` 未声明 `output_dir`（R3.3）；
④ `link_flag` 含 `-Wl,-rpath`（R4.4）；⑤ `cxxflag`/`link_flag` 含 `-I`/`-L`（R2.1）；
⑥ action 命令含 `NAME=value cmd` 或 `cd x &&`（R3.8）；⑦ `mcpp::action` 未声明 role 或输出。

### 3.3 `mcpp.toml` 编辑体验

#### 3.3.1 数据：`data/toml-schema.json`

`tools/generate-toml-schema.mjs` 从 `docs/specs/manifest-semantics.md`（SPEC-004 §2 的平面划分）
与 `docs/04-mcpp-toml.md` 的字段小节生成，人工补**枚举值**与 **legacy 标记**：

```jsonc
{
  "sourceVersion": "2026.10.1.3",
  "sections": [
    { "header": "[package]", "plane": "identity", "doc": "docs/04-mcpp-toml.md#21-package",
      "keys": [
        { "key": "name", "type": "string", "required": true },
        { "key": "standard", "type": "enum", "values": ["c++20","c++23","c++26"], "default": "c++23" },
        { "key": "mcpp", "type": "string", "pattern": "^>=.*", "since": "2026.9.28.3" }
      ] },
    { "header": "[language]", "plane": "legacy", "deprecatedBy": "[package].standard" }
  ],
  "rules": [ { "id": "plane-separation", "messageKey": "toml.rule.planeSeparation" } ]
}
```

#### 3.3.2 功能矩阵

| 功能 | 内容 | 开关（§4） |
|---|---|---|
| 段头补全 | 已有，改为读 schema（平面分组 + legacy 标记） | `mcpp.toml.completion` |
| **键补全** | 已知段的键位置 → 该段全部键（类型、默认值、legacy），已存在的键剔除 | 同上 |
| **枚举值补全** | `standard`、`kind`、`linkage`、`opt_level`、`[profile.*]`、`[target.<cfg>]` selector 词表 | 同上 |
| **悬停** | 段头/键 → 类型、默认值、平面、起始版本、legacy 迁移建议、`docs/04` 章节链接 | `mcpp.toml.hover` |
| **诊断** | ① TOML 语法错误；② 未知段；③ 已知段的未知键；④ `[dependencies]` 里的 `xim:` / `[xlings]` 里的 mcpp 包（SPEC-004 §2）；⑤ `[package].mcpp` 非 `>=` 形式（SPEC-007 R9.8）；⑥ legacy 键；⑦ `[[...]]` 数组表 | `mcpp.toml.diagnostics.*`（**未知段/未知键默认 warning**） |
| **跳转** | `workspace = true` → `[workspace.dependencies]` 同名键；`path = "../x"` → 那个 `mcpp.toml` 的 `[package]`；`features = ["a"]` → `[features.a]` | `mcpp.toml.navigation` |
| **依赖版本补全** | 在 `[dependencies]` 的值位置给候选版本 | `mcpp.toml.indexCompletion`（**默认 false**） |
| 格式化 | **不做** | — |

**依赖版本补全的诚实边界**（本方案唯一的"解析人类输出"例外）：
`mcpp search <name>` **没有机读格式**（实测 `mcpp search --help` 只有人类列表 +
`--all-versions`），而且它默认会刷新索引（联网）。因此：

- 默认关闭，开启时给一次性提示"这会执行 mcpp 并可能联网"；
- 用 `mcpp search <name> --all-versions` + `mcpp.toml.indexCompletionTimeoutSeconds`（默认 20 s）；
- 解析 `名称 (版本)` 行，**按会话缓存**，失败/超时/离线即静默降级为"无候选"；
- 在 `docs/mcpp-toml.md` 写明这是临时方案，**mcpp 一旦提供机读格式就替换**。

### 3.4 缓存统计与清理

#### 3.4.1 可用数据（本机实测）

| 命令 | 数据 | 机读 |
|---|---|---|
| `mcpp cache list --format json` | kind `mcpp.cache`：`data.root` + `data.entries[]`，每条 `{accessed(Unix 秒), bytes, complete, dir, files, key, kind, label}`。实测 **657 条 / 7.20 GiB / pkg 576 · std 81 / 2 条 incomplete / 83 个 label / 最旧 2026-09-23** | ✅ 信封 |
| `mcpp cache dir` | 缓存根 + `legacy (unused, removable with mcpp cache clean --legacy): <path>` | ❌ 文本 |
| `mcpp cache info <pkg>` | `dir/key/package/size/file count/last used/complete/inputs(JSON)` | ❌ 文本 |
| `mcpp cache verify` | 校验条目清单与磁盘 | ❌（看退出码与文本） |
| `mcpp cache prune --older-than <N{s\|m\|h\|d}>` | 按未使用时长丢弃 | — |
| `mcpp cache gc --max-size <N{MiB\|GiB}> --older-than <N{s\|m\|h\|d}>` | LRU 收敛到预算 | — |
| `mcpp cache clean [--deps\|--std\|--all\|--legacy]` | 分类清空 | — |
| `mcpp clean [--stale] [--older-than …] [--dry-run] [--bmi-cache]` | 见 §3.4.2 | `--dry-run` 文本 |

`target/` 体积只能自己 walk。mcpp 明确写"`target/` 下的内容不是接口"，因此：体积一律标
**"估算"**；**"过期集合"的权威来源永远是 `mcpp clean --dry-run`**；walk 失败显示"未知"。

#### 3.4.2 两级清理

| 级别 | 按钮 | 命令 | 语义 |
|---|---|---|---|
| **L1** | 清理项目产物 | `mcpp clean` | 删整个 `target/` |
| **L2** | 清理过期产物 | `mcpp clean --stale --older-than <N>d` | 只删"不是当前构建"的 fingerprint 目录，保留最近 N 天 |

`N` = `mcpp.cache.staleDays`，默认 **3**（下拉 1 / 3 / 7 / 30 / `0`＝一个都不留）。
不写时 mcpp 用 1 天，我们显式写出以保证可预期。

**全局缓存不并入这两级**（`--bmi-cache` 会清掉所有工程共享的缓存 → 全量重建）。
「连全局缓存一起清」只作为 L1 确认框里**第三个、默认不勾选**的选项。

#### 3.4.3 全局缓存：暴露更多功能 + 更好的可视化

| 能力 | 命令 | 危险级 | 说明 |
|---|---|---|---|
| 浏览 | `cache list --format json` | 只读 | 树：按包分组 → 展开到条目（key/大小/最近使用/完整） |
| 详情 | `cache info <pkg>` | 只读 | 原文展示到只读预览文档（**不解析**） |
| 校验 | `cache verify` | 只读 | 报告损坏/缺失条目；失败项高亮 + "查看输出" |
| 按时间收敛 | `cache prune --older-than <N>d` | 中 | 默认 `mcpp.cache.pruneAgeDays` = 30 |
| 按预算收敛 | `cache gc --max-size <N>GiB [--older-than …]` | 中 | 默认预算 `mcpp.cache.gc.defaultBudgetGiB`（0 = 每次追问） |
| 分类清空 | `cache clean --deps` / `--std` / `--all` | 高 | 逐级更重的确认 |
| 清遗留 | `cache clean --legacy` | 低 | pre-v1 `$MCPP_HOME/bmi` |

**可视化（webview 面板 `mcpp: 缓存统计`，纯 CSS + 内联 SVG，无图表库、无网络、严格 CSP）**

1. **顶部两个大数字**：全局缓存 / 项目产物，各带"上次采集时间"；
2. **构成条**：按 `kind`（pkg / std）+ pre-v1 遗留 的横向堆叠条，颜色语义见 §3.5；
3. **年龄分布条**：把条目按 `accessed` 分桶（`<1d` / `1–7d` / `7–30d` / `>30d`，桶由
   `mcpp.views.cache.ageBuckets` 配置）→ 直观回答"能回收多少"；
4. **Top N 表**（`mcpp.views.cache.topN`，默认 5）：label / 条目数 / 大小 / 最旧使用。
   行内只提供「详情」（`cache info` 原文预览）与「复制命令到终端」——
   ⚠ **mcpp 没有"按包删除"的命令**（`cache clean` 只有 `--deps/--std/--all/--legacy` 四档），
   所以**不提供按包删除**，避免做出一个假的按钮；
5. **预算模拟器**：选目标 GiB → 本地按 `accessed` 升序做 LRU 模拟 → 预估"将删除 N 条 / 释放 X"。
   标注为**预估**（mcpp 的 LRU 还受 `complete` 等影响），执行后以 mcpp 输出为准；
6. **不完整条目**区块：`complete=false` 的条目列出 + 一键 `cache verify`；
7. **pre-v1 遗留**区块：来自 `cache dir`，一键清理；
8. **项目产物**区块：按 triple 分组的条形 + 「过期产物 N 项 / X MiB」（来自 `clean --dry-run`）。

**危险操作分级**（`cache clean --all` **照评审意见暴露**，但确认最重）：

| 级 | 操作 | 确认方式 |
|---|---|---|
| 1 只读 | `list` / `dir` / `info` / `verify` | 无 |
| 2 中 | `prune --older-than` / `gc --max-size` | **必看预演**（列出将删除或预估释放；`clean --dry-run` 原文） |
| 3 高 | `clean --deps` / `--std` | modal，标题写明将释放的字节数 |
| 4 极重 | **`clean --all`** | **两步**：modal（写明"将删除本机所有 mcpp 工程共享的包缓存与标准库模块条目"）+ 二次勾选确认 |
| 5 最重 | L1 清理 + `--bmi-cache` | modal + 二次勾选 + 文案点名"会影响本机所有 mcpp 工程" |

所有清理都要求受信任工作区、走现有 `McppOperationRegistry`（与 build 互斥）、**绝不自动执行**。
`mcpp.cache.gc.confirmAboveGiB`（默认 1）保证任何超过 1 GiB 的收敛动作都至少有 modal。

### 3.5 配色与可视化设计系统

单一来源 `src/views/theme.ts` + `media/*.css`。**所有颜色只用 VS Code 主题令牌**。

| 语义 | 令牌 | 用途 |
|---|---|---|
| 工程 / 主色 | `--vscode-charts-blue` | 工程视图、构建数值 |
| 缓存 / 正常 | `--vscode-charts-green` | 缓存总量、完整条目 |
| 标准库缓存 | `--vscode-charts-purple` | `kind: std` 分段 |
| 过期 / 可清理 | `--vscode-charts-yellow` | 过期产物、L2 按钮 |
| 警告 | `--vscode-charts-orange` + `$(warning)` | 不完整条目、超阈值 |
| 危险 | `--vscode-errorForeground` | L1 确认、`--bmi-cache` |
| C++ 语义（mcppls） | `--vscode-charts-blue` + `$(beaker)` | 「C++ Modules」视图、状态项 |
| 次要文字 | `--vscode-descriptionForeground` | 单位、时间、计数 |
| 进行中 | `--vscode-progressBar-background` + `$(sync~spin)` | 状态栏、视图 |

- 贡献两个可覆盖颜色 ID：`mcpp.cacheOkForeground`、`mcpp.cacheStaleForeground`
  （与 mcppls 的 `mcppls.statusReadyForeground` 同做法）。
- 图标只用 codicon：`$(tools)` 构建、`$(play)` 运行、`$(beaker)` 测试、`$(trash)` 清理、
  `$(database)` 缓存、`$(graph)` 统计、`$(refresh)` 刷新、`$(history)` 按时间、`$(check)` 校验、
  `$(warning)` 警告、`$(package)` 包、`$(chip)` 工具链、`$(target)` 目标、`$(sync~spin)` 进行中、
  `$(settings-gear)` 配置面板。
- **数字格式化统一**（`src/util/format.ts`）：字节按 `mcpp.ui.numberFormat`（默认二进制 `GiB`）；
  三位有效数字；时间相对（"3 天前"）+ 悬停绝对时间；计数千分位。
- **三态设计**：每个视图/面板都要有「空 / 加载（`$(sync~spin)` + 上次采集时间）/
  错误（`$(error)` + 一行原因 + 打开输出频道）」。
- **通知策略**：modal 只用于不可逆操作（`mcpp.ui.confirmDestructiveOnly`）；成功默认不弹 toast；
  失败弹 toast + "查看输出"；同一原因去重 `mcpp.ui.notifications.dedupeMinutes`。
- **状态栏**：一个 `mcpp` 项（priority 40）：`$(tools) mcpp` / `$(sync~spin) mcpp: 构建中` /
  `$(warning) mcpp: 缓存 8.1 GiB`。tooltip = 工程 + 工具链 + target + 缓存。
- **快捷键**：`ctrl+alt+b` 构建、`ctrl+alt+r` 运行、`ctrl+alt+t` 测试、`ctrl+alt+m` 菜单、
  `ctrl+alt+,` 配置面板。清理类**不给快捷键**。
- **与 mcppls 的视觉边界**（v3 修订）：**不新增第二个状态栏项**（mcppls 已有 C++ Language
  Status Item）；输出频道保持独立（`mcpp`）与 `C++ Modules` 并列；但我们**新增第三个视图
  「C++ Modules」**（§3.9），并在它的标题/描述里**明确标注提供方**，只做展示与转发，
  不冒充 mcppls、不复制它的状态项。

### 3.6 UI 形态（已定 U2）

> v1/v2 比较过三种形态：**U1**（只加命令面板 + 状态栏，视觉侵入最低、可发现性差）、
> **U2**（Activity Bar 容器 + 2 TreeView + 1 Webview 面板，可视化最好）、
> **U3**（只加一个控制面板，折中）。评审选定 **U2**；**U1 保留为兜底**——状态栏项与命令面板
> 永远可用，视图容器被拖走或视图报错时功能不减；U3 作为"若 Activity Bar 的侵入感被否决"的
> 退路，面板内做同样的可视化，只是没有常驻条目。

```
mcpp                                   ← Activity Bar 容器 $(tools)
├── 工程 (mcpp.project)                ← TreeView
│   ├── greeter 0.1.0 · c++23
│   ├── 工具链 llvm@22.1.8 · target x86_64-unknown-linux-gnu
│   ├── 目标 greet (bin) · 测试 tests/
│   └── [$(tools) 构建] [$(play) 运行] [$(beaker) 测试]
├── 缓存 (mcpp.cache)                  ← TreeView
│   ├── 项目产物 … 1.4 GiB（估算）· 3 个 fingerprint
│   │   ├── 过期产物 12 项 · 820 MiB   [$(trash) 清理过期产物…]
│   │   └── [$(trash) 清理项目产物…]
│   ├── 全局构建缓存 … 7.20 GiB · 657 条目
│   │   └── [$(refresh) 刷新] [$(graph) 统计面板] [$(history) 收敛到预算…] [$(check) 校验]
│   └── pre-v1 遗留缓存 … 167.5 MiB    [$(trash) 清理遗留缓存]
└── C++ Modules (mcpp.languageServer)  ← TreeView，由 mcppls 提供内容（§3.9）
    ├── 状态 ready · 引擎 clangd 23.1.0 · 问题 0
    └── [$(refresh) 重启] [$(output) 日志] [$(report) 诊断报告] …
```

**兜底**：状态栏项与命令面板永远可用；即使视图容器被用户拖走或视图报错，
所有功能仍可从命令面板触达。

**新增命令清单**（全部用 `mcpp.` 前缀；**绝不使用 `mcppls.` 前缀**，见 `.agents/docs/mcppls-integration.md` §3）

| 命令 ID | 标题 | 分类 | 视图内联 | 备注 |
|---|---|---|---|---|
| `mcpp.openSettings` | mcpp: 打开设置面板 | mcpp | — | §4.3 |
| `mcpp.showCachePanel` | mcpp: 缓存统计 | mcpp | ✅ 缓存视图 | §3.4.3 |
| `mcpp.refreshCacheStats` | mcpp: 刷新缓存统计 | mcpp | ✅ 缓存视图 | 只读 |
| `mcpp.cleanStaleArtifacts` | mcpp: 清理过期产物 | mcpp | ✅ 项目产物 | L2，必看预演 |
| `mcpp.cleanProjectArtifacts` | mcpp: 清理项目产物 | mcpp | ✅ 项目产物 | L1；替换现有 `mcpp.clean` |
| `mcpp.gcGlobalCache` | mcpp: 收敛全局缓存… | mcpp | ✅ 全局缓存 | `cache gc --max-size` |
| `mcpp.pruneGlobalCache` | mcpp: 按时间清理缓存… | mcpp | ✅ 全局缓存 | `cache prune --older-than` |
| `mcpp.verifyGlobalCache` | mcpp: 校验缓存 | mcpp | ✅ 全局缓存 | 只读 |
| `mcpp.cleanLegacyCache` | mcpp: 清理遗留缓存 | mcpp | ✅ 遗留缓存 | `cache clean --legacy` |
| `mcpp.showCacheEntry` | mcpp: 查看缓存条目详情 | mcpp | ✅ 条目 | `cache info` 原文 |
| `mcpp.updateDependencies` | mcpp: 更新依赖 | mcpp | ✅ 工程视图 | `mcpp update`，带预演 |
| `mcpp.selfDoctor` | mcpp: 环境诊断 | mcpp | — | `mcpp self doctor` |
| `mcpp.selfCheck` | mcpp: 环境自检 | mcpp | ✅ 工程视图 | §2.6 |
| `mcpp.explainCode` | mcpp: 解释错误码… | mcpp | — | `mcpp self explain` |
| `mcpp.addDependency` | mcpp: 添加依赖… | mcpp | ✅ 工程视图 | `mcpp add` 向导 |
| `mcpp.removeDependency` | mcpp: 移除依赖… | mcpp | ✅ 工程视图 | `mcpp remove` |
| `mcpp.searchPackages` | mcpp: 搜索包… | mcpp | — | `mcpp search` |
| `mcpp.openMcpplsSettings` | mcpp: 打开 C++ Modules 设置 | mcpp | — | 只打开别人的设置页，**不写** |

**转发 mcppls 的命令**（§3.9；同样用 `mcpp.` 前缀，**不是** `mcppls.`）

| 命令 ID | 标题 | 视图内联 | 危险 | 转发到 |
|---|---|---|---|---|
| `mcpp.languageServer.refreshState` | mcpp: 刷新 C++ Modules 状态 | ✅ C++ Modules | none | （只读 `readState`） |
| `mcpp.languageServer.restart` | mcpp: 重启 C++ Modules 语言服务 | ✅ | none | `mcppls.restartServer` |
| `mcpp.languageServer.restartEngine` | mcpp: 重启 clangd… | ✅ | confirm | `mcppls.restartClangd` |
| `mcpp.languageServer.resetWorkspaceCache` | mcpp: 重置本工作区缓存… | ✅ | **destructive** | `mcppls.resetWorkspaceCache` |
| `mcpp.languageServer.selectContext` | mcpp: 选择 C++ 模块分析上下文 | ✅ | none | `mcppls.selectContext` |
| `mcpp.languageServer.showModuleGraph` | mcpp: 查看模块图 | ✅ | none | `mcppls.showModuleGraph` |
| `mcpp.languageServer.showLogs` | mcpp: 打开 C++ Modules 日志 | ✅ | none | `mcppls.showLogs` |
| `mcpp.languageServer.collectReport` | mcpp: 收集 C++ Modules 诊断报告 | ✅ | none | `mcppls.collectReport` |
| `mcpp.languageServer.exportDiagnosticBundle` | mcpp: 导出 C++ Modules 诊断包… | ✅ | none | `mcppls.exportDiagnosticBundle` |
| `mcpp.languageServer.runBuildToolInTerminal` | mcpp: 在终端运行构建工具… | ✅ | confirm | `mcppls.runBuildToolInTerminal` |
| `mcpp.languageServer.manageConflicts` | mcpp: 处理其它 C++ 语言特性… | ✅ | confirm | `mcppls.turnOff/turnOnOtherCppFeatures` |
| `mcpp.languageServer.toggleInWorkspace` | mcpp: 在本工作区启用/停用 C++ Modules… | ✅ | confirm | `mcppls.turnOn/turnOffInWorkspace` |
| `mcpp.languageServer.installTools` | mcpp: 安装 C++ Modules 命令行工具… | ✅ | confirm | `mcppls.installCommandLineTools` |
| `mcpp.languageServer.reviewChanges` | mcpp: 审查工作区改动 | ✅ | none | `mcppls.review.run` / `review.clear` |

> 现有 4 个转发命令（`mcpp.configureLanguageServer`、`mcpp.checkModuleSupport`、
> `mcpp.showModuleGraph`、`mcpp.showLanguageServerLogs`）**保留为弃用别名**，
> 指向上表的新 ID —— 与 `mcpp.configureClangd → mcpp.configureLanguageServer` 同一套做法。

现有 `mcpp.clean` 保留为 `mcpp.cleanProjectArtifacts` 的弃用别名（与
`mcpp.configureClangd → mcpp.configureLanguageServer` 的既有做法一致）。

### 3.7 国际化（i18n）：中/英跟随 VS Code

| 面 | 做法 |
|---|---|
| `package.json` 用户可见字符串 | `%key%` 占位；`package.nls.json`（英，默认）+ `package.nls.zh-cn.json`（中）。覆盖 `displayName`、`description`、命令标题、设置标题/描述/弃用信息、`untrustedWorkspaces.description` |
| 运行期字符串 | 单一来源 `data/i18n/{en,zh-cn}.json` → `tools/generate-l10n.mjs` 生成 `l10n/bundle.l10n.json` + `l10n/bundle.l10n.zh-cn.json` |
| 解析 | `src/i18n/t.ts`：`mcpp.ui.language === "auto"` → `vscode.l10n.t(key)`；否则读自带表 |
| webview | `getHtml` 时把当前语言的字符串注入，或 `vscode.l10n.uri` |
| 防漏翻译 | `tools/l10n-check.mjs`：`l10n.t(` 的字面量与 bundle 键集合比对；`package.nls.zh-cn.json` 覆盖所有 `%key%`；缺失即 CI 失败 |
| 测试影响 | `test/artifacts.test.ts` 现在断言中文字面量 → 改为断言 `%key%` 形态 + nls 覆盖完整 |

**第一版范围（已定）**：`package.nls.*` **100% 覆盖**（命令标题、设置项、弃用信息）+
**关键流程文案**（命令成功/失败、清理确认、降级提示、进度标题）100%；
其余运行期文案随各里程碑渐进迁移，但 `l10n-check.mjs` 从第一天起就阻止**新增硬编码**。

**必须写进 docs 的 API 限制**：`mcpp.ui.language` 的手动覆盖**只影响运行时提示与我们的面板**；
命令面板标题、原生设置页里的设置名称**永远跟随 VS Code 语言**（VS Code 在启动时读
`package.nls.*`，无法运行时切换）。所以用户在 `zh-cn` 界面下把 `mcpp.ui.language` 设成 `en`
会看到"设置名是中文、提示是英文"的混搭 —— 这是有意提供的逃生门，不是缺陷。

### 3.8 mcpp 相关功能补齐

| 功能 | 说明 | 优先级 |
|---|---|---|
| 工程视图 | 包名/版本/标准/目标/工具链/target/profile | 高 |
| 缓存视图 + 面板 + 两级清理 + 全局缓存功能 | §3.4 | 高 |
| 配置面板 | §4 | 高 |
| `mcpp update` | 重解析依赖并改写 `mcpp.lock`，带"将改动 N 个包"的预演 | 高 |
| `mcpp self doctor` | 环境诊断 → 频道 + 结构化摘要 | 高 |
| `mcpp: 环境自检` | §2.6 | 高 |
| `mcpp add` / `remove` | 依赖编辑向导，与 `mcpp.toml` 键补全联动 | 中 |
| `mcpp search` | 包搜索 → 插入依赖（复用 §3.3.2 的 search 适配层） | 中 |
| `mcpp self explain <CODE>` | 失败时一键解释 | 中 |
| `mcpp pack` / `publish --dry-run` | 打包与发布前检查 | 低 |

### 3.9 把 mcppls 的状态与管理并入 mcpp

> 目标（评审意见）：**把 mcppls 的核心状态与管理纳入 mcpp**——LSP 状态、引擎、构建描述、
> 问题、缓存情况与清理、诊断包等，让用户在**一个地方**看清并操作。
> 硬约束仍然是：**不改 mcppls**，所以这里的一切都建立在"**读它已有的状态**"
> 和"**转发它已有的命令**"之上，绝不重新实现、绝不写它的内部文件。

#### 3.9.1 能读到什么：三条通道，各有明确边界

| 通道 | 内容 | 契约强度 | 本方案的用法 |
|---|---|---|---|
| **A. 扩展元数据** | `packageJSON.version`、`isActive`、`contributes.commands`、平台 VSIX 是否存在、`mcppls.enable` 的当前值（只读配置） | **正式、稳定** | 基础信息与能力探测 |
| **B. `extension.exports`** | mcppls 的 `activate()` 返回一个对象（它对内是"测试 API"），其中 **`lastStatus()` 返回完整的 `CxxModulesStatus`**、`statusBarText()`、`serverRunning()`、`serverEnabled()`、`serverCommands()`、`environment()`、`waitForState()` | ⚠️ **非契约**：它是测试 API，字段可能随 mcppls 变化 | **尽力而为读取**，见 §3.9.2 |
| **C. 转发命令** | §2.1 的 `forward` 能力表（重启、重启引擎、重置缓存、报告、诊断包、冲突处理、启用/停用、在终端运行构建工具、review） | **命令 ID 是事实契约**（同现状） | 所有"管理"动作 |
| ~~D. LSP `cxxModules/status`~~ | 真正的契约来源 | 正式 | ❌ **不可用**：本扩展没有 LSP 客户端，且 CI 明确禁止再建一个 |
| ~~E. mcppls 的磁盘缓存/日志文件~~ | 缓存目录、模型、引擎数据库 | **内部布局，不是接口** | ❌ **不读、不解析、不删除** |

`CxxModulesStatus` 的形状是 **S3 规范级契约**（`docs/specs/s3-lsp-extensions.md` §4），
所以"内容怎么解释"是稳定的；不稳定的只是"能不能拿到这个对象"。这决定了下面的防御写法。

#### 3.9.2 `readState`：尽力而为，坏掉就降级

```ts
// src/mcppls/state.ts —— 只有一个入口，返回"一定有值"的视图模型
export interface McpplsStateView {
  available: boolean;            // false ⇒ 只有降级内容
  version?: string;
  active: boolean;
  enabled: boolean;              // 只读 mcppls.enable
  state?: "starting" | "loading" | "preparing" | "ready" | "degraded" | "error";
  project?: { root: string; source: string; level?: number; tier?: number };
  profile?: { kind: string; compiler?: string; stdlib: string; target: string; standard?: string };
  engine?: { name: string; version: string };
  engines?: Array<{ name: string; version: string; role: string; state: string }>;
  progress?: { done: number; total: number };
  issues?: Array<{ code: string; message: string; command?: { command: string; arguments?: unknown[] } }>;
  notices?: Array<{ code: string; message: string }>;
  onlineRun?: { outcome: string; message: string; at: string };
}

export function readState(): McpplsStateView;
```

读取纪律（每一条都会写成测试）：

1. `getExtension(id)?.exports` 必须是对象，`typeof exports.lastStatus === "function"`，
   否则 `available: false`——**不抛错、不提示、只是少一块内容**；
2. `lastStatus()` 包在 `try/catch` 里；
3. 返回值必须是对象且 `state` 属于 S3 枚举的六个值之一，否则视为**未知形状** → `available: false`；
4. `issues[].code` 与 `engines[].state` 都用**白名单**渲染，未知值原样显示文本但**不解释**；
5. `readState` 由设置 `mcpp.languageService.readState`（默认 `true`）控制，可完全关闭；
6. **不主动轮询**：以 `vscode.extensions.onDidChange` + 我们自己的命令完成回调 +
   `mcpp.languageService.stateRefreshSeconds`（默认 0 = 关）为触发点；高频轮询被明确排除；
7. 视图渲染**永远不因 `readState` 失败而报错**（不变式 ④）。

`issues[].command` 是 **S3 自带的"修复动作"**（"an optional action that fixes the issue"）。
我们把它渲染成按钮并**直接 `executeCommand(issue.command.command, ...args)`** ——
这是契约内的字段，比我们自己猜修复方式更可靠。典型如 `producer-needs-download`
（`askOnline: true`）→ 提示用户是否允许联网重述工程。

#### 3.9.3 缓存与管理：能做的做，做不到的**不假装**

| 用户想要 | mcppls 侧的可用手段 | 本方案 |
|---|---|---|
| 看 LSP 状态 | `readState()` 的 `state` / `project` / `profile` / `engine(s)` / `progress` | ✅ 视图 + 环境自检 |
| 看模块问题 | `readState()` 的 `issues` / `notices`，含修复命令 | ✅ 逐条列出 + 修复按钮 |
| 看构建描述 | `readState().project.{source, level, tier}` | ✅（**条数/单元数**只有 `mcppls check`/`model` 才有，见下） |
| 看引擎 | `readState().engine` / `engines[]` | ✅ |
| 重启语言服务 / 重启 clangd | `mcppls.restartServer` / `mcppls.restartClangd` | ✅ `confirm` |
| **清理 mcppls 的缓存** | `mcppls.resetWorkspaceCache`（它自己的"重置本工作区缓存"） | ✅ **`destructive` + modal 确认**；确认框写明"会清掉本工作区的模型缓存并重新准备，可能耗时数分钟；**不影响** mcpp/全局构建缓存与项目 `target/`" |
| **mcppls 缓存的体积 / 占比 / 可视化** | ❌ 缓存目录**不在** `environment()` 里（它只给 version / vscode / appName / appHost / uiKind / platform / remote），也没有公开命令返回路径或大小；磁盘布局是内部实现 | ❌ **不做**。视图里给"**打开日志**""**收集诊断报告**""**导出诊断包**"三个入口，并在该区块写明"缓存由 C++ Modules 扩展自行管理，本扩展不读取其内部目录"。**向上游提 change request**（附录 D.5）：注册一个返回缓存目录/体量的命令 |
| 看诊断 | `readState().issues` + `mcppls.showLogs` + `mcppls.collectReport` / `exportDiagnosticBundle` | ✅ |
| 关掉别的 C++ 扩展 | `mcppls.turnOffOtherCppFeatures` / `restoreOtherCppFeatures` | ✅ `confirm` |
| 在本工作区启用/停用 C++ Modules | `mcppls.turnOnInWorkspace` / `turnOffInWorkspace`（它们写 `mcppls.enable`，是 mcppls 自己的命令） | ✅ `confirm`；视图里显示当前值（只读） |
| 在终端运行构建工具 | `mcppls.runBuildToolInTerminal` | ✅ `confirm` |
| Review Changes | `mcppls.review.run` / `review.clear`（服务器命令，受 `mcppls.ai.enabled` 约束） | ✅ 仅在能力可用时显示，**只转发** |

> **为什么"构建描述条数"要打折**：`readState()` 只给 `source/level/tier`，不给条目数。
> 想要"6 entries / 2 std units"这种数字，只能跑 `mcppls check <file>` 或 `mcppls model`
> —— 那是**另起一个进程加载工程**（重则数分钟），不适合放进视图。
> 因此本方案的视图**不显示假的条目数**；重信息只在用户**显式点击**
> "环境自检 / 收集诊断报告"时由 mcppls 自己产出。

#### 3.9.4 UI：第三个视图

`mcpp` 容器新增 **「C++ Modules」** 视图（`mcpp.languageServer`），`package.json` 的
`views.when` = `mcpp.hasMcppls`（mcppls 存在才显示）。**必须**在视图 `name`/`description`
里写清提供方，避免冒充：

```
C++ Modules（由 sunrisepeak.mcpp-language-server 提供，此视图只做展示与转发）
├── 状态          ready · 项目 greeter · 级别 3
├── 语义配置      clangd 22.1.8 · libc++ · x86_64-linux-gnu · c++26
├── 构建描述      mcpp（来源）· S1 level 3 · tier 1
├── 引擎          clangd 23.1.0 [core/ready] · mcppls [modules/ready]
├── 问题（2）     $(warning) producer-needs-download  …   [$(lightbulb) 允许联网重述]
│                 $(error)   unresolved-module          …
├── 通知（1）     $(info)    上游写入工程目录
├── 最近在线运行   fetched · 2026-10-02T12:40:11Z          （仅有值时显示）
└── 操作
    [$(refresh) 重启语言服务] [$(chip) 重启 clangd…] [$(history) 重置本工作区缓存…]
    [$(symbol-interface) 选择上下文] [$(type-hierarchy) 模块图] [$(output) 打开日志]
    [$(report) 收集诊断报告] [$(package) 导出诊断包…] [$(debug-alt) 在终端运行构建工具…]
    [$(settings-gear) 打开 C++ Modules 设置] [$(circle-slash) 在本工作区停用…]
```

- 问题条目：`$(warning)` / `$(error)` 图标按 `code` 白名单着色（`charts-yellow` / `errorForeground`），
  有 `command` 的显示 `$(lightbulb)` 按钮；
- 状态项用 `charts-green`（ready）/ `charts-yellow`（degraded）/ `errorForeground`（error），
  `starting|loading|preparing` 用 `$(sync~spin)`；
- 多根工作区：按 workspace folder 分组（S3 明确每 root 一条状态）；
- **空态**：mcppls 未安装/未启用 → 一行说明 + "安装/启用 C++ Modules"按钮；
  `readState` 不可用 → "已安装的 mcppls（0.0.x）未暴露状态；下列操作仍可用"；
- **不新增第二个状态栏项**。想要的话，`mcpp.ui.statusBar.showLanguageServer`（默认 **false**）
  会在我们自己的状态栏项里追加一段 `· C++ Modules: ready`，tooltip 里说明"状态由 mcppls 提供"。

#### 3.9.5 与 mcppls 自己的 UI 的关系

mcppls 已经有一个 C++ Language Status Item、一个 "C++ Modules" 输出频道和一批调色板命令。
本视图**不取代**它们，定位是：

- **mcpp 工程视角的汇总**：把"这个工程的 mcpp 侧"和"这个工程的 C++ 语义侧"放在同一棵树里；
- **可发现性**：把 mcppls 散落在命令面板里的管理动作变成可见按钮；
- **诊断入口**：问题 → 修复命令 / 日志 / 诊断包，一条路径走完。

因此**不复制** mcppls 的状态栏项，**不合并**输出频道，**不代理**它的设置写入
（唯一例外是转发它自己的 `turnOn/TurnOffInWorkspace` 命令，那仍然由 mcppls 执行）。

---

## 4. 主线 D：统一配置模块与配置面板

> 设计目标来自评审意见：「凡可配置的功能都要支持配置；配置功能作为独立模块统一管理」。
> **上游先例**：mcppls 就是这么做的 —— `src/config/settings.cppm` 是唯一的配置注册表，
> 文档、`package.json`、命令行全部由它派生，并由 `tests/test_settings.cpp` 把三者钉在一起。
> 本方案采用同一套思路。

### 4.1 单一事实源 `data/config-registry.json`

```jsonc
{
  "version": 1,
  "groups": [
    { "id": "project", "titleKey": "config.group.project", "order": 10 },
    { "id": "cache",   "titleKey": "config.group.cache",   "order": 60 }
  ],
  "settings": [
    {
      "key": "mcpp.cache.staleDays",
      "type": "number",
      "default": 3,
      "minimum": 0,
      "maximum": 365,
      "scope": "resource",              // resource | window | machine-overridable
      "group": "cache",
      "order": 40,
      "titleKey": "config.cache.staleDays.title",
      "descriptionKey": "config.cache.staleDays.description",
      "applies": "next-clean",          // immediate | next-build | next-clean | view-reload
      "advanced": false,
      "tier": "public",                 // public | advanced（§4.6）
      "since": "0.5.0",
      "docs": "docs/cache.md#staledays",
      "aliases": []
    }
  ]
}
```

每个条目回答四件事：**是什么、默认什么、什么时候生效、在文档哪一节**。

### 4.2 由 registry 派生的四样东西

| 产物 | 由谁生成 | 门禁 |
|---|---|---|
| `package.json` 的 `contributes.configuration` | **手写，但由 `tools/check-config.mjs` 做语义一致性校验**（key 集合、type、default、enum、scope、标题 key） | CI：不一致即失败并提示"运行 `npm run gen:config` 同步" |
| `package.nls.json` / `package.nls.zh-cn.json` 的设置文案骨架 | `tools/generate-config.mjs` 生成骨架，人工填中文 | `l10n-check.mjs` 覆盖门禁 |
| `docs/settings.md` 的设置表 | `tools/generate-config.mjs` 生成表格 | `git diff --exit-code` |
| 配置面板 + `mcpp: 环境自检` 的"已改设置"清单 | 运行期读 `src/config/registry.ts` | 单测 |

> 为什么不直接生成 `package.json`：JSON 往返会重排整个文件，产生无法 review 的巨 diff。
> 语义校验比文本生成更稳。

### 4.3 配置面板（`mcpp: 打开设置面板`）

- webview，按 registry 的 `groups` 分节渲染；纯 HTML/CSS/JS，严格 CSP，无网络，无框架；
- **每一行**：标题、说明、控件（checkbox / 下拉 / 数字 / 路径选择 / 字符串数组）、
  **当前生效值 + 来源**（默认 / 用户 / 工作区 / 工作区文件夹）、`applies` 提示
  （"下次清理生效"）、「重置为默认」、「在原生设置中打开」（`workbench.action.openSettings`
  + `@ext:mcpp-community.mcpp-vscode <key>`）；
- 工具栏：搜索、**仅显示已修改**、分组折叠、预设（**默认 / 极简 / 重度使用 / 只读浏览**）、
  导出/导入设置 JSON、全部重置；
- 顶部固定一条边界提示：**这里只影响 mcpp-vscode；`mcppls.*` 由 C++ Modules 扩展自己管理，
  这个面板不写它**；并提供"打开 C++ Modules 设置"按钮
  （`workbench.action.openSettings "@ext:sunrisepeak.mcpp-language-server"`）；
- `advanced: true` 的条目默认折叠；
- 多根工作区：按工作区文件夹分别显示"工作区值"，并显示最终生效值；
- 写入走 `WorkspaceConfiguration.update(key, value, target)`，`resource` 型设置必须带 URI。

### 4.4 完整设置清单

> 这是评审意见「很多功能可以做成配置的都要支持配置」的落地。共 **60 项**，全部有默认值，
> 且**默认值一律是"不打扰"**。`advanced` 标记表示面板默认折叠。

**工程**

| key | 类型 | 默认 | 作用域 | 生效 |
|---|---|---|---|---|
| `mcpp.path` | string | `""` | resource | immediate |
| `mcpp.project.discoveryBoundary` | `workspaceFolder` \| `filesystem` | `workspaceFolder` | resource | immediate |

**任务**

| key | 类型 | 默认 | 作用域 | 生效 |
|---|---|---|---|---|
| `mcpp.task.buildArgs` | string[] | `[]` | resource | next-build |
| `mcpp.task.runArgs` | string[] | `[]` | resource | next-build |
| `mcpp.task.testArgs` | string[] | `[]` | resource | next-build |
| `mcpp.task.cleanArgs` | string[] | `[]` | resource | next-clean |
| `mcpp.task.confirmClean` | boolean | `true` | resource | immediate |
| `mcpp.task.revealTerminal` | `always` \| `onFailure` \| `never` | `always` | resource | immediate |
| `mcpp.task.focusTerminal` | boolean | `false` | resource | immediate |
| `mcpp.task.clearTerminal` | boolean | `true` | resource | immediate |
| `mcpp.task.problemMatcher` | boolean | `true` | resource | immediate |
| `mcpp.task.editorTitleButtons` | boolean | `true` | resource | immediate |

**语言服务（mcppls 桥接与状态）**

| key | 类型 | 默认 | 作用域 | 生效 |
|---|---|---|---|---|
| `mcpp.languageService.refreshAfterBuild` | `auto` \| `reload` \| `restart` \| `off` | `auto` | resource | immediate |
| `mcpp.languageService.menuItems` | boolean | `true` | resource | immediate |
| `mcpp.languageService.notifyOnDegraded` | boolean | `true` | resource | immediate |
| `mcpp.languageService.readState` | boolean | `true` | resource | immediate |
| `mcpp.languageService.stateRefreshSeconds` | number | `0`（关） | resource | immediate |
| `mcpp.languageService.confirmResetCache` | boolean | `true` | resource | immediate |

**`mcpp.toml` 编辑**

| key | 类型 | 默认 | 作用域 | 生效 |
|---|---|---|---|---|
| `mcpp.toml.completion` | boolean | `true` | resource | immediate |
| `mcpp.toml.hover` | boolean | `true` | resource | immediate |
| `mcpp.toml.navigation` | boolean | `true` | resource | immediate |
| `mcpp.toml.diagnostics.enabled` | boolean | `true` | resource | immediate |
| `mcpp.toml.diagnostics.syntax` | severity | `error` | resource | immediate |
| `mcpp.toml.diagnostics.unknownSection` | severity | **`warning`** | resource | immediate |
| `mcpp.toml.diagnostics.unknownKey` | severity | **`warning`** | resource | immediate |
| `mcpp.toml.diagnostics.planeSeparation` | severity | `warning` | resource | immediate |
| `mcpp.toml.diagnostics.legacyKeys` | severity | `info` | resource | immediate |
| `mcpp.toml.indexCompletion` | boolean | `false` | resource | immediate |
| `mcpp.toml.indexCompletionTimeoutSeconds` | number | `20` | resource | immediate |

（`severity` = `error` \| `warning` \| `info` \| `off`）

**`build.mcpp` 编辑**

| key | 类型 | 默认 | 作用域 | 生效 |
|---|---|---|---|---|
| `mcpp.buildScript.intelligence` | boolean | `true` | resource | immediate |
| `mcpp.buildScript.diagnostics` | boolean | `true` | resource | immediate |
| `mcpp.buildScript.diagnostics.severity` | `warning` \| `info` \| `off` | `warning` | resource | immediate |
| `mcpp.buildScript.imports.knownModules` | boolean | `true` | resource | immediate |
| `mcpp.buildScript.snippets` | boolean | `true` | resource | immediate |

**缓存与清理**

| key | 类型 | 默认 | 作用域 | 生效 |
|---|---|---|---|---|
| `mcpp.cache.statusBar` | boolean | `false` | resource | immediate |
| `mcpp.cache.warnAboveGiB` | number | `0`（关） | resource | immediate |
| `mcpp.cache.staleDays` | number | **`3`** | resource | next-clean |
| `mcpp.cache.autoRefreshSeconds` | number | `0`（关） | resource | immediate |
| `mcpp.cache.estimateProjectBytes` | boolean | `true` | resource | immediate |
| `mcpp.cache.showLegacy` | boolean | `true` | resource | immediate |
| `mcpp.cache.gc.defaultBudgetGiB` | number | `0`（每次追问） | resource | immediate |
| `mcpp.cache.gc.confirmAboveGiB` | number | `1` | resource | immediate |
| `mcpp.cache.pruneAgeDays` | number | `30` | resource | immediate |

**视图**

| key | 类型 | 默认 | 作用域 | 生效 |
|---|---|---|---|---|
| `mcpp.views.project.show` | boolean | `true` | window | view-reload |
| `mcpp.views.cache.show` | boolean | `true` | window | view-reload |
| `mcpp.views.languageServer.show` | boolean | `true` | window | view-reload |
| `mcpp.views.cache.topN` | number | `5` | window | immediate |
| `mcpp.views.cache.ageBuckets` | string[] | `["1d","7d","30d"]` | window | immediate |

**界面与通知**

| key | 类型 | 默认 | 作用域 | 生效 |
|---|---|---|---|---|
| `mcpp.ui.language` | `auto` \| `en` \| `zh-cn` | `auto` | window | immediate |
| `mcpp.ui.statusBar.show` | boolean | `true` | window | immediate |
| `mcpp.ui.statusBar.showLanguageServer` | boolean | **`false`** | window | immediate |
| `mcpp.ui.notifications.success` | `silent` \| `statusBar` \| `toast` | `statusBar` | window | immediate |
| `mcpp.ui.notifications.dedupeMinutes` | number | `5` | window | immediate |
| `mcpp.ui.confirmDestructiveOnly` | boolean | `true` | window | immediate |
| `mcpp.ui.numberFormat` | `binary` \| `decimal` | `binary` | window | immediate |

**诊断与日志**

| key | 类型 | 默认 | 作用域 | 生效 |
|---|---|---|---|---|
| `mcpp.log.level` | `error` \| `warn` \| `info` \| `debug` | `info` | window | immediate |
| `mcpp.diagnostics.selfCheckOnStartup` | boolean | `false` | window | immediate |

**高级（面板默认折叠）**

| key | 类型 | 默认 | 作用域 | 生效 |
|---|---|---|---|---|
| `mcpp.runtime.timeoutSeconds` | number | `30`（0 = 不限） | resource | immediate |
| `mcpp.runtime.maxOutputMiB` | number | `16` | resource | immediate |
| `mcpp.runtime.concurrency` | `perProject` \| `global` | `perProject` | resource | immediate |

**弃用（保留为别名，面板不显示）**：`mcpp.clangd.path`、`mcpp.modulesSupport`、
`mcpp.configureCppTools`、`mcpp.tomlCompletion`（→ `mcpp.toml.completion`）。

### 4.5 配置模块的职责边界

| 归 mcpp-vscode 配置 | 不归 |
|---|---|
| 上表全部 `mcpp.*` | `mcppls.*`（C++ Modules 扩展自己管理，本插件**只读不写**） |
| 面板里明确提示这条边界，并给"打开 C++ Modules 设置"按钮 | 用户的 `clangd.*`（已不在依赖面内） |

### 4.6 第一版公开发布的设置（29 项）

按评审意见，第一版**只在原生设置页与面板的常用区公开这些**；其余进入 `advanced` /
`tier: "advanced"`，默认折叠、文档里可查、面板里可搜到。registry 的每个条目因此多一个
`tier: "public" | "advanced"` 字段。

**public（29 项）**

| 分组 | 键 |
|---|---|
| 工程（1） | `mcpp.path` |
| 任务（8） | `buildArgs`、`runArgs`、`testArgs`、`cleanArgs`、`confirmClean`、`problemMatcher`、`focusTerminal`、`editorTitleButtons` |
| 语言服务（1） | `refreshAfterBuild` |
| `mcpp.toml`（6） | `completion`、`hover`、`navigation`、`diagnostics.enabled`、`diagnostics.unknownSection`、`diagnostics.unknownKey` |
| `build.mcpp`（2） | `intelligence`、`diagnostics` |
| 缓存（4） | `staleDays`、`statusBar`、`warnAboveGiB`、`gc.defaultBudgetGiB` |
| 视图（3） | `views.project.show`、`views.cache.show`、`views.languageServer.show` |
| 界面（3） | `ui.language`、`ui.notifications.success`、`ui.numberFormat` |
| 日志（1） | `log.level` |
| **合计** | **29** |

**advanced（其余，默认折叠）**：`project.discoveryBoundary`、`revealTerminal`、`clearTerminal`、
`languageService.{menuItems,notifyOnDegraded,readState,stateRefreshSeconds,confirmResetCache}`、
`toml.{diagnostics.syntax,diagnostics.planeSeparation,diagnostics.legacyKeys,indexCompletion,indexCompletionTimeoutSeconds}`、
`buildScript.{diagnostics.severity,imports.knownModules,snippets}`、
`cache.{autoRefreshSeconds,estimateProjectBytes,showLegacy,gc.confirmAboveGiB,pruneAgeDays}`、
`views.cache.{topN,ageBuckets}`、`ui.{statusBar.show,statusBar.showLanguageServer,notifications.dedupeMinutes,confirmDestructiveOnly}`、
`diagnostics.selfCheckOnStartup`、`runtime.*`。

> 面板里有一个"显示高级设置"开关；公开与高级**只影响默认展开与设置页排序**，
> 不影响功能可用性。下一版根据使用反馈决定是否把某些项提升为 public。

---

## 5. 实施顺序与里程碑

| 里程碑 | 内容 | 预估 |
|---|---|---|
| **M0** | 目录纯移动 + `docs/superpowers/` → `.agents/superpowers/` + README 中英 + `docs/*` + `tools/` 与 CI 漂移 job 骨架 | 3 天 |
| **M1** | i18n：`data/i18n/*` + `generate-l10n` + `l10n-check` + `package.nls.*` 全量 + 关键流程文案 + 测试改写 | 2–3 天 |
| **M2** | 配置模块：`config-registry.json` + `check-config` + `access/validate/migrate` + `docs/settings.md` 生成 | 2–3 天 |
| **M3** | 配置面板（`mcpp: 打开设置面板`）：分组渲染、来源显示、预设、搜索、仅显示已修改 | 2–3 天 |
| **M4** | 稳定性基座（协议优先、超时分级、错误分层、`mcpp.path` 校验、激活面收敛） | 2–3 天 |
| **M5** | 依赖韧性（能力模型、降级矩阵、五个 stub、`mcpp: 环境自检`） | 2–3 天 |
| **M5.5** | §3.9 mcppls 状态与管理：「C++ Modules」视图、`readState` 适配层、转发命令（13 个）、问题与修复按钮 | 3 天 |
| **M6** | `mcpp.toml` 编辑体验（schema 快照 + 键/值补全 + 悬停 + 诊断 + 跳转 + 依赖版本补全） | 4 天 |
| **M7** | `build.mcpp` 智能（快照 + provider + 静态诊断 + 模块清单 + 片段） | 3–4 天 |
| **M8** | 缓存统计与清理（聚合 + TreeView + 面板可视化 + 预算模拟器 + 命令） | 5 天 |
| **M9** | 视觉与交互统一（主题令牌、三态、状态栏、快捷键、进度） | 2 天 |

M0–M2 先做：M0 定文件位置，M1 定文案写法，M2 定设置写法 —— 后面所有功能都会往这三处加东西，
越晚做返工越大。

---

## 6. 风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| **设置项数量（60 项）本身就是风险** | 认识负担与"简单易用"相矛盾；测试面变大 | 面板默认只展开常用分组，`advanced` 折叠；全部默认"不打扰"；`docs/settings.md` 给"推荐配置"；预设一键切换 |
| 目录大移动污染 review | 触碰所有 import | M0 拆两提交，提交 1 零行为变化 |
| 配置面板与原生设置页重复 | 用户困惑"改了不生效" | 每项显示 `applies` 与**生效值来源**；给"在原生设置中打开"；面板顶部写明与 `mcppls.*` 的边界 |
| 生成的 nls/docs 与 registry 漂移 | 三份文件要同步 | `check-config.mjs` + `l10n-check.mjs` + `git diff --exit-code` 三重门禁 |
| `mcpp.ui.language` 的能力边界 | manifest 文案无法运行时切换 | 写进 `docs/settings.md`；默认 `auto`；定位为"逃生门" |
| 模式 A 下 std 没有符号级补全 | 真实体验缺口 | 文档写清；上游诉求（把构建程序写进 build database）；模式 B 的设计保留在附录 D 备查 |
| 依赖版本补全靠解析人类输出 | 与本方案"JSON 优先"原则冲突 | 明确列为唯一例外、默认关、带超时/离线降级/一次性提示；docs 写明"上游给机读格式就替换" |
| 预算模拟器是本地 LRU 近似 | 与 mcpp 实际策略可能有差异 | 标注"预估"，只用于"选预算"，不承诺删多少；执行后以 mcpp 输出为准 |
| `cache info` 无机器格式 | 详情视图只能展示原文 | 只读预览文档，不解析、不据此决策 |
| U2 的实现成本最高 | TreeView + 面板 + CSP 资源维护面 | 面板可延后到 M8 后半段；先出 TreeView 与命令；逻辑抽成纯函数，UI 只渲染 |
| `onLanguage:cpp` 收敛有副作用 | 无 `mcpp.toml` 的目录不再出现 mcpp 状态栏 | 有意的；写进 CHANGELOG 与 `docs/architecture.md` |
| TreeView/webview 的 e2e 覆盖有限 | Extension Host 里不能点 UI | 逻辑抽纯函数（聚合、格式化、模拟器）单测覆盖；e2e 只断言命令与视图注册 |
| 里程碑估算偏乐观 | M6–M8 都依赖"生成脚本 + 快照 + CI 门禁"三件套 | M0 就把 `tools/` 与漂移 job 骨架搭好 |
| **`extension.exports` 是 mcppls 的测试 API** | 不是契约；上游重构可能让 §3.9 的状态区整块消失 | 形状探测 + try/catch + 枚举白名单；坏掉只少一块内容（不变式 ④）；两个 e2e 夹具（`noapi` / `throwing`）钉住降级行为；由 `mcpp.languageService.readState` 可关 |
| **mcppls 的缓存体量无法可视化** | 缓存目录不在任何公开面里（`environment()` 只给版本/平台/宿主），磁盘布局是内部实现 | **不做假数字**；该区块只给"重置本工作区缓存（它自己的命令）+ 日志 + 诊断包"，并向上游提 change request（附录 D.5）。若评审坚持要有数字，需要先拿到上游接口 |
| **`readState` 的轮询会放大风险** | 高频调用可能影响 mcppls 主线程 | 默认 `stateRefreshSeconds = 0`（不轮询），只在 `onDidChange`、命令完成、用户手动刷新时读 |

---

## 7. 自我 review（v4）

### 7.1 这一版改对了什么

1. **v2 的 `build.mcpp` 结论基于实测**，v3 把它固化成"只做模式 A"，v4 把模式 B 留在附录 D 备查。
2. **把配置提升为主线**：设置从"功能的一部分"变成"功能的入口"（registry + 面板 + 四重门禁）。
3. **两级清理与全局缓存分离**：语义上正确（项目级 vs 机器级），避免 `--bmi-cache` 误点导致全机重建。
4. **i18n 从"改字符串"变成"改机制"**：单一来源 + 生成 + 门禁。
5. **v4 新增 §3.9**：把 mcppls 的状态与管理并入 mcpp，且**先说清"拿不到什么"**
   —— 缓存体量拿不到就不做数字，构建描述条数拿不到就不显示假条数。
   这一节的价值不在于多做了功能，而在于**把"能做的"和"做不到的"划在同一条界线上**，
   避免以后有人补一个看起来很美的假面板。

### 7.2 我仍然不放心的地方（按严重度）

| # | 问题 | 我的判断 |
|---|---|---|
| 1 | **设置总数 60 项依然偏多**，即便第一版只公开 29 项 | 已按评审意见分 `public`/`advanced`（§4.6）；建议下一版按使用反馈只增不减地调整，不新增"品味型"设置 |
| 2 | **§3.9 建在 `extension.exports` 上**，它明确是 mcppls 的**测试 API** | 这是"在不改上游的前提下能拿到 LSP 状态"的唯一通道。已做形状探测 + 白名单 + 两个 e2e 夹具 + 可关设置。**风险与收益都在这里**：如果评审认为不能用，§3.9 就只剩"转发命令"和版本信息 |
| 3 | **mcppls 缓存体量确实看不到** | 不假装。给它的三个替代入口（重置/日志/诊断包）+ 上游 change request。若你希望一定要有数字，需要先推动上游 |
| 4 | **`mcpp.ui.language` 的手动覆盖只能覆盖一半界面** | 保留但标注（已定） |
| 5 | **配置面板与原生设置页的长期关系** | 定位为"集中 + 解释 + 预设 + 边界提示"，不取代（已定） |
| 6 | **`mcpp.toml` schema 的枚举需人工补** | 唯一无法全自动处；写进 `tools/` 注释说明来源 |
| 7 | **缓存面板的预算模拟器可能过度设计** | 若 M8 时间紧，**第一个砍它** |
| 8 | **`mcpp clean --dry-run` 只有文本** | 可接受；将来 mcpp 给机读就换 |
| 9 | **§3.9 会让视图容器从 2 个视图变成 3 个** | Activity Bar 的侵入感增加；但 `mcpp.views.languageServer.show` 可关，且视图在 mcppls 不存在时不显示 |
| 10 | **`mcpp search` 解析人类输出仍是唯一的口子** | 已列为待替换项 |
| 11 | **模式 A 的 `mcpp::` 智能依赖 mcpp 源码结构**（`directives.cppm` 的表位置） | 生成脚本读不到就**失败而不是产出空表**；快照带 `sourceVersion`；漂移 job 在 CI 里跑 |

### 7.3 如果时间不够，砍的顺序

1. `mcpp.toml.indexCompletion`（依赖版本补全）—— 唯一需要联网、唯一解析人类输出；
2. 缓存面板的预算模拟器 —— 保留"选预算 + 执行 + 看结果"；
3. `mcpp.ui.language` 的手动覆盖 —— 只保留跟随 VS Code；
4. `mcpp.pack` / `publish --dry-run` 入口 —— 与 IDE 体验关系最弱；
5. `mcpp.ui.notifications.success` / `mcpp.ui.numberFormat` 这类"品味型"设置 —— 固定为默认值即可。

**不砍的**：两级清理、缓存统计与可视化、`build.mcpp` 智能、`mcpp.toml` 诊断、配置模块与面板、
mcppls 降级能力与状态视图、i18n 机制本身。

**v4 新增第 0 顺位（最先砍）**：`mcpp.languageService.readState` 走 `exports` 的那条路
—— 如果评审认为"依赖测试 API"不可接受，§3.9 退化成"只有转发命令 + 版本信息"，
其余设计不受影响。

---

## 8. 评审已决的问题与遗留

**v3 的 5 个问题已全部拍板**（见 §0 第 16–20 条）：① 第一版公开 31 项、其余 advanced；
② 保留 `mcpp.ui.language` 并标注；③ 保留依赖版本补全；④ 暴露 `cache clean --all` 但走两步确认；
⑤ 配置面板定位为"集中/解释/预设/边界提示"，不取代原生设置页。

**v4 遗留（只有一条需要你决定）**：

1. **§3.9 的状态读取是否接受 `extension.exports`**（mcppls 的测试 API）？
   - **接受**（推荐）：能显示 `state`/`project`/`profile`/`engine(s)`/`progress`/`issues`
     （含 S3 自带的修复命令），代价是上游重构后这一块可能消失（已用形状探测 + 白名单 +
     两个 e2e 夹具 + 可关设置兜住）。
   - **不接受**：§3.9 只保留"转发命令 + 版本/激活/启用信息"，视图仍然有用但内容少很多；
     我会同时把"上游提供一个正式的状态/缓存查询命令"提为**更高优先级的 change request**。

**v4 记录在案的上游诉求**（本方案不改上游，只记录）：

| # | 对象 | 诉求 | 本插件因此获得 |
|---|---|---|---|
| U.1 | mcpp | 在 `mcpp emit build-database` 里描述构建程序自身（含 `-fmodule-file=mcpp=…` 与 std 单元），该命令不写工程目录 | `build.mcpp` 的 std + mcpp 完整语义（附录 D.1 的模式 B 变成默认，无需改本插件） |
| U.2 | mcppls | 把 `mcppls.reloadBuildDescription` 注册为 VS Code 命令 | build 后从"整机重启"降级为"轻量重载" |
| U.3 | mcppls | 把 `mcppls.mcpp` 暴露为可配置设置 | `mcpp.path` 与语言服务看到同一个 mcpp |
| U.4 | mcppls | 书面承诺 4 个命令 ID 的稳定性 | 把下游测试护栏升级为上游承诺 |
| U.5 | mcppls | 注册一个返回**缓存目录与体量**（或直接清理）的公开命令 | §3.9.3 里目前做不到的"缓存占比可视化" |
| U.6 | mcpp | `mcpp search` 提供机读格式 | 去掉方案里唯一的"解析人类输出" |

---

## 附录 A：本方案用到的 mcpp 命令

| 命令 | 用途 | 写盘 | 机读 |
|---|---|---|---|
| `mcpp --protocol-version` | 协议/能力探测 | 否 | ✅ |
| `mcpp self env --format json` | 版本、MCPP_HOME、默认工具链 | 否 | ✅ |
| `mcpp toolchain list --format json` | 工具链/target 矩阵 | 否 | ✅ |
| `mcpp cache list --format json` | 缓存条目与体积 | 否 | ✅ |
| `mcpp cache dir` / `mcpp cache info <pkg>` | 缓存根 / 条目详情 | 否 | ❌ |
| `mcpp cache verify` | 缓存校验 | 否 | ❌ |
| `mcpp cache prune --older-than <N>d` | 按时间收敛 | 是 | — |
| `mcpp cache gc --max-size <N>GiB` | 按预算收敛（LRU） | 是 | — |
| `mcpp cache clean --deps\|--std\|--all\|--legacy` | 分类清空 | 是 | — |
| `mcpp clean --stale --dry-run` | 过期产物**预演** | 否 | ❌ |
| `mcpp clean` | L1 清理 | 是 | — |
| `mcpp clean --stale --older-than <N>d` | L2 清理 | 是 | — |
| `mcpp clean --bmi-cache` | L1 + 全局缓存（单独、更重确认） | 是 | — |
| `mcpp search <kw> [--all-versions]` | 依赖版本补全（默认关） | 否 | ❌ |
| `mcpp update` / `mcpp self doctor` | 依赖更新 / 环境诊断 | 是 / 否 | — |
| `mcpp build/run/test`、`mcpp toolchain install/default` | 现有任务 | 是 | — |

## 附录 B：实测证据

| 结论 | 证据 |
|---|---|
| mcpp 不把 `build.mcpp` 放进编译数据库 | `examples/11-features/greeter` 上 `mcpp emit build-database --spec compile-commands --format json` → 6 条（counters.cppm / greeter.cppm / main.cpp / test_greet.cpp / std.cppm / std.compat.cppm）；`build.mcpp` 只在 `data.watch` |
| mcppls 不认识 `build.mcpp` | 全仓 grep 只命中 `target/.build-mcpp/deps/...`（依赖的构建程序产物） |
| 交给 clangd 后 std 与 mcpp 都报错 | `mcppls check build.mcpp` → `module 'std' not found` + `module 'mcpp' not found` + `Failed to build module mcpp`，clangd exit 3 |
| 数据库内的文件零诊断 | `mcppls check src/main.cpp` → clangd exit 0 |
| 构建脚本 API 可机读 | `modules/buildmcpp/src/directives.cppm:297`（31 行表）、`:1132-1134`（5 role）、`program_protocol.cppm:121,147`、`provisions.cppm:80` |
| 缓存数据可机读 | `mcpp cache list --format json` → kind `mcpp.cache`，657 条 / 7.20 GiB / pkg 576 · std 81 / 2 incomplete |
| `--stale` 语义与默认 | `mcpp clean --help`：`--older-than … (default 1d; 0 keeps none; implies --stale)`；`--dry-run` 隐含 `--stale` 且不删 |
| `search` / `info` / `verify` 无机器格式 | 各自 `--help` 只有人类选项；`search` 只有 `--all-versions` |

## 附录 C：配置项 ↔ 功能 对照（抽查）

| 功能 | 可配置项 |
|---|---|
| 构建 | `mcpp.task.buildArgs`、`revealTerminal`、`focusTerminal`、`clearTerminal`、`problemMatcher` |
| 清理 | `mcpp.task.cleanArgs`、`confirmClean`、`mcpp.cache.staleDays`、`pruneAgeDays`、`gc.defaultBudgetGiB`、`gc.confirmAboveGiB` |
| 语言服务 | `mcpp.languageService.refreshAfterBuild`、`menuItems`、`notifyOnDegraded` |
| mcppls 状态与管理（§3.9） | `mcpp.views.languageServer.show`、`mcpp.languageService.readState`、`stateRefreshSeconds`、`confirmResetCache`、`mcpp.ui.statusBar.showLanguageServer` |
| `mcpp.toml` | `mcpp.toml.*`（11 项） |
| `build.mcpp` | `mcpp.buildScript.*`（5 项） |
| 视图 | `mcpp.views.*`（5 项） |
| 通知与视觉 | `mcpp.ui.*`（7 项） |
| 排障 | `mcpp.log.level`、`mcpp.diagnostics.selfCheckOnStartup`、`mcpp.runtime.*` |

## 附录 D：本版**不实现**、仅文档备注的项

1. **`build.mcpp` 模式 B（交给 C++ 语言服务）**：实测会让 `import std` 与 `import mcpp` 都报错
   （附录 B），因此不发布开关。文档备注保留这条路径，等上游把构建程序写进
   `mcpp emit build-database`（诉求 **U.1**）之后再启用 —— 那条改动只在 mcpp 一侧，
   本插件无需改动即可受益。
2. **mcppls 缓存目录的体积与占比**：拿不到（§3.9.3），等诉求 **U.5**。
3. **未受信任工作区下的 mcpp 只读命令白名单**：当前是一律禁用；将来若 mcpp 的
   `--protocol-version` 能证明某命令零副作用，再考虑放开。
4. **`mcpp.toml` 格式化**：不做（会改用户文件，且不是本扩展的职责）。
5. **遥测**：不做。本扩展不收集任何遥测数据。
