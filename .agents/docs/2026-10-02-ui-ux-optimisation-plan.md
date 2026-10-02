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
- `test/architecture.test.ts` 补上库生态的 4 个纯模块（`indexModel` / `xpkg` / `libraryHtml` /
  `detailHtml`），让"纯模块不得依赖 vscode"这条覆盖到新代码。
