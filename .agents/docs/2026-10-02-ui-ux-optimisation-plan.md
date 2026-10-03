# UI/UX 优化方案 v2（待 review）

v1 的四个问题已收到答复，本版按答复重做设计，并补上你新提的三件事：**图标用 mcpp 官方的**、
**梳理侧边栏**、**侧边栏整体可开关（关掉时左边不出现 mcpp）**。

---

## 0. 你的答复与我的理解

| 问题 | 你的答复 | 确认后的设计 |
|---|---|---|
| Q1 缓存视图形态 | **webview view** | `mcpp.cache` 从原生树改为**侧边栏 WebviewView**，统计与图形都在侧边栏内 |
| Q2 `mcpp: Cache Statistics` | **删除** | 删掉该命令与 `createWebviewPanel` 那条路径 |
| Q3 工程视图的动作 | "什么意思 按理是要能点击有动作的" | **我原来说得不清楚，见 §2。结论：动作保留、可点，只是与数据分区** |
| Q4 图标 | "不能用 mcpp 的 icon 吗，mcppls 里也有 logo" | **可以，而且必须**——现在两个扩展的 logo **不是同一张图**，见 §4 |

---

## 1. 新查明的事实（都有出处）

| # | 事实 | 出处 |
|---|---|---|
| F1 | mcpp 官方 logo 在 mcppls 仓库里，而且**就是 mcppls 扩展的图标**（两文件字节完全相同，md5 `f9457903…`） | `mcpp-language-server/docs/imgs/mcpp-logo.png` 与 `editors/vscode/icon.png` |
| F2 | **mcpp-vscode 用的是另一张图**（200×200，md5 `2d723543…`），与 mcppls 不一致 | `mcpp-vscode/images/logo.png` |
| F3 | mcppls 的 `mcpp-logo.svg` **不是真矢量**：excalidraw 导出，内部 `href` 是 base64 PNG。**上游没有可用的单色矢量图标** | `docs/imgs/mcpp-logo.svg` 开头即 `<image href="data:image/png;base64,…">` |
| F4 | mcppls **没有贡献 Activity Bar 容器**（`viewsContainers: null`），所以左侧那个 mcpp 图标只可能来自 mcpp-vscode，不存在冲突 | mcppls `package.json` |
| F5 | **"所有视图都隐藏 → 容器从 Activity Bar 消失"是可行的**，但 `when` 必须写成**否定形式**（`!mcpp.sidebarHidden`），否则默认就被隐藏，`activate()` 不会被调用，也就永远没机会把开关设回来 | [VS Code issue #49145](https://github.com/microsoft/vscode/issues/49145)（closed/verified）+ [#48704](https://github.com/microsoft/vscode/issues/48704)（`viewsContainers` 本身不支持 `when`） |
| F6 | 现有开关只有三个**分视图**开关，**缺总开关** | `data/config-registry.json`: `mcpp.views.{project,cache,languageServer}.show` |

**F5 是本方案的关键**，因为它决定了"关掉侧边栏"到底能不能做到——能，但写法有讲究，不能想当然。

---

## 2. 回答 Q3：动作不会消失，只是不再和数字混在一起

我上一版问的是"是否完全不出现动作"，措辞不好，导致看起来像要**拿掉可点击性**。不是这个意思。

真实问题不是"有动作"，而是**动作和数据是同一层的同级行**，视觉上没有分界：

```
现在（工程视图）                      改后
├ 包名        greeter                 ├ 包名        greeter
├ 标准        c++23                   ├ 标准        c++23
├ Build      ← 动作                   ├ 目标        x86_64…
├ Run        ← 动作                   ├ 工具链      llvm@22.1.8
├ Test       ← 动作                   └─ 操作                    ← 可折叠分组
├ Test       ← 动作                      ├ 构建   (tools)
└ Clean project artifacts ← 动作         ├ 运行   (play)
                                         ├ 测试   (beaker)
                                         └ 清理产物 (trash)
```

**修订后的总原则（比 v1 更简单）**：

> **数据区只读；操作区可点；两区之间有明确分界，且操作区默认折叠收起。**

- 操作**依然是树/面板里可点的行**，点一下即执行——满足你说的"要能点击有动作"。
- 视图标题栏只放**视图级**动作（刷新、溢出菜单），不再重复放业务动作。
- 好处：打开视图先看到"是什么状态"，要看动作展开一次即可；不需要在两类语义之间反复切换注意力。

---

## 3. 侧边栏整体梳理

### 3.1 结构（容器 `mcpp`，三个视图，顺序固定）

```
mcpp
├─ 工程            mcpp.project         树    "这是什么工程"
├─ 缓存            mcpp.cache           WebviewView  "占了多少、谁占的"
└─ C++ Modules     mcpp.languageServer  树    "语言服务什么状态、哪里不对"
```

**为什么还是三个而不是合并成两个**：三者的**回答对象不同**，而且 C++ Modules 的内容由另一个扩展提供（`sunrisepeak.mcpp-language-server`）。合并会让"谁负责什么"重新变模糊——这正是上一轮花力气划清的边界。三个视图的取舍权交给用户（§3.3 的开关）。

### 3.2 每个视图的内容分区

**工程（树）**
```
身份：包名 / 标准 / 类型
目标：triple / profile / 编译器
工具链：当前有效 spec（只读，改它用命令）
操作（折叠）：构建 / 运行 / 测试 / 清理 target
```

**缓存（WebviewView，三区 + 一个操作条）**
```
┌ 缓存 ────────────────────────── [↻] [⋯] ┐
│ 7.20 GiB · 657 项 · 最早 12 天前          │  区1 数字摘要（只读）
│ ████████████░░░░░░░░  项目 12%            │  区2 可视化：构成 + 时间分布
│ ██████████░░░░░░░░░░  std  31%            │      按 200–320px 窄宽度设计
│ ▸ 最大占用（前 5） ▸ 按类型 ▸ 按时间       │  区3 明细：只做「查看」钻取
│ ──────────────────────────────────────── │  分隔（视觉 + 语义）
│ 操作  清理过期 · 清理工程 · 收敛 · 校验    │  操作条（与数据区分离）
└──────────────────────────────────────────┘
```
- 现在树里的 11 个动作节点全部收敛到这一条。
- **`mcpp.showCachePanel` 删除**（Q2），`createWebviewPanel` 路径一并删掉，`cachePanelHtml.ts` 的渲染逻辑改为喂给 WebviewView。

**C++ Modules（树）**
```
状态：就绪 / 降级 / 缺失（图标 + 一句话）
      C++ Modules 0.0.9（外部扩展，只读）
问题：有问题才出现（引擎未就绪 / 某能力不可用 / 依赖缺失）
操作（折叠）：重启 / 重选上下文 / 模块图 / 日志 / 上报 / 诊断包 / 重置缓存 / 身份与冲突
```
11 个动作节点从平铺变为一个折叠分组，状态与问题在它上面。

### 3.3 开关：一个总闸 + 三个分闸

| 设置 | 默认 | 作用 |
|---|---|---|
| `mcpp.views.enabled`（**新增**） | `true` | 总闸。关掉 → **Activity Bar 上的 mcpp 图标整体消失** |
| `mcpp.views.project.show` | `true` | 单个视图开关（已有） |
| `mcpp.views.cache.show` | `true` | 同上 |
| `mcpp.views.languageServer.show` | `true` | 同上 |

**实现（关键，照 F5 的写法）**：

```jsonc
// package.json —— when 必须是否定形式，默认才可见
"views": { "mcpp": [
  { "id": "mcpp.project", "when": "!mcpp.sidebarHidden && mcpp.views.project" },
  { "id": "mcpp.cache",   "when": "!mcpp.sidebarHidden && mcpp.views.cache" },
  { "id": "mcpp.languageServer", "when": "!mcpp.sidebarHidden && mcpp.views.languageServer" }
]}
```
```ts
// extension.ts：设置变化时同步
void vscode.commands.executeCommand("setContext", "mcpp.sidebarHidden", !read<boolean>("mcpp.views.enabled"));
```

**必须验证的一点**（写进 e2e）：`activate()` 的激活事件里**不能只依赖视图**，否则一旦隐藏就再也激活不了。当前激活事件是 `workspaceContains:mcpp.toml` / `onLanguage:*` / 派生的 `onCommand:*`，不依赖视图，所以安全——但这条要作为约束记下来并测试。

---

## 4. 图标：统一到 mcpp 官方标识（回答 Q4）

**现状问题**：F1/F2 —— mcppls 用官方的 mcpp logo，mcpp-vscode 用另一张图。同一家族两个扩展并排出现在扩展列表里，看起来像两个不相干的项目。

**改法分两处，注意它们的要求不同**：

| 用途 | 现在 | 改成 | 理由 |
|---|---|---|---|
| 扩展图标（Marketplace / 扩展列表） | `images/logo.png`（200×200，与官方不同） | **官方 `mcpp-logo.png`**（396×396，与 mcppls 同一张） | 家族一致；这是你在扩展列表里看到的图 |
| Activity Bar 容器图标 | 同一张 200×200 彩色 PNG | **单色 24×24 SVG** | Activity Bar 惯例是单色、跟随主题；彩色 PNG 缩到 24px 会糊成暗块，这正是你觉得"没有图标"的原因 |

**一个必须先说清楚的限制**：F3 —— **上游没有可用的单色矢量 logo**（那个 `.svg` 里包的是 PNG）。所以 Activity Bar 的单色图标**必须新画**，方式二选一：

- **方案 A（推荐）**：我按官方 logo 的形态**重绘一个极简单色 SVG**（几何化的 mcpp 标记，`fill="currentColor"`），先出 2–3 个候选给你挑。
- **方案 B**：直接用官方彩色 PNG 作为容器图标（能显示、不改主题、24px 下偏糊）。

> 我不建议"自动描摹"官方 PNG——那会得到一个杂乱的路径，比手绘的几何标记更糟。

另外，`views` 条目本身也支持 `icon`（视图标题旁的小图标），目前我们一个都没设。**建议不加**：三个视图名称已经足够清楚，再加图标只会让标题栏更挤。

---

## 5. 任务拆分与依赖

```
T-UI-1  图标统一                                        依赖：你选 A / B
        ├─ 扩展图标换成官方 mcpp-logo.png（与 mcppls 对齐）
        └─ 容器图标：单色 SVG（方案 A 需你从候选中挑一个）

T-UI-2  快捷菜单：ThemeIcon + 分组分隔 + 描述改成"动作后果"     无依赖，可立刻做，风险最低
T-UI-3  侧边栏梳理：顺序、操作区折叠、"操作"分组               无依赖
T-UI-4  C++ Modules 重组：状态 / 问题 / 操作（折叠）            依赖 T-UI-3 的分组约定
T-UI-5  缓存：树 → 侧边栏 WebviewView                           依赖 Q1=webview view（已确认）
        └─ 删除 mcpp.showCachePanel 与 createWebviewPanel 路径
T-UI-6  总闸 mcpp.views.enabled + setContext(!mcpp.sidebarHidden) 依赖 T-UI-3
T-UI-7  一致性守卫（关键）                                      依赖 T-UI-3~6
        ├─ 断言：视图正文的数据区里不存在命令节点
        ├─ 断言：每个动作的"主入口"在登记表中唯一
        └─ e2e：三个视图全部 when=false 后容器消失；且 activate 仍能被 workspaceContains 触发
T-UI-8  文档与截图                                              依赖全部
```

- **T-UI-2 可以现在就做**，最直接回应你的图标反馈。
- **T-UI-3/4 是纯重排**，不动数据层，可以并行。
- **T-UI-5 最大**：`createWebviewPanel` → `registerWebviewViewProvider`，注意 WebviewView **不支持 `retainContextWhenHidden`**，切换视图会销毁重建，所以渲染必须是幂等的（现有 `renderPanelHtml(model)` 天然满足）。
- **T-UI-7 是本方案能不能站住的关键**：把"数据/操作分区"和"动作主入口唯一"变成**测试断言**，否则下一轮很容易又混回去。这与上一轮"64 个设置必须被读取"用的是同一个手法。
- **T-UI-6 有一个必须测的边界**：隐藏后 `activate()` 还能不能被触发（F5 的陷阱）。

---

## 6. 需要你定的 3 件事

1. **Activity Bar 图标**：走方案 A（我画 2–3 个单色候选给你挑）还是方案 B（直接用彩色 PNG）？
2. **扩展图标是否统一为官方 mcpp logo**（与 mcppls 相同）？我建议是——这正是你问的"不能用 mcpp 的 icon 吗"。
3. **总闸设置名**：`mcpp.views.enabled` 还是 `mcpp.sidebar.enabled`？（前者与既有的 `mcpp.views.*` 命名一致，我倾向它。）

**T-UI-2 我建议不等，直接先做**；T-UI-3/4 只要"数据区只读、操作区折叠"这条原则你认可，也可以并行开工。

---

## 7. 可交互原型（已生成，本地打开）

**`.agents/prototypes/ui-prototype.html`** —— 单文件、自包含（内嵌 VS Code 真实的 codicon 字体与官方 logo），
双击或用浏览器打开即可。**控制台里可以切：改前 / 改后、三个视图、三种主题、三个图标候选、侧边栏开关**；
拖侧边栏右缘能改宽度，用来验证窄宽度下的表现。

原型里的配色不是我自己编的，取自本机 VS Code 1.125.1 的默认主题文件
（`theme-defaults/themes/2026-dark.json`、`2026-light.json`、`hc_black.json`，含 include 链）。

### 图标候选 A 是"真货"

`mcpp-mark-traced.svg` 是**从官方 `mcpp-logo.png` 自动描摹出来的单色 SVG**（44×44 网格、148 条
水平游程、4.9 KB），不是手绘近似。做法：解码 PNG → 按亮度分离前景 → 覆盖率采样 → 输出
`fill="currentColor"` 的路径。所以它能跟随主题变色，可以直接当 Activity Bar 图标用。
代价是边缘是阶梯状（44 格量化），要更干净需要人工重绘成曲线。

另外两个候选用于对比方向：B 是手绘的"模块方块"，C 就是现在那张 200×200 彩色 PNG。

### 想请你在原型里重点看

1. **缓存**：改前是树（11 个可点动作和统计混在一起）→ 改后是侧边栏内的三区布局（摘要 / 图形 / 明细 + 独立操作条）。
2. **C++ Modules**：改前 11 个动作平铺 → 改后只剩状态与问题，动作收进折叠的「操作」。
3. **工程**：改前 Build/Run/Test/Clean 与"标准/目标/工具链"同级 → 改后数据在上、操作在下且折叠。
4. **快捷菜单**：改前无图标、描述是重复的分组名 → 改后有图标、有分组分隔、描述改成"动作后果"。
5. **Activity Bar 图标**：A / B / C 三个候选直接切换对比。
6. **侧边栏总闸**：切到"关"，确认左侧 mcpp 图标消失、其余图标不动。

---

## 8. v3：按你的第二轮反馈改（原型已同步重建）

### 8.1 缓存：分开项目 / 全局，全局默认折叠

- **项目缓存**常显：26px 主数字 + `MiB` 单位 + 右侧一行副信息（文件数 / 构建目录），下面一条 6px 细条，
  再一行"其中过期产物约 4.1 MiB"，最后两个按钮。
- **全局缓存**用原生 `<details>` **默认折叠**，摘要压在一行里（`7.20 GiB · 657 项`）；展开后才是构成条、
  时间条、"最大占用"（再嵌一层折叠）和三个次级按钮。
- "更优雅"的具体手段（不是形容词）：整块只有**一条主条**（6px，不是三条 14px）；图例**压成一行**用 `·` 分隔
  而不是每项一行；数字用 `tabular-nums` 对齐；字号分层（26 / 12 / 11）；去掉多余色块边框，靠留白分节。

### 8.2 C++ Modules：不显示 clangd

正文只剩 **状态 → 语言服务 → 问题 → 操作**。`clangd` / 引擎 / 语义 profile 全部移除，
只留 `语言服务 mcppls 0.0.9`。操作从 11 行压成 5 行，其余收进「其它 7 项…」。
**已用渲染产物断言**：改后 HTML 里 `clangd` 出现 **0** 次。

### 8.3 图标：用 mcppls 的官方资源（实测配色，有个坑）

实测官方 `mcpp-logo.png` 的像素构成：**纯黑 75.1%** · 橙 `#f08c00` 6.8% · 蓝 `#1971c2` 6.1% · 透明 10.4%。

**坑**：深色主题的 Activity Bar 背景是 `#191A1B`，**75% 的黑墨迹在它上面几乎不可见**——直接用原图，
看起来就是"没有图标"，正是你最初的抱怨。浅色主题（`#F8F8F8`）则正常。

原型的三个候选（都不再手绘，上一版那张描摹已删）：

| 候选 | 做法 | 代价 |
|---|---|---|
| A | 官方 PNG 原样 | 深色主题下黑墨迹消失 |
| B | 官方 PNG 放在浅色圆角底上 | 保留全部色彩；Activity Bar 里多一个浅色小方块 |
| C | 官方图形里的**黑色部分机械换成 `currentColor`**（橙蓝丢弃） | 单色、随主题变色；不是手绘，但仍是一次派生 |

### 8.4 库市场：可行性（已在 mcpp 源码里核对）

| 能力 | 现状 |
|---|---|
| 写入 `mcpp.toml` | ✅ `mcpp add <spec> [--dev]`，官方命令就是"Add a dependency to mcpp.toml" |
| 搜索包 | ⚠️ `mcpp search <keyword> [--all-versions]` — **没有 `--format json`** |
| 包详情 | ⚠️ `mcpp info <pkg>` 只对**已缓存**的包，且无 JSON |
| 包列表 | ❌ `mcpp list` 的三个都是"工具链 / 缓存条目 / 已配置 registry" |
| 索引数据 | `mcpp-index` 仓库：238 个 Lua 描述符，含 name/namespace/description/licenses/repo/deps/多平台版本 |
| 对比 | `build` `pack` `why` `build-database` `parse` `cache list` `env` 等约 10 个子命令**都有 `--format json`** |

三条路：**(a)** 请上游加 `mcpp search --format json`（与既有 10 个命令一致，改动小）← 推荐；
**(b)** 解析人类输出（脆弱，违反本项目"只有一处解析人类输出"的原则）；
**(c)** 直接读 index 仓库的 Lua（重复 mcpp 的职责，还要自己找索引路径）。

推荐 (a) + 优雅降级：没有机器输出时，界面显示"需要更新的 mcpp"而不是坏掉——能力探测机制已经在了。

形态上我倾向**轻的那条**：`mcpp: 添加依赖…` 一个 quick pick（关键词 → 列表 → `mcpp add`），
放在工程段「常用命令」里。理由是写 `mcpp.toml` 本来就是"工程"的事，也不给侧边栏再加一段噪音。

---

## 9. v4：三段结构 + 库生态（原型已同步重建）

### 9.1 图标：采纳官方 PNG 原样

你确认 2026 Dark 下黑底与 Activity Bar 有可见差别。实测支持这个判断：logo 黑是 `#000000`，
深色主题 Activity Bar 是 `#191A1B`——不是纯黑对纯黑，所以能看出一块更深的底加亮色图形。
**采纳候选 A**：扩展图标与 Activity Bar 容器图标都用官方 `mcpp-logo.png`，
两个扩展从此是同一张图（当前 mcpp-vscode 用的是另一张，md5 不同）。B/C 仅留作备查。

### 9.2 侧边栏改为三段：工程 / mcpp 库生态 / 缓存

`mcpp.languageServer` 视图取消，内容折进**工程 → 基本信息**，默认折叠。

**前提（否则这个折叠是有害的）**：折叠状态下必须能看出好坏。所以折叠那一行自带状态图标
（健康绿 / 降级黄），降级时右侧显示 `mcppls 0.0.9 · 1 个问题`。**不展开也能发现异常**是
这一条能被接受的条件；否则问题会被藏起来，比不放更糟。

**一个取舍**：C++ Modules 的内容由**另一个扩展**提供。折进工程会让"谁负责什么"这条边界重新
变模糊。缓解：展开后的块里固定一行「提供方 sunrisepeak.mcpp-language-server」。

### 9.3 库生态：用 mcpp-index + `mcpp xpkg`，不动上游（已实测）

| 环节 | 实测结果 |
|---|---|
| 描述符解析 | **`mcpp xpkg parse <file.lua> --json` 存在且好用**：`{"namespace":"compat","name":"argparse","versions":{"linux":["3.2"],"macosx":["3.2"],"windows":["3.2"]},"standard":"c++23","sources":[…],"include_dirs":[…],"targets":["argparse"],"unknown_keys":[]}` |
| 索引位置 | `mcpp index status` 给出表格，含每个 registry 的 `path`；**且 `~/.mcpp/registry/data/*/pkgs` 可直接 glob**，无需解析输出 |
| 目录规模 | `mcpplibs`（官方 C++ 库索引）**239 个包**；另有 `xim-pkgindex`、`xim-pkgindex-local` |
| 目录字段 | 每个 `.lua` 含 `namespace` / `name` / `description` / `licenses` / `repo` |
| 添加依赖 | `mcpp add <ns.name>@<ver> [--dev]`，官方命令直接写 `mcpp.toml` |

**关键限制**：`mcpp xpkg parse --json` **不含** `description` / `licenses` / `repo`
——那些属于 `package` 表的目录字段，不在 resolver 语法里。所以：

- **列表**（239 条，必须便宜）：容错读取每个 `.lua` 里的几个**单行字符串字段**。
- **详情与版本**：按需调 `mcpp xpkg parse --json`（版本按平台分组，权威）。
- **绝不为 239 个包各起一个进程**——那会卡死；批量阶段只读文本，进程只在点开某一行时起。
- 读不出来的条目用文件名兜底，详情仍可用。

**索引路径**：默认 glob `<home>/.mcpp/registry/data/*/pkgs`，配 `mcpp.library.indexPath` 覆盖。
`XLINGS_HOME` 不在环境变量里，且 `mcpp index status --format json` 是 unknown option，
所以走 glob 而不是解析 `mcpp index status` 的表格——避免出现第二处"解析人类输出"。

### 9.4 还没定的（下一轮要你拍板）

1. **"已添加"怎么判定**：mcpp 没有列依赖的子命令（`mcpp list` 三个分别是工具链 / 缓存条目 /
   已配置 registry）。所以只能读 `mcpp.toml` 的 `[dependencies]`——我们本来就在解析它。
2. **要不要区分"已声明"与"已缓存"**？两者不同：声明在 `mcpp.toml`，缓存在全局缓存目录。
3. **搜索范围**：只搜本地索引（离线、快、可预期），还是也允许 `mcpp search`（覆盖其它 registry、
   可能联网）？
4. **版本怎么选**：默认最新 / 让用户挑 / 跟随工具链兼容性？

---

## 10. v5 定稿：按你的四条决定收口

### 10.1 图标
采纳官方 `mcpp-logo.png` 原样，扩展图标与容器图标同一张（B/C 撤销）。

### 10.2 库生态

**搜索分两档，开关默认关闭联网：**

| 档 | 数据源 | 默认 | 成本 |
|---|---|---|---|
| 本地索引搜索 | `~/.mcpp/registry/data/*/pkgs` 的 239 个描述符 | **开** | 离线、一次扫完、可预期 |
| 全 registry 搜索 | `mcpp search <keyword>` | **关**（`mcpp.library.searchRegistries`） | 可能联网；且只有人类输出 |

> 联网那一档只有人类输出，所以打开时按"尽力而为"处理：解析失败就退回本地结果并提示，
> **不抛错、不静默失败**。这条要说在设置描述里。

**版本默认最新——但 mcpp 要求显式版本，所以"最新"必须由我们算出来：**

实测 `mcpp add compat.argparse`（不带版本）会被拒：
```
error: package version required: `mcpp add compat.argparse@<version>` (M2 supports exact-version only)
```
所以流程是：
1. `mcpp xpkg parse <descriptor.lua> --json` → `versions: {linux:[…], macosx:[…], windows:[…]}`
2. 取**当前平台**那组，按版本序取最大 → `3.2`
3. `mcpp add compat.argparse@3.2`（dev 依赖加 `--dev`）

**语义澄清**：`mcpp add <ns.name>` 与 `mcpp add <ns.name>@<ver>` 是两件事，前者会被拒。
界面上显示"最新 3.2"，实际执行的是带版本的命令——不要让人以为我们省略了版本。

### 10.3 依赖树：**只能做两级，且必须说清楚**

我实测了三条数据源，结论如下：

| 来源 | 能给什么 | 机器可读？ |
|---|---|---|
| `mcpp.toml` | **声明的**依赖（`[dependencies]` / `[dev-dependencies]`，含 version/path/git/features） | ✅ 文本，我们已在解析 |
| `mcpp.lock` | **解析到的**包集合：`[package."ns.name"]` + `namespace`/`version`/`source`/`hash`，**扁平、无父子边** | ✅ 结构化 TOML |
| `mcpp why deps` | 传递依赖的解释 | ❌ **实测被拒**：`error: --format json is defined for 'mcpp why toolchain'; 'deps' has no machine-readable shape yet` |

所以**今天做不出真正的传递依赖树**。方案改为诚实的**两级展示**：

```
依赖 (4)
├ mcpplibs.cmdline        最新 0.3.1 · 已解析 0.0.1      ← 声明 → lock 解析值
├ compat.argparse         最新 3.2   · 已解析 —           ← 声明了但还没 lock
├ compat.gtest    dev     最新 1.15.2 · 已解析 — 
└ counters         path   ../counters
```

- 第一级 = `mcpp.toml` 的声明（含 `dev` / `path` / `git` 标记）。
- 第二级 = `mcpp.lock` 里按名字匹配到的解析版本；没有就是"—"（未解析或未构建过）。
- **不画连线**，因为 lock 里没有父子关系，画了就是编的。
- 真正的传递树挂到上游请求：**U.7 `mcpp why deps --format json`**（`why toolchain` 已经有了，
  补齐 `deps` 是同一类改动）。等它落地再把两级升级成树。

### 10.4 顺带修正一处此前的说法

v3 里我写"`mcpp why <pkg>` 有 `--format json`，可以解释谁把它拉进来的"——**这是错的**。
实测只有 `why toolchain` 有 JSON，`why deps/sources/tool` 都没有。已在此更正。

---

## 11. 自我 review（对方案本身，不是对代码）

### 11.1 我实测过、有证据的（可以当事实用）

| 结论 | 证据 |
|---|---|
| `mcpp xpkg parse <file> --json` 可用 | 实跑 `compat.argparse.lua`，返回含 `versions` 的 JSON |
| 官方 C++ 库索引 239 个包 | `find ~/.mcpp/registry/data/mcpplibs/pkgs -name '*.lua' \| wc -l` = 239 |
| 索引路径可 glob，无需解析输出 | `~/.mcpp/registry/data/*/pkgs` 三个 registry 都在 |
| `mcpp index status --format json` 不存在 | 实跑 → `error: unknown option: --format` |
| `mcpp add` 必须带精确版本 | 实跑 → `error: package version required` |
| `mcpp why --format json` 只对 toolchain | 实跑 → `'deps' has no machine-readable shape yet` |
| `mcpp.lock` 是扁平的解析集合 | 读 mcpp 仓库真实 lock：`[package."ns.name"]` + version/source/hash，无父子边 |
| 官方 logo 75.1% 纯黑 | 解码像素统计 |
| `mcpp why --format json` 走标准信封 | 顶层键 `data/diagnostics/effects/kind/kindVersion/mcpp/schemaVersion` |

### 11.2 我没验证、属于推断的（**别当结论**）

1. **库视图的性能**：239 个文件读一遍到底多快，我没有实测。若首次渲染 > 300ms，
   需要加缓存或懒加载——这一点等实现时先量再定。
2. **描述符的字段容错**：我抽样读了 4 个 `.lua`，确认 `namespace/name/description` 是单行
   字符串。**没有验证全部 239 个是否都规范**——可能有换行、引号转义、或缺失。设计里已要求
   用文件名兜底，但没有实测兜底覆盖率。
3. **`mcpp add` 是否联网**：加索引包大概要拉索引/校验，但我没测它的耗时与失败表现。
   界面上"添加"必须给进度与失败路径，这一点我写进了方案但没验证。
4. **WebviewView 在 200px 窄宽度下的真实表现**：原型是 HTML 模拟，不是真实 VS Code 窗口。
5. **三个视图全关后容器是否真的消失**：依据是 VS Code issue #49145（closed/verified）和一篇
   第三方文章，**我没有在真实 VS Code 里验证过**。这是整个"侧边栏可关闭"的地基，落地时
   必须先写一个 e2e 把它钉死，再写别的。
6. **C++ Modules 折叠的观感**：折叠后能否"不展开就看出异常"，是我认为的关键，但只能靠你看原型判断。

### 11.3 方案自身的风险

| 风险 | 说明 | 对策 |
|---|---|---|
| 第二处"解析人类输出" | 联网搜索档要解析 `mcpp search` | 默认关闭 + 失败即退回本地；已登记 U.8 `mcpp search --format json` |
| 读 239 个 Lua 是否算"重造 mcpp 的职责" | 有争议 | 限度写死：只读 4 个单行目录字段；**任何权威值走 `mcpp xpkg parse`** |
| 索引路径硬编码 `~/.mcpp/registry` | 非默认安装会找不到 | `mcpp.library.indexPath` 可覆盖；找不到时给明确提示而不是空列表 |
| 三段结构让 C++ Modules 的归属变模糊 | 上一轮刚划清的边界 | 展开块固定一行「提供方」；折叠行显示 mcppls 版本 |
| 工程段因为加了「常用命令」反而变长 | 与"简洁"目标相悖 | 你已确认可接受；若要更短可把常用命令收成折叠 |

### 11.4 我在前几版里说错、已更正的

1. v1 把 Q3 问成"是否完全不出现动作"——**措辞导致误解**，你回"按理是要能点击有动作的"。
   实际问题是"动作与数据同级混排"，不是"要不要动作"。
2. v3 说 `mcpp why <pkg>` 有 JSON 可解释依赖来源——**错**，只有 `why toolchain` 有。
3. v3 提议"我画一个单色 SVG"——你没要，实际做法是从官方图机械派生（后来连这个也撤销了，
   直接用官方原图）。
4. v2 说容器图标"看起来像没有图标"是因为 PNG 糊——**部分对**：真实原因是当时那张与官方
   不是同一张图，且黑墨迹在深色主题下对比度低。

---

## 12. v6 定稿：详情页 / 示例代码 / 索引站的定位

### 12.1 包详情放在编辑器区（已定）

侧边栏 = 搜索 + 列表；编辑器 = 详情页。列表行必须自足（名称 / 一行描述 / 用法标签 / 版本 / 状态），
不强迫开详情页。

### 12.2 "要索引站干什么"——定位说清楚

**不是为了拿数据。** 数据全在本地（见 §13.2）。索引站只有三个作用：

1. **深链**：实测包页 URL 是 `https://mcpplibs.github.io/mcpp-index/packages/<ns>.<name>/`
   （站点根页面里就能看到 `packages/compat.argparse/`、`packages/mcpplibs.cmdline/`）。
   详情页上放一个**低调的**「在索引站打开」链接即可。
2. **词表来源**（真正的价值）：`SURFACES` + 徽标 + facet 的权威定义就在
   `.xpkgindex/plugins/mcpp.py` 里。用它，两处说同一套词。
3. **信息层级对齐**的参照：分组顺序、徽标位置、字段取舍。

结论：**索引站是一个链接和一个词表，不是数据源。** 没有它这个功能照样成立。

### 12.3 示例代码代替 README（已定）

README 不做（索引里没有，要联网去上游拉）。

改为**官方索引的示例代码**，数据源就在索引仓库里、**完全离线**：

| 事实 | 实测 |
|---|---|
| 位置 | `tests/examples/<project>/mcpp.toml` + `tests/examples/<project>/tests/*.cpp` |
| 规模 | **172 个示例工程** |
| 契约 | 插件 `_scan_examples` 的产物：包 → `{project, path, paths[], count}` |
| 价值 | 这些是 **CI 真实构建并运行过**的代码，不是为网站写的片段（插件注释原话） |
| 抽取 | 从 `tests/*.cpp` 里取 `import x.y;` / `#include <foo.h>` 行——即 `SURFACES` 判定所依赖的同一批行 |

### 12.4 openkal 标识保留（已定）

`openkal-ecosystem` / `openkal-compat` 作为 facet，`posix 环境` / `使用平台接口` 作为徽标。
注意插件里的原话：这两个是**实测结果**（`tests/openkal/compat.py` 记录在
`.xpkgindex/openkal-compat.json`），描述符里**没有**对应字段。所以我们要读那个 json，不能推导。

### 12.5 标签词表最终确定

| 层 | 取值 | 来源 |
|---|---|---|
| **用法标签（主）** | `import` / `#include` / `tool` / 上游 mcpp.toml | `SURFACES`，由 `xpkg parse` 字段推导 |
| 徽标 | `✓ 有示例` / `国内镜像` / `openkal-ecosystem` / `openkal-compat` / `posix 环境` / `使用平台接口` | 示例扫描 + 描述符 url 里的 `CN` + `.xpkgindex/openkal-compat.json` |
| 命名空间 | `mcpplibs` / `compat` / `llvm` / `khronos` / `freedesktop` … | 描述符 `namespace` |
| 状态 | 已添加 / 可添加 / **有更新** | `mcpp.toml` + `mcpp.lock` vs 索引最新 |

上一版的 A–I 形状**废弃**（那是"怎么构建"，给索引维护者看；`SURFACES` 是"怎么使用"，给读者看）。

---

## 13. 综合自我 review（v6，对整套方案）

### 13.1 需求 → 落点对照（有没有漏的）

| 你提的 | 落点 | 状态 |
|---|---|---|
| 缓存可视化更优雅 | §8.1 一条 6px 主条 + 单行图例 + tabular-nums + 字号分层 | ✅ |
| 项目缓存 / 全局缓存分开，全局默认折叠 | §8.1 `<details>` 默认折叠，摘要一行 | ✅ |
| 不显示 clangd，只显示 lsp mcppls | §8.2 正文只留 状态 → 语言服务 → 问题 → 操作 | ✅ |
| 用官方 PNG/SVG，不自己画 | §9.1 官方 `mcpp-logo.png` 同图 | ✅ |
| C++ Modules 折进工程·基本信息 | §9.2，**前提**：折叠行自带状态图标 | ✅ |
| 三段：工程 / mcpp 库生态 / 缓存 | §9.2 | ✅ |
| 工程段有基本信息 + 常用 mcpp 命令 | §9.2 两块分区 | ✅ |
| 库市场 | §10.2 + §12 | ✅ |
| 联网搜索开关，默认关 | §10.2 | ✅（v6 后只剩跨 registry 一个用途） |
| 默认最新版本 | §10.2 由 `xpkg parse` 算出再显式传入 | ✅ |
| 显示依赖树 | §10.3 **降级为两级、不画连线** | ⚠️ 受上游限制 |
| 标签参考 mcpp-index | §12.5 改用官方 `SURFACES` | ✅ |
| 包详情 | §12.1 编辑器区 | ✅ |
| README 换成官方索引的示例代码 | §12.3，172 个示例工程，离线 | ✅ |
| openkal 标识 | §12.4，读 `openkal-compat.json` | ✅ |
| 风格对齐官方网页 | 词表/层级/文案对齐；**配色只跟 VS Code 主题** | ⚠️ 有意不对齐配色 |

### 13.2 数据源清单（每个字段从哪来、要不要联网、是不是权威）

| 字段 | 来源 | 离线 | 权威性 |
|---|---|---|---|
| 包名 / 命名空间 | 描述符文件名 + `xpkg parse` | ✅ | 权威 |
| 描述 / 许可 / 仓库 | 描述符 `package.{description,licenses,repo}` | ✅ | 权威 |
| 版本（按平台） | `mcpp xpkg parse --json` → `versions` | ✅ | 权威 |
| 用法标签 | `xpkg parse` 字段组合 → `SURFACES` | ✅ | 推导 |
| 示例代码 | 索引仓库 `tests/examples/<proj>/tests/*.cpp` | ✅ | **真实（CI 跑过）** |
| openkal facet | `.xpkgindex/openkal-compat.json` | ✅ | 实测记录 |
| 已声明依赖 | `mcpp.toml` | ✅ | 权威 |
| 已解析版本 | `mcpp.lock` | ✅ | 权威 |
| 有更新 | 索引最新 vs lock 解析 | ✅ | 推导 |
| 传递依赖树 | — | — | ❌ 上游没有机器可读形状 |
| README / star | GitHub API | ❌ | **不做** |

**一个重要的简化**：v6 之后，**整个库视图零网络**。联网只剩"跨 registry 搜索"这一个用途，
所以那个开关的语义变清晰、风险也变小了。

### 13.3 我没验证的（别当结论）

1. **"所有视图关闭 → 容器从 Activity Bar 消失"没有在真实 VS Code 里验证过**（依据是 issue #49145
   已 closed/verified + 第三方文章）。这是"侧边栏可关闭"的地基，**落地第一步就要写 e2e 钉死**。
2. 233 个描述符读一遍的耗时没实测；若 > 300ms 需要缓存。
3. 全部 233 个描述符的字段规范性没验证（只抽样了 6 个）。
4. `mcpp xpkg parse` 的输出我只看了 3 个包；`unknown_keys` 非空的包会怎样没试。
5. WebviewView 在 200px 窄宽度的真实表现——原型是 HTML 模拟。
6. `mcpp add` 是否联网、耗时多少、失败表现，没测。
7. `.xpkgindex/openkal-compat.json` 的字段结构没细看（只确认它存在且是实测记录）。

### 13.4 风险

| 风险 | 对策 |
|---|---|
| 联网搜索档要解析 `mcpp search` 人类输出（项目原则是只有一处） | 默认关闭 + 失败退回本地；登记 U.8 |
| 读 Lua 描述符是否算"重造 mcpp 职责" | 限度写死：只读目录字段与示例关联；**任何权威值走 `mcpp xpkg parse`** |
| 索引路径硬编码 `~/.mcpp/registry` | `mcpp.library.indexPath` 可覆盖；找不到给明确提示而非空列表 |
| C++ Modules 归属变模糊 | 展开块固定「提供方」行 |
| 工程段因加常用命令变长 | 已确认可接受；需要更短时收成折叠 |
| 词表跟着上游变 | 词表**从插件推导而非硬编码**；上游改了词会跟着变（也可能破坏，需容错） |

### 13.5 我在这个过程中说错、已更正的（累计 5 条）

1. v1 把 Q3 问成"要不要动作"——措辞误导，真实问题是"动作与数据同级混排"。
2. v2 说容器图标糊是因为 PNG——部分对；真实原因是用的是**另一张图**，加上黑墨迹在深色主题对比度低。
3. v3 说 `mcpp why <pkg>` 有 JSON 可解释依赖来源——**错**，只有 `why toolchain` 有。
4. v3 提议我手绘单色 SVG——你没要；后来改为从官方图机械派生，最终撤销，直接用官方原图。
5. **v5 提的 A–I 形状标签是错的**——那是"怎么构建"，官方站用的是"**怎么使用**"（`SURFACES`）。
   你让我参考 `mcpp-index` 仓库，直接纠正了这一条。

---

## 14. round 2：一条被我自己推翻的假设（重要）

**§13.3 第 1 条说"所有视图关闭 → 容器从 Activity Bar 消失"只是依据二手资料、没验证过。
我在本机 VS Code 1.132 的源码里查了，结论是：不成立。**

证据链：

1. `paneCompositeBar.ts` 里，Activity Bar 的每一项由
   `showOrHideViewContainer(container)` 决定：`shouldBeHidden(container)` 为真才 `hideComposite`。
2. `shouldBeHidden` 的第一段是**决定性**的：
   ```ts
   if (viewContainer) {
       if (viewContainer.hideIfEmpty) { … }
       else return false;          // ← 没有这个标志就永远不隐藏
   }
   ```
3. `hideIfEmpty` 的注释是「If enabled, view container is not shown if it has no active views」，
   全仓库**只有一处**赋值：`registerGeneratedViewContainer()`（VS Code 自己给"用户自定义容器"用的），
   值为 `true`。
4. 我在已安装的 `workbench.desktop.main.js`（1.132）里把 `hideIfEmpty` 的 **24 处**全部看了：
   每一处都是**内置容器**的注册（ports / test / voice / debug / 用户容器 …），
   **没有任何一处从扩展清单读取**。

所以：**扩展无法把自己的容器标记为"空则隐藏"**。对第三方容器，把所有视图 `when` 设为 false 只会
让**内容**消失，图标会留下（点开是空面板）。我原先依据的 VS Code issue #49145（closed/verified）
和那篇第三方文章，对 1.132 不再适用。

### 已做的修正

- `mcpp.views.enabled` 的标题与描述改成实话：**「隐藏 mcpp 视图内容」**，并说明图标是否移除由
  VS Code 决定、要移除可在图标上右键。中英同步，注册表与 nls 一致（`check-config` 通过）。
- `when` 门控保留——**内容隐藏这件事是确定的**（走的是 `activeViewDescriptors.length === 0` 那条路径）。
- 教训记在这里：**二手资料必须用一手源码或真实运行验证**。这条假设是整套里风险最高的地基，
  幸好先查了。

### 另外两处本轮修掉的

- `mcpp.internal.markIndex` 之前注册了却没人调用，`mcpp.library.updateIndex` 装好索引后
  `viewsWelcome` 不会消失。改成 `markIndexFound()`，在激活时与 `index update` 之后都重算。
  **（§15.4 更正：这条整段作废——webview 视图根本不支持 `viewsWelcome`，`markIndexFound`
  已于 round 3 连同 `mcpp.library.indexFound` 一起删除。）**
- `test/architecture.test.ts` 补上库生态的 4 个纯模块（`indexModel` / `xpkg` / `libraryHtml` /
  `detailHtml`），让"纯模块不得依赖 vscode"这条覆盖到新代码。

## 15. round 3：你在真实实例里给的 6 条反馈

这一轮的每一条都是先在**一手源码**或**本机真实运行**里定位到根因，再改。下面把证据一起留下，
因为它们决定了改法——其中两条的"根因"和最初看起来的完全不是一回事。

### 15.1 基本信息默认折叠、常用命令默认展开（反馈 1、2 前半）

数据层一行的事：`buildProjectTree` 里 `project.section.basic` 去掉 `expanded: true`，
`project.section.commands` 保留。测试从「两个 section 都展开」改成
「命令展开、基本信息 `expanded === undefined`」。
dev profile 的 `workspaceStorage` 会在重启前清掉，否则 VS Code 会用上次记住的展开状态覆盖默认。

### 15.2 通用命令图标带色（反馈 2 后半）

树**支持**颜色，快捷菜单**不支持**——两者机制不同，所以这里能做的和那里能做的不是一件事。

树的证据（1.132 `workbench.desktop.main.js`，`CustomTreeView` 的渲染分支）：

```js
this.shouldShowThemeIcon(!!r, n.themeIcon) && (L = j.asClassName(n.themeIcon),
  n.themeIcon.color ? i.icon.style.color = this.themeService.getColorTheme()
                        .getColor(n.themeIcon.color.id)?.toString() ?? "" : L = L + " codicon-colored")
```

所以 `TreeNode` 加了 `iconColor?: string`（`ThemeColor` id），只允许 `charts.*` 这类所有主题都
会定义的 id；主题没定义时 VS Code 让颜色为空串，图标退回普通前景色，不会变成看不见。
配色按**这一行作用于什么**分组，不按装饰：蓝=构建/添加、绿=运行/校验、紫=测试、橙=删除、
黄=工具链、设置保持中性。

### 15.3 快捷菜单：图标 + 分组（反馈 3）

`quickMenuItems` 现在每条带 `icon`，菜单按 `QUICK_MENU_GROUPS` 插 `QuickPickItemKind.Separator`
做分组；分组标题与条目共用一张表，所以不可能出现"条目的分组没有标题"。

**颜色做不到，这是 API 限制，不是没做。** 1.132 的 `MainThreadQuickOpen.expandIconPath`：

```js
expandIconPath(o){ let e = o.iconPathDto;
  if (e)
    if (j.isThemeIcon(e)) o.iconClass = j.asClassName(e);        // ← color 被丢掉
    else if (Qh(e)) { let t = P.from(e); o.iconPath = { dark: t, light: t }; }
    else { … } }
```

`ThemeIcon` 被压成一个 codicon class，列表渲染只写
`i.icon.className = "quick-input-list-icon " + r.iconClass`，没有任何一处读颜色。
所以这一轮**只做了图标形状 + 分组**，没有塞一个"永远画不出来"的颜色。顺带把 5 个分组标题与 20 条
条目全部补上中文（原来 27 个 labelKey 里 20 个没有译文，中文用户看到的是英文），并加了
`test/commands/menu.test.ts` 把"每个 labelKey 必须有译文""分组必须连续"钉住——这两件事
`tools/l10n-check.mjs` 看不见，因为菜单标签是 `t(item.labelKey)` 而不是字面量。

### 15.4 库视图与「刷新 mcpp 包索引」毫无反应（反馈 4）

**根因不是索引定位，是 provider 从来没注册过。** 上一轮我把 `registerWebviewViewProvider`
从 `libraryView.ts` 里"交代给调用方"，`extension.ts` 的注释却写着"provider 由 registerLibraryView
自己注册"——两边互相甩锅，结果**整个 `src/library/` 里一次都没有这个调用**
（`grep -rn registerWebviewViewProvider src/` 当时只有 `cachePanel.ts` 一处）。
没有注册就没有 document，`refresh()` 永远打在 `this.view === undefined` 上：
视图是空的，刷新是无声的。修法是在 `registerLibraryView` 内部注册（与 `registerCachePanel`
同构），并加了一条**能抓住这类错误**的门禁：

```
test("every webview view registers the provider that fills it")
  → 每个 "type": "webview" 的视图 id 必须有唯一一个 `export const *_VIEW_ID = "<id>"` 模块，
    且该模块必须调用 registerWebviewViewProvider
```

索引定位按你的建议增强了，但放在**最后**，因为它不是这次的根因：

| 顺序 | 找法 | 代价 |
| --- | --- | --- |
| 1 | `mcpp.library.indexPath`（用户显式设置） | 0 |
| 2 | `$MCPP_HOME/registry/data`、`~/.mcpp/registry/data`，**有内容的都列** | 几次 `readdir` |
| 3 | `mcpp self env --format json` 的 `mcppHome` | 每会话最多 1 个进程，且只在 2 全空时才跑 |

第 3 步走机器协议（`schemaVersion` + `kind`，见 `src/cli/protocol.ts` 的检测规则），
在**不受信任的工作区跳过**（`mcpp.path` 是 resource 作用域，不能让工作区指定要跑的二进制）。
本机实测（用 `Module._load` 打桩 `vscode` 后直接跑编译产物）：

| 场景 | 结果 |
| --- | --- |
| 设置指向 mcpp-index 检出 | 1 个 root / 238 包 / 146 ms，二次 0 ms（快照缓存命中） |
| 默认（不设） | 3 个 root / 543 包 / 228 ms |
| 两个 home 都空 → `mcpp self env` | 3 个 root / 543 包 / 674 ms |
| mcpp 缺失 | 空 / 5 ms，不抛 |

（写这条时踩了自己的一个 bug：`defaultDataDirectories` 先用探针**之前**的候选列表判断
"探针给的主目录是不是新的"，而探针恰恰是把它加进列表的那一步，于是永远判定"不新"、
永远返回旧列表。改成探针后重读候选列表。这个 bug 只有在真的构造出"两个 home 都空"的场景
才会暴露——上面那张表就是这么写的。）

「刷新 mcpp 包索引」另外两处修：成功后**有反馈**了（进度通知 + 「已刷新：N 个包，来自 M 个索引目录」，
之前成功时零输出，看起来就是坏的），并且补上不受信任工作区的拦截。

顺手删掉两处**已被证伪的死代码**：`mcpp.library.indexFound` 上下文键与 `viewsWelcome.library`
文案。1.132 里基类 `ViewPane` 的 `shouldShowWelcome(){return !1}`，只有 tree 类视图覆写它
（`TreeViewPane` 用 `dataProvider.isTreeEmpty`），所以 `"type": "webview"` 视图**永远不会**
渲染 welcome 内容；库视图在自己的 document 里说空状态，那是唯一会被显示的地方。

### 15.5 全局构建缓存的分布条是黑的（反馈 5）

根因是 CSS 选择器和渲染出来的 DOM 差了一层：

```
渲染：  <section data-viz="composition"> … <g data-kind="pkg" …><rect …/></g>
样式：  [data-viz="composition"] rect[data-kind="pkg"] { fill: … }   ← rect 上没有 data-kind
```

`rect[data-kind]` 谁都不匹配 → 每个 `<rect>` 落到 SVG 的默认填充（**黑**，任何主题都是黑）。
图例里的 `.swatch[data-kind="pkg"]` 是打在 `<span>` 上的，所以**图例有颜色、条没有**，
正好就是你看到的样子。修法：选择器改到 `<g>`（`fill` 是继承属性，会漏到子 `<rect>`），
并在 `test/views/cachePanelHtml.test.ts` 加了一条**文档与样式表互查**的测试：
既要求文档真的把属性打在 `<g>` 上，也要求样式表为每个值都有 `fill` 规则，同时**禁止**
`rect[data-…]` 这种写法再出现。

### 15.6 活动栏的 mcpp logo 是白的 / 不显示（反馈 6）

一手证据在 `ActivityAction.toCompositeBarActionItem`（1.132）：

```js
let c = kc(i), l = new ab; l.update(c); let u = `activity-${e.replace(/\./g,"-")}-${l.digest()}` …
Sf(p, `
  mask: ${c} no-repeat 50% 50%;
  mask-size: var(--activity-bar-icon-size, ${this.options.iconSize}px);
  -webkit-mask: ${c} no-repeat 50% 50%; …`)
```

**自定义容器图标是被当模板（mask）用的**：画出来的是图标的 **alpha 通道**，颜色来自主题
（`.style-override` 下未选中是 `--vscode-icon-foreground`、选中是 `--vscode-foreground`，
hover/active 是 `--vscode-activityBar-foreground`）。而官方 logo 是一张
**377×377 不透明黑色圆角方块**（实测：不透明覆盖率 90%，其中 81.5% 是纯 `#000000`、
6.7% `#f08c00`、5.7% `#1971c2`）。拿它当模板，自然就是**一整块浅色方块**——你看到的"白色"。

修法：`images/activity-bar.png` 改为**派生资产**——透明底 + 只留字形的白色 alpha
（96×56，字形 88×48）。由 `tools/generate-activitybar-icon.mjs` 从 `images/logo.png`
重新生成；覆盖率用「像素 = 覆盖率 × 墨色」反解（两个平涂色的最大通道做分母），
6% 以下当作徽章边缘抗锯齿丢掉，所以不会在字外留一圈灰晕。白色 + 透明底在 alpha 模板和
亮度模板下**都对**，不依赖 Chromium 选哪一种。`npm run check:icon` 进了 `npm run check`，
产物与来源不可能漂移。市场图标（`package.json` 的 `icon`）继续用真 logo。

### 15.7 这一轮的状态与仍然没做到的

- 646 个单元测试通过；`check:config`（68 设置 / 32 public）、`l10n-check`（382 运行串 /
  201 清单键）、`check:icon`、`check:generators` 全过；VSIX 93 文件 / 343 KiB（两道体积门禁内）。
- dev profile 重装并重启，扩展主机日志确认激活、无错误。
- **没做到**：快捷菜单图标没有颜色（15.3 的 API 限制）；活动栏图标在真实主题下的观感只能靠眼睛，
  我没有截图能力；e2e 仍未在本地跑通（要下载固定版 VS Code，本机大文件下载会中断）；
  索引定位的三条路径是靠打桩 `vscode` 后直接跑编译产物验证的，不是通过编辑器 UI 验证的。


## 16. round 4：第二轮真实反馈（含一个把库视图打瘫的 bug）

这一轮的第一条是**真 bug**：库视图一显示就抖、点不动、搜不了、CPU 飙高，折叠起来就正常。
根因和"性能问题"完全无关。

### 16.1 库视图的渲染死循环（反馈 2，最高优先级）

**根因：文档在自我介绍，宿主拿"再渲染一次"回答它。**

`libraryHtml.ts` 的客户端脚本最后一句是 `post({ type: "ready" })`，而 `libraryView.ts` 的
`handle()` 里恰好有：

```ts
case "ready":
  this.paint();        // ← paint() 里是 view.webview.html = …
  return;
```

`webview.html = …` 会**重载**文档；文档重载后又发 `ready`。更致命的是每次 `paint()` 都调用
`randomNonce()` 生成新的 CSP nonce，所以**每次渲染出来的文档都不同**——连"内容没变就别重设"
这种自然去重也永远不会命中。于是视图以毫秒级无限重载：抖动、DOM 被反复销毁（点不到、输不进）、
CPU 打满。折叠时 webview 不渲染，所以"折叠就正常"。

上一轮这个 bug 之所以没暴露，恰恰因为 provider 从来没注册过——视图根本没渲染过。**修好注册，
就把它放出来了。**

修法三条 + 一条门禁：

1. 客户端不再发 `ready`，`decodeLibraryMessage` 不再认识它，宿主删掉 `case "ready"`：
   文档本身就是数据（每一行、每个徽章、每个计数都已经在里面），"我加载好了"这句话没有用途，
   只可能招来一次重复渲染。
2. nonce 改成**每个视图一个**（构造时生成一次），于是"内容没变 ⇒ 文档逐字节相同"成立。
3. `paint()` 多一道 `documentNeedsRender(this.document, document)`（纯函数，见 `libraryHtml.ts`）：
   文档相同就**不重设**，滚动位置和输入到一半的搜索框都不会被丢掉。
   `resolveWebviewView` / `onDidDispose` 会把 `this.document` 清空——新解析出来的 webview 是空的，
   上一次推给旧 webview 的文档对它没有任何意义。
4. `test/artifacts.test.ts` 新增源码级门禁：文档不得再 post `ready`、宿主不得再有 `case "ready"`、
   nonce 必须是每视图一个、比较必须存在。

### 16.2 快捷菜单图标配色（反馈 1）

**能做，但只能靠图片。** 上一轮我查到 `MainThreadQuickOpen.expandIconPath` 会把 `ThemeIcon`
压成没有颜色的 codicon class；这一轮把同一函数读完了——它是**两条分支**：

```js
expandIconPath(o){ let e = o.iconPathDto;
  if (e)
    if (j.isThemeIcon(e)) o.iconClass = j.asClassName(e);            // 字体图标：颜色由行前景决定
    else if (Qh(e)) { let t = P.from(e); o.iconPath = { dark: t, light: t }; }   // Uri：当 background-image 画
    else { … { dark, light } … } }
```

而列表渲染这边：

```js
if (r.iconPath) { … i.icon.className = "quick-input-list-icon"; i.icon.style.backgroundImage = kc(f); }
```

`Uri` 是当**图片**画的，颜色照原样显示；`iconPath` 又恰好接受 `{ light, dark }` 对。所以路线是：
**给每一行生成一张带颜色的 SVG**。

- 字形来自 `@vscode/codicons`（VS Code 自己那套 codicon 字体的美术源，作为 devDependency 精确锁定
  `0.0.46-24`），颜色取对应 `charts.*` 主题令牌的**默认 light/dark 值**（从 1.132 的颜色注册表读出）。
  于是快捷菜单和工程视图用的是同一批颜色：树把 `charts.blue` 交给 `ThemeIcon` 由主题上色，
  这里把同一个默认值烤进图里。
- 生成器 `tools/generate-quick-menu-icons.mjs` 解析 `src/commands/menu.ts` 的表格，输出
  `media/quick-menu/<icon>--<colour>--<dark|light>.svg`（40 个，zip 后约 34 KiB），
  支持 `--check`（多一个没人要的文件也算漂移），已进 `npm run check`。
- 门禁在 `test/commands/menu.test.ts`：逐行走表格，两个主题的资产必须存在、非空、不再含
  `currentColor`；并且**同一个命令在菜单和工程视图里必须是同一个图标 + 同一个颜色**
  （`charts.<word>` 是两者的接缝）。

顺手抓出三个真问题，都是门禁逼出来的：

| 发现 | 处理 |
| --- | --- |
| `charts.orange` 解析到 `minimap.findMatchHighlight` → `editor.findMatchHighlightBackground`，是 `#EA5C00` **33% 透明**；当字形颜色就是两头上都糊成一团 | 破坏性动作改用 `charts.red`（`editorError.foreground`，各主题都是实色）。树里的 Clean 一起改 |
| `star` 根本不是 codicon（只有 `star-full` / `star-empty` / `star-half`）——"选择全局默认工具链"那一行一直是**空图标** | 换成 `star-full` |
| "Search and add a dependency" 在树里是 `cloud`、在菜单里是 `library` | 统一成 `library`（它打开的就是 Library 视图） |

另外菜单里那 20 条标签的中英译文上一轮已补齐，这轮没有新增文案。

### 16.3 cache 视图默认折叠（反馈 3）

`contributes.views` 的条目 schema 里本来就有 `visibility: "visible" | "hidden" | "collapsed"`
（默认 `visible`），消费点是 `createView(n, { …, expanded: !collapsed })`。所以
`mcpp.cache` 加上 `"visibility": "collapsed"` 就够了：侧边栏打开时 cache 只剩标题栏，
高度让给上面的库列表。用户手动展开/折叠之后以用户的状态为准（VS Code 把它记在 workspace state 里）。
门禁在 `test/artifacts.test.ts`：三个视图的 `visibility` 必须恰好是
`[undefined, undefined, "collapsed"]`。

### 16.4 活动栏"彩色 logo"：做不到，所以不做（反馈 4）

你想要"保留单色 / 配置里切换彩色"。**彩色这条路在活动栏是不存在的**，有两条独立的一手证据：

1. 自定义容器图标是当**模板**画的（15.6 的 `mask: url(icon) … mask-size: 24px`），
   画出来的是图标的 **alpha 通道**，颜色来自主题变量。颜色信息在第一步就被丢掉了。
2. 清单里 `viewsContainers.activitybar[].icon` 的 schema 是纯 `string`
   （`{description:…, type:"string"}`，`required:["id","title","icon"]`），
   连 `{light, dark}` 这种写法都会被 `isValidViewsContainer` 直接判为非法；
   而且没有任何运行时 API 能改容器图标。

所以"配置里切换彩色/单色"会是一个**永远无效的开关**——比没有这个开关更糟。
单色字形保留（你说它和其他图标风格匹配，这也是它本该有的样子：活动栏图标就该是主题前景色的剪影）。

### 16.5 状态栏：背景色可以，logo 不行（反馈 5）

**背景色：VS Code 只允许两种，而且由扩展主机强制执行。** `StatusBarItem.backgroundColor`
的 API 文档写了"只支持 `statusBarItem.errorBackground` 与 `statusBarItem.warningBackground`"，
我不满足于文档，去找了实现（`extensionHostProcess.js`）：

```js
static ALLOWED_BACKGROUND_COLORS = new Map([
  ["statusBarItem.errorBackground",   new ThemeColor("statusBarItem.errorForeground")],
  ["statusBarItem.warningBackground", new ThemeColor("statusBarItem.warningForeground")],
]);
set backgroundColor(t){ t && !ALLOWED_BACKGROUND_COLORS.has(t.id) && (t = void 0); this._backgroundColor = t; … }
…
this._backgroundColor && (n = ALLOWED_BACKGROUND_COLORS.get(this._backgroundColor.id));  // ← 前景色被替换
```

也就是说：自建一个 `mcpp.statusBarBackground` 颜色会被**静默丢弃**；自己设 `color` 也会被覆盖。
实现方式是新设置 `mcpp.ui.statusBar.background`（`warning` / `error` / `none`，默认 `warning`），
纯映射放在 `src/cli/statusBar.ts`（已进纯模块门禁），`applyStatusBar()` 一行接上。
默认 `warning` = 主题的琥珀色块 + VS Code 自动配的白色前景，正好和 logo 的金橙呼应；不喜欢就设 `none`。

**logo 放状态栏：不行。** `StatusBarItem.text` 是字符串，里面的 `$(name)` 由
`ThemeIcon.fromString` 解析成 **codicon 字体字形**，没有任何图片通道；`StatusBarItem` 上也没有
`iconPath` 之类的字段。所以 `$(tools) mcpp` 保持不变——它是这套菜单（构建 / 工具链 / 缓存 / 模块）
最贴切的字形，而"换成 mcpp logo"这条路在 API 层面不存在。

### 16.6 这一轮的状态与仍然没做到的

- 653 个单元测试通过；`check:config`（69 设置 / 32 public）、`l10n-check`（382 运行串 /
  203 清单键）、`check:icon`（活动栏图 + 40 个菜单图标）、`check:generators` 全过；
  VSIX 134 文件 / 377 KiB（两道体积门禁内：<200 文件、<1 MiB）。
- dev profile 重装并重启（清掉 workspaceStorage，让 cache 的默认折叠生效），扩展主机日志确认激活、无错误。
- **没做到 / 需要你的眼睛**：快捷菜单的彩色图标我只验证到"文件内容正确、颜色被烤进去、
  能被栅格化成正确的颜色"，**没有**在真实 quick pick 里看过——如果 `file:` URI 在快速选择里
  加载不出来，那 16 行的槽位会是空的，那我就改走别的路子（data: URI 或退回单色）。这一条请重点看。
- 库视图的死循环是**逻辑上**必然成立（文档 self-announce + 每次新 nonce），但没有做进程级
  的 CPU 观测；"不抖了、能点了"需要你确认。
- 活动栏彩色、状态栏 logo：API 层面不存在，已用一手源码说明。
- e2e 仍未在本地跑通；索引定位的三条路径仍是打桩验证，不是 UI 验证。

## 17. round 5：状态栏背景回退、侧边栏配比、库标签与详情页、年龄渐变、新建工程

### 17.1 状态栏背景色默认关掉（反馈 1）

`mcpp.ui.statusBar.background` 保留（它仍是唯一能做的两种背景），但默认值从 `warning` 改成
`none`：一个常驻的琥珀色块会被读成"出问题了"。想要就设 `warning` / `error`，两个值都由
VS Code 自己配好对比度（见 16.5 的扩展主机白名单）。

### 17.2 侧边栏配比：库视图默认占下面 2/3（反馈 2）

`contributes.views[].initialSize` 不是像素，它是**视图在容器里的配比权重**（一手证据
`computeInitialSizes()`）：

```js
let t = this.viewContainerModel.visibleViewDescriptors.reduce((i,{weight:n}) => i + (n||20), 0);
for (let i of this.viewContainerModel.visibleViewDescriptors)
  e.set(i.id, this.dimension.height * (i.weight || 20) / t);   // 默认每个视图 20
```

所以给 `mcpp.library` 一个 `initialSize: 40`（默认 20 的两倍）就够：默认布局里项目视图拿 1/3、
库视图拿 2/3，cache 又是折叠的（只剩标题栏，它的份额按比例回流给另外两个）。门禁在
`test/artifacts.test.ts`：三个视图的 `initialSize` 必须恰好是 `[undefined, 40, undefined]`，
注释里带上上面那段权重公式。

### 17.3 库的标签去掉外框，详情页重排（反馈 3）

**标签**（`.badge`）之前是"1px 外框 + 圆角"的小方块，一行的标签看起来像一排按钮。
现在是不带任何框和底的**安静元数据**，相邻项之间用 `·` 分隔；只有必须被看见的两个状态
（`Added`、`Descriptor not readable`）保留颜色并加粗——文字本身也在说同一件事，所以不靠颜色。
**筛选 chip**（`.chip`）是交互控件，所以换成 VS Code 自己的 toggle 配色：
未选中 = 透明底、`descriptionForeground`；选中 = `inputOption.activeBackground/Foreground/Border`。
"未选中也描一圈边"正是让它像按钮的原因。

**详情页**的结构问题更根本：读者来点的那颗按钮原本在**四个段落之后**（`renderActions` 在
`<main>` 的最后）。现在顺序是：

```
标题 → 一句话描述 → 事实行（registry / surface / standard / 许可 / 徽章 / 仓库链接）
→ 主操作块（[Add to mcpp.toml] [☐ dev-dependency] + 命令预览）
→ 版本矩阵 → 用法示例 → 依赖 → 其它
```

同时把**版本矩阵变成选择器**：每个版本是一个 button（`data-version`），点它就把上面的命令
指到那个版本，被选中的那枚用同一套 toggle 配色标出。原来 `<select>` 和版本清单是**两处**
重复的版本 UI、只有 select 能点，现在只有一处、可点。分区标题也从"12px 大写＋字距"的微标签
改成正常的 13px/600 小标题 + 每节一条 hairline，四个区不再像四条工具条。

顺手修掉同一类陷阱：详情页客户端原本也 post `ready`，宿主 `case "ready": return;` 是**空实现**
（所以没像库视图那样死循环），但这个形状正是库视图无限重载的成因——一并删除，并加了
"内联脚本语法有效且不 post ready"的门禁（详情页此前没有这道门禁）。

### 17.4 年龄分布条改成冷→热渐变（反馈 4）

原因很直接：`[data-viz="age"] g[data-bucket]` 把所有桶画成同一个绿色，只有最后一个溢出桶是
黄色，所以 `8.1% / 85.5% / 6.4% / …` 四段读起来是一整块。

桶的数量由 `mcpp.cache.staleDays` 决定，**CSS 数不出桶**，所以在渲染器里算好再落到属性上：

```ts
export function ageRampStep(index, count) {   // 0 = 最新 … 3 = 最旧
  if (count <= 1) return 0;
  return Math.round((clamp(index) / (count - 1)) * 3);
}
```

`<g>` 与图例色块都带 `data-age-step`，CSS 四档 = `charts.blue` → `charts.green` →
`charts.yellow` → `charts.red`（都是实色；`charts.orange` 是 33% 透明，不能用）。
两个桶的机器拿到两端，四个桶拿到四档，更长的桶数会被摊到同样这四档——渐变是一个形状，
不是"桶一定有几个"的承诺。旧的两条 `data-bucket` 着色规则删掉了（否则它们会覆盖渐变），
`data-bucket` 只留作"溢出桶"的语义标记。

### 17.5 通用命令加「新建 mcpp 工程」；「初始化当前目录」做不到（反馈 5 后半）

- `COMMON_COMMANDS` 增加第九行「New mcpp project…」（`mcpp.newProject`，`new-folder` 图标，
  蓝色），排在**最前**：这一节是"能做什么"，而在一个空工作区里能做的只有建工程。
- **没有工程时**的树原本只有一句话，现在那句话下面直接给出同一个入口（`newProjectNode()`，
  两处共用一份定义，不会各自漂移）。
- 「新建工程」第二步的目录选择加了 `defaultUri` = 当前工作区目录，从读者所在的地方开始。

**「初始化某个目录」无法实现，这是 mcpp 自己的约束**（`mcpp/src/scaffold/create.cppm`）：

```cpp
const auto finalPath = parent / project.directoryName;
if (std::filesystem::exists(finalPath, existenceError) || existenceError) {
    mcpp::ui::error(... std::format("'{}' already exists", finalPath.string()));
    return 1;
}
```

`mcpp new` 拒绝任何**已存在**的目标目录（不只是非空），且没有 `--here` / `--force`；`mcpp --help`
里也没有 `init` 子命令。所以"把当前目录变成 mcpp 工程"今天没有可执行的命令可调。你提到的
"覆盖需要确认"也因此不适用——mcpp 根本不会覆盖，它会拒绝。这需要上游加一个 `mcpp init`
（或让 `new` 允许空目录），我按约束没有改 mcpp。

### 17.6 活动栏"在/不在 mcpp 工程用不同颜色"：做不到（反馈 5 前半）

这一条和 16.4 是同一个结论，只是这次要的是**运行期变化**而不是配色开关，而它更不可能：

1. 容器图标是**清单里的静态字符串**，没有任何运行时 API 能改（`viewsContainers` 只在激活时读一次）。
2. `viewsContainers` 的条目 schema **没有 `when`**（round 2 的 §14 已证），
   `hideIfEmpty` 只有 VS Code 内置容器能设，所以也不能"声明两个容器然后按工程状态显示其中一个"。
3. 就算能改，图标是当 mask 画的（16.6），彩色也画不出来。

**能表达"我在不在 mcpp 工程里"的地方是有的，而且位置更合适**：工程视图正文（没有工程时
直接说"当前工作区没有 mcpp 工程"并给出新建入口）、以及状态栏项（不在工程里时整个隐藏）。
这一轮把前者做得更可用了（17.5），活动栏保持单色剪影——那本来也是活动栏图标的画法。

### 17.7 这一轮的状态

- 655 个单元测试通过；`check:config`（69 设置 / 32 public）、`l10n-check`（383 运行串 /
  203 清单键）、`check:icon`（活动栏图 + 40 个菜单图标）、`check:generators` 全过；
  VSIX 134 文件 / 380 KiB。
- dev profile 重装并重启（清 workspaceStorage，让新的配比与折叠默认值生效），日志确认激活、无错误。
- **需要你的眼睛**：侧边栏 1/3 : 2/3 的实际手感（权重只在**没有**记住过布局时生效，我清了
  workspaceStorage 所以这次是新布局）；库标签去掉外框后是否够"标签"；详情页新顺序是否顺手；
  版本按钮点选是否明显；年龄条的冷→热渐变是否读得出差异。
- 仍未做到：活动栏状态色、状态栏 logo、"初始化当前目录"（三条都是 API/上游约束，各有源码证据）；
  e2e 仍未在本地跑通。

## 18. round 5 补：快捷菜单的 C++ Modules 分组补上"抓日志"和"日志/压缩包在哪"

反馈原话：C++ Modules 分组下面应当有**触发抓 log** 的选项，以及**打开 log 压缩包目录**的选项。

先说清上游有什么（读了 mcppls 源码 `editors/vscode/src/commands.ts`，不是猜的）：

| 上游命令 | 实际行为 | 返回 |
| --- | --- | --- |
| `mcppls.collectReport` | 打开一份 JSON 诊断报告（版本/设置/环境/服务端报告，已脱敏），并给出复制/导出/看日志三个按钮 | 无 |
| `mcppls.exportDiagnosticBundle` | **抓取日志**（上游自己的中文标签就是「抓取日志（含报告）」）：把报告、环境、最近几次会话的日志、incident、引擎数据库写成一个 zip；写完自己弹提示，带「Reveal in Folder」「Copy Path」 | **zip 的路径字符串** |
| `mcppls.showLogs` | 打开 Output 面板里的日志 | 无 |
| `mcppls.revealCacheDirectory(which)` | `which === 'logs'` → `revealFileInOS(paths.logDirectory)`，否则 → 工作区 cache 根 | 无 |

也就是说"抓 log"和"打开日志目录"上游**都有**，只是我们的快捷菜单一条都没挂。这一轮挂上四条：

- `C++ Modules: capture the logs (report + bundle)`（`file-zip`）→ `exportDiagnosticBundle`
- `C++ Modules: show the diagnostic report`（`report`）→ `collectReport`
- `C++ Modules: open the log folder`（`folder-opened`）→ **新命令** `mcpp.languageServer.openLogFolder`，
  转发 `mcppls.revealCacheDirectory` 并带参数 `["logs"]`
- `C++ Modules: show the last captured bundle`（`folder`）→ **新命令** `mcpp.languageServer.revealBundle`

两处新东西值得说明：

**1. 命令的返回值以前被丢掉。** `CapabilityRegistry.invoke` 写的是
`await executeCommand(candidate, ...args)`——返回值直接扔了。而"压缩包在哪"**只有**那个返回值知道
（zip 写在 `<平台 cache>/bundles/mcppls-bundle-<UTC>.zip`，见 mcppls `src/bundle/writer.cpp`；
我们**不能**自己去拼这个路径，那是把上游的私有布局复制到客户端）。所以 `InvokeResult` 增加了
可选的 `value`，原样透传、不做任何解释；`exportDiagnosticBundle` 收到路径就记进
`globalState`（压缩包目录本来就是机器级的），`revealBundle` 再用 `revealFileInOS` 定位它。
没抓过就直说，并给出「现在抓取」按钮；文件被删了也走同一条提示。

**2. `mcppls.revealCacheDirectory` 的参数由我们传。** 能力表里只登记命令 id，
参数留给调用方（`args: ["logs"]`），所以一条 `logsDirectory` 能力就能覆盖上游那一个命令。

### 18.1 顺手抓到一个我自己刚要犯的错

把 `exportDiagnosticBundle` 从"通用 forward 表"改成手写 `register`（为了拿到返回值）时，我**没有**
删掉下面那行 `forward(LANGUAGE_SERVER_COMMANDS.exportDiagnosticBundle, "diagnosticBundle")`。
`vscode.commands.registerCommand` 对重复 id 会**抛异常**，而它发生在 `activate()` 里——整个扩展都
起不来，不是只坏第二个注册。

这种错靠 review 很容易漏（两处相隔 40 行），所以加了可执行的门禁：`test/config/wiring.test.ts`
新增「no command id is registered twice」——把 `ids.ts` 的 `<GROUP>_COMMANDS.<name>` 解析回真实 id，
再扫 `src/**` 里所有 `register(` / `forward(` / `.registerCommand(` 的首参，任何 id 出现两次就失败。
**并且我把这个 bug 人为放回去验证过门禁真的会红**：

```
✖ no command id is registered twice
  registered more than once: [["mcpp.languageServer.exportDiagnosticBundle",
                              ["src/views/languageServerView.ts","src/views/languageServerView.ts"]]]
```

### 18.2 状态

- 658 个单元测试通过（新增：返回值透传 + 参数透传、菜单覆盖这四条且都能找到注册点、重复注册门禁）；
  `check:config`（69 设置）、`l10n-check`（385 运行串 / 205 清单键）、`check:icon`（48 个菜单图标）、
  `check:generators` 全过；VSIX 142 文件 / 386 KiB。
- dev profile 重装并重启，日志确认激活、无错误。
- **需要你验证**：`$(tools) mcpp` 菜单里 C++ Modules 那一段现在有 9 条；抓一次日志，看上游的
  「Reveal in Folder」是否出现；再点 `show the last captured bundle` 是否**直接定位到那个 zip**；
  `open the log folder` 是否打开系统文件管理器的日志目录。
  未安装/未启用 mcppls 时这四条应给"上游不提供该动作"的降级提示而不是报错（能力表 `required: false`）。

## 19. round 6：搜索框下不再有标签行、详情页合成一行按钮、活动栏 logo 为什么是灰的

### 19.1 库视图：移除筛选 chip 行（反馈 1）

搜索框和网络开关之间原本是**一排可换行的筛选 chip**：All、每个命名空间一个、Added、每种用法
（surface）一个。在真实索引上这是**三行按钮**压在列表上方——而列表才是这个视图的本体。
这一轮把它整行去掉。

去掉的不只是 DOM：chip 是"客户端过滤"的入口，所以随之删掉的是整条链路——
`LibraryChip` / `LibraryModel.chips` / `activeChip`、`{type:"filter"}` 消息及其解码分支、
客户端里的 chip 取值与 aria 维护、`chipsOf`、以及只为它存在的**纯模型函数**
`LibraryFilter` / `ALL_FILTER` / `ADDED_FILTER` / `matchesFilter` / `visibleEntries` /
`namespaceCounts` / `surfaceCounts` / `addedCount` 和它们的测试、`media/library.css` 里的
`.chips` / `.chip*` 规则。留下的是搜索框 + 网络开关 + 行本身的徽标。

**没有丢功能**：一个行的 "haystack" 里本来就有 id（含命名空间），所以输入 `compat` 或
`compat.` 就是按命名空间过滤；"已添加"这件事在行上是徽标（`Added`，绿色加粗），不需要一个
筛选器才能看见。这一点在测试里写成了断言：工具栏里只有 `library-search` 和 `library-network`，
文档里不存在 `class="chip"` / `data-chip` / `class="chips"`。

### 19.2 详情页：三颗按钮一行（反馈 2）

`Open the repository` 和 `Open on the index site` 原来在**事实行**末尾（跟着 registry / surface /
standard / 许可 / 徽章 一起换行），而 `Add to mcpp.toml` 在主操作块里——同样是"要做的事"，
却分在两个地方。现在它们并排在同一行，且后两颗是次要按钮（`data-secondary`）：

```
[Add to mcpp.toml]  [☐ dev-dependency]  [Open the repository]  [Open on the index site]
```

实现上复用了客户端已有的 `[data-open-url]` 点击分支（它只要求元素带这个属性，不要求是 `<a>`），
所以没有新的脚本逻辑；事实行只剩事实。测试断言三颗按钮都在同一个 `.detail-actions` 里，
且页面里不再有裸的 `<a href="https://…">`。

### 19.3 活动栏的 mcpp logo 为什么是灰的——它不是 PNG，是"模板"（反馈 3）

先给结论：**这不是没修好，是 VS Code 的画法；那个 PNG 永远不可能以彩色出现在活动栏。**

一条你自己就能验证的判据：**文件里的像素是纯白 `#FFFFFF`，而你看到的是灰 `#C5C5C5`。**
`#C5C5C5` 正是 Dark Modern 里 `icon.foreground` 的值，而它**在文件里一个像素都不存在**：

```
$ python3 …/pngstat.py .dev-profile/extensions/mcpp-community.mcpp-vscode-0.6.0/images/activity-bar.png
opaque coverage 33.9%
top colours: #ffffff 100.0%        ← 不透明像素 100% 是纯白
```

如果 VS Code 把这张图当图片画，你看到的就是**纯白**；你看到灰色，说明**颜色是在文件和像素之间
被换掉的**，换掉它的就是那条 mask（§16.4 抄过源码）：

```js
// ActivityAction.toCompositeBarActionItem
Sf(p, `mask: ${url} no-repeat 50% 50%;
        mask-size: var(--activity-bar-icon-size, 24px); …`)
```

mask 只取 **alpha 通道**当镂空，颜色来自主题变量（未选中 `--vscode-icon-foreground`、
选中 `--vscode-foreground`、hover `--vscode-activityBar-foreground`）。所以：
"单色描边"是这条路径的**唯一可能结果**，与文件是 PNG 还是 SVG、彩色还是黑白无关。

**hover 一下就能再确认一次**：鼠标移上去或点开视图时，灰色会**变亮**（换成另一个主题色）。
图片不会因为 hover 改颜色，模板会。

为什么"配置里切换彩色/单色"也做不到，三条各自独立（任一成立就够）：

1. 清单里 `viewsContainers.activitybar[].icon` 的 schema 是**纯 string**
   （`{description:…, type:"string"}`，`required:["id","title","icon"]`），连 `{light, dark}`
   这种写法都会被 `isValidViewsContainer` 判为非法。
2. 这个字符串只在**激活时读一次**，没有任何运行时 API 能改容器图标。
3. `viewsContainers` 没有 `when`，`hideIfEmpty` 只给内置容器用，所以也不能"声明两个容器、
   按工程状态显示其中一个"。

**能做的、也仍然建议保留的**：单色剪影。活动栏里其他图标全是主题前景色的剪影，mcpp 这一枚
跟它们是一个画法——这也是你上一轮说"效果很好、和其他图标风格匹配"的那个效果。
**彩色 logo 已经出现在能被上色的地方**：扩展市场/扩展列表用的是 `package.json` 的
`icon` = `images/logo.png`（真彩色官方 logo），README 里也是它。

如果你希望在编辑器内部也看到彩色 logo，唯一可用的位置是 **webview 视图的正文**（库列表页 /
详情页，它们是 webview，`img-src` 允许扩展自己的资源）——那需要把 `images/` 加进那两个
webview 的 `localResourceRoots` 并在文档里放一个 `<img>`。这是一次**新增品牌露出**，不是修复，
所以我没有擅自加；你要的话我加。

### 19.4 状态

- 657 个单元测试通过（净减 0：删掉的 chip 测试换成了"工具栏里没有 chip"的断言）；
  `check:config`（69 设置）、`l10n-check`（383 运行串 / 205 清单键）、`check:icon`（48 图标）、
  `check:generators` 全过；VSIX 142 文件 / 384 KiB。
- dev profile 重装并重启，日志确认激活、无错误。
- **需要你验证**：库视图搜索框下面应该直接是列表（没有标签行），输入 `compat` 仍能按命名空间过滤；
  详情页顶部是一行三颗按钮；活动栏那枚图标 hover 时会变亮（这就是"它是模板"的证据）。

## 20. round 7：详情页显示"已添加/已安装版本"、按钮变成切换版本；链接点击不再无声

### 20.1 详情页认识"这个工程已经有什么"（反馈 2）

列表行的 `Added` 徽标来自工程 `mcpp.toml` 的声明，而详情页什么都没读——所以同一个包，列表说
"已添加"，详情页却像从没见过。现在详情页在构建模型时读一次工程自己的答案
（`detailPanel.readInstalled`）：

1. **`mcpp.toml` 优先**：`[dependencies]` / `[dev-dependencies]` 里这个包声明的精确版本。
   实测过 mcpp 写进去的键是**短名**（`mcpp add compat.argparse@3.2` → `argparse = "3.2"`），
   而索引里的 id 是 `compat.argparse`，所以匹配规则是"等于 id 或是它的最后一段"——与
   `indexModel.declaredDependencies` 给行打 `Added` 用的规则一致。
2. **`mcpp.lock` 兜底**：清单里没有版本（path/git 依赖）或工程解析过但没走 `mcpp add` 时，
   用锁文件里 resolved 的版本。

于是版本矩阵里**那个版本自己带标记**（`data-installed` + 一个 `added` 文字标签，文字而不是
只有颜色），主按钮的文案与状态跟着走：

| 工程的状况 | 选中的版本 | 按钮 |
| --- | --- | --- |
| 没有这个依赖 | 任意 | `Add to mcpp.toml` |
| 已有 3.2 | 3.2（默认） | `Already added`，**禁用** |
| 已有 3.2 | 3.3 | `Switch to 3.3`，可点 |

"切换版本"是**真的能切换**，不是猜的：我在 `/tmp` 的副本里实测过
`mcpp add compat.argparse@3.2` → `argparse = "3.2"`，再 `mcpp add compat.argparse@3.1` →
**同一条依赖被就地改成 3.1，退出码 0**。所以不需要 remove+add 两步，也不需要新的确认弹窗。

按钮的文案有两个来源：首屏由宿主按默认选择渲染，之后由客户端按当前选择重算（标签随
`clientState` 一起下发，与命令预览同一个机制）——否则按钮的含义会跟不上版本选择。

**还修了一处随之而来的不一致**：`mcpp add` 成功后页面**不会**重建（这是刻意的：重建会丢掉
滚动位置和读者选中的版本），所以原来"加完还在显示 Add"。现在结果消息带上
`added.version`，客户端就地移动 `added` 标记并重算按钮（`markInstalled()`，用
`createElement`/`textContent`，不碰 `innerHTML`）。

### 20.2 链接点击不再无声（反馈 3）

根因就一行：

```ts
void vscode.env.openExternal(vscode.Uri.parse(message.url));   // 返回的 boolean 被丢掉
```

`openExternal` 解析成"是否成功打开"，而这里用 `void` 扔掉，于是**打不开的时候用户看到的是
零反馈**——和按钮坏掉无法区分。现在：

1. **客户端先说话**：点下去立刻在页面的状态行写 `Opening <url>…`（`data-state="pending"`），
   宿主的结果再覆盖它。这样即使宿主那侧出问题，你也能看到"点击到了、但没有回音"。
2. **宿主按结果回答**：成功 → `Opened <url> in your browser.`；失败 → 把 URL **复制到剪贴板**
   并在状态行说明（`VS Code could not open …; the link is on your clipboard.`），
   同时在 `mcpp` 输出通道留一行记录，便于诊断（这台机器上 `xdg-open` 与
   `google-chrome.desktop` 都在，所以更可能是打开成功而你只看到"没有反馈"——这条修复让两种
   结果都可见）。

`DetailResult.state` 因此多了第三个取值 `pending`（客户端自己的那一行），CSS 也有对应的一条。

### 20.3 状态

- 660 个单元测试通过（新增：已添加/切换版本的三种按钮状态与标记位置、客户端能重算按钮且点击先
  给 pending、源码门禁"不再 `void openExternal` 且两条结果都 post"）；
  `check:config`（69 设置）、`l10n-check`（389 运行串 / 205 清单键）、`check:icon`、
  `check:generators` 全过；VSIX 142 文件 / 387 KiB。
- dev profile 重装并重启，日志确认激活、无错误。
- **需要你验证**：打开一个**已经在 `mcpp.toml` 里**的包 → 版本行里那一版应有 `added` 标记、
  按钮应是 `Already added`（禁用）；点另一个版本 → 按钮变 `Switch to <ver>`；点它 → 成功后
  标记与按钮**原地**更新。再点 `Open the repository` / `Open on the index site` → 状态行
  应立刻出现 `Opening …`，随后变成 `Opened …`（或"无法打开，已复制链接"）。
- 仍未做到：活动栏彩色 logo（§19.3 三条独立理由）、状态栏 logo、"初始化当前目录"（上游无 `init`）。

## 21. round 8：仓库工程化四项——l10n 命名 / 目录树收敛 / README 精简 / Open VSX

> 本轮全部是**分析与方案，未动任何代码**；核心点已单独输出给作者 review，批准后按 §21.5 拆任务。

### 21.1 "l10n 不是 i18n 吗？"——两个词都对，仓库里确实存在两层

名词本身：**i18n**（internationalization，国际化）＝把软件**改成能够适配多语言**的工程工作（外置字符串、
不写死格式）；**l10n**（localization，本地化）＝为**某个具体语言区域**完成翻译与适配。i18n 是前提，
l10n 是落地。仓库里两层各自叫各自的名字，不是混乱：

| 层 | 位置 | 是什么 | 为什么是两层 |
| --- | --- | --- | --- |
| 我们自己的运行时文案 | `src/i18n/`（`t`/`translate`）+ `data/i18n/zh-cn.json` | `t()` 运行时查表；`mcpp.ui.language` 切换**即时生效** | 面板与输出消息要求不重启换语言 |
| VS Code 平台 l10n | `l10n/bundle.l10n.json` + `bundle.l10n.zh-cn.json` | 命令标题、设置名等**清单文案**，`tools/generate-l10n.mjs` 从 `package.nls*` 生成 | VS Code **只在启动时解析一次**；`l10n/` 目录名是平台约定，不可改 |

结论：**不做重命名**（把 `src/i18n` 改名 `src/l10n` 既不符合平台语义又制造 churn），在
`docs/architecture.md` 的 Language 小节补一张同款两行表说明即可。

### 21.2 目录树收敛：三处真收益，两处明确不做

现状：`src/` 70 个文件按域分 11 个目录（cli 16 / views 8 / config 8 / library 7 / mcppls 7 / toml 7 /
buildscript 6 / projects 3 / util 3 / i18n 2 / commands 2 / workflows 1）+ 根 `extension.ts`。大结构
已经是按域分组，**不动**。根级的 `mcpp-vscode-0.6.0.vsix` 已被 `*.vsix` 忽略且未入库，不是问题。

真收益的三处：

1. **`docs/superpowers/` → `.agents/docs/superpowers/`**（7 份 2026-07~09 的历史实现 plan/spec）。
   `docs/` 是面向用户的目录；本仓库自己的约定是"分析报告与评审记录只保留 `.agents/docs`"
   （.gitignore 注释原文）。引用方只有 `.agents/docs` 内两份文档，`git mv` + 改两处链接。
2. **`images/`（仅 2 文件）并入 `media/`**。`images/` 只有 logo.png（`package.json` 的 `icon` +
   两份 README 头图）和 activity-bar.png（`generate-activitybar-icon.mjs` 的产物）；`media/` 已经
   是插件资产目录（三个 webview css + quick-menu/）。合并后根目录少一个，全仓库引用只有 4 处：
   `package.json`、README×2、该脚本的 SOURCE/TARGET；`check:icon` 门禁随之对齐。
3. **缓存 webview 换到与库视图同一副骨架**（`src/views/cachePanel*.ts` 共 4 个文件）。这不只是
   目录美学：上一轮综合 review 的 P2-2 正是"缓存视图缺 per-render nonce / `documentNeedsRender`
   渲染门禁"（cachePanel.ts:385 起），而 library 视图有整套。统一骨架＝目录上少一套平行实现、
   功能上顺手关掉 P2-2。属真正的重构，单独一个任务做。

明确不做的：合并 commands / workflows / util / projects 这类小目录（churn 大于收益）；
`data/i18n/` 与 `l10n/` 不互相搬移（§21.1 的平台约束）。

### 21.3 README 精简 + 相关项目表

两份 README（EN 121 行 / zh 120 行）结构对称。先修实错，再压结构。

实错（2026-10-03 核对；多为 EN 侧，zh 已修一半）：

- EN Quick start 仍写 "Project, Cache and C++ Modules"——0.6.0 是 工程 + 库生态 + 缓存（折叠），
  **Library 无踪影**（zh 版已是三视图表述）；
- Install 示例仍是 `mcpp-vscode-0.5.0.vsix`；
- 命令表里有已删除的 `mcpp.showCachePanel`（与综合 review 的 P3 清单同源）；
- "All 64 settings"——实测 `contributes.configuration.properties` 共 **69** 个。

结构（121 行 → 约 75 行，两份同步改）：

| 现有小节 | 处置 |
| --- | --- |
| Responsibility split 表 | 缩成一句"对 mcppls 只转发不重写"，细节归 docs/architecture.md |
| （新增）**相关项目表** | 见下；替代散在正文里的链接 |
| Install | 三渠道：Marketplace / Open VSX（发布后）/ GitHub Releases VSIX |
| Quick start | 三视图表述对齐 0.6.0，补 Library |
| Commands 表 / Settings 段 / Editing 段 | 并入 Features 七条 bullets（每条本就带 docs/ 链接） |
| Troubleshooting 五连链接 | 压成一行 + 链接 |

相关项目表（链接已于 2026-10-03 逐一验证可达）：

| 项目 | 仓库 | 市场 |
| --- | --- | --- |
| mcpp（C++23 构建工具，本插件的 CLI 后端） | github.com/mcpp-community/mcpp | — |
| mcpp-language-server（C++ Modules 语言服务，本插件强依赖） | github.com/Sunrisepeak/mcpp-language-server | Marketplace · Open VSX（0.0.9） |
| mcpp-vscode（本插件） | github.com/mcpp-community/mcpp-vscode | Marketplace（0.4.0）· Open VSX（待发布）· Releases |

### 21.4 Open VSX 支持

三个已验证的事实（2026-10-03）：

1. **依赖已就位**：`sunrisepeak.mcpp-language-server` **已在 Open VSX**，0.0.9，2026-10-01 更新，
   publisher 已认证。`extensionDependencies` 在 Open VSX 侧可以解析——这是此前最大的不确定项。
2. **本插件不在 Open VSX**（API 404）；MS Marketplace 停在 **0.4.0**（37 安装），0.5/0.6 一直走
   GitHub Releases VSIX——即**两个市场都没有发布流水线**，`release.yml` 目前只做 GitHub Release。
3. 兼容性无坑：engines `^1.91.0` 对 VSCodium 同样成立（同一 OSS 基座，`vscode.l10n` 可用）；
   repository / icon / LICENSE（Apache-2.0）字段齐全；`ovsx` 可直接发布 vsce 打好的**同一只
   VSIX**，不需要第二套打包。

提案（扩展现有 `.github/workflows/release.yml`，不新建工作流）：

- tag 校验、测试、打包、体积/内容门禁**全部照旧**；在 GitHub Release 创建之后追加
  `npx ovsx publish "mcpp-vscode-${PACKAGE_VERSION}.vsix" -p "$OVSX_PAT"`。secrets 缺失时**显式
  失败**并说明去哪建 Eclipse OAuth token——发布 tag 是郑重动作，静默跳过等于假发布。
- 可选：同流水线发 MS Marketplace（`VSCE_PAT`）。0.4.0 已在架，0.6.0 单调递增合法。
- 首次发布前的一次性人工动作：建 Eclipse OAuth token、确认 `mcpp-community` namespace 归属
  （Open VSX 首发自动认领，除非已被占用）。
- 回归锁（本仓库惯例——门禁本身要有测试）：`artifacts.test.ts` 断言 release.yml 含 ovsx publish
  步骤，防止将来重构工作流时无声丢掉发布。
- README：Install 三渠道 + §21.3 相关项目表各补 Open VSX。

不做：CI 加 Open VSX 安装冒烟（与 isolated-install 三平台作业重复，VSIX 同源，增量信息≈0）；
`package.json` 加 Open VSX 专用字段（不存在这种必要）。

### 21.5 需要你定的

1. **发布流水线范围**：只 Open VSX，还是 Open VSX + MS Marketplace 一步到位？（推荐后者，
   同一只 VSIX 顺手的事；不想自动发 Marketplace 就维持手动。）
2. **`images/` 并入 `media/`**：做/不做？（推荐做，引用仅 4 处。）
3. **缓存 webview 骨架统一**（连带关掉 P2-2）：纳入本轮，还是与 P1"已添加"数据链一起排 0.6.x？
