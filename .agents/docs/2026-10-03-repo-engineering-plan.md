# 0.6.x 仓库工程化实施方案（round 8 落地版）

> 上游讨论在 `2026-10-02-ui-ux-optimisation-plan.md` §21（round 8，分析与决定）；本文是批准后的
> **实施设计**，落码前的最后一步。所有行号以 2026-10-03 的 `feat/plugin-optimisation-v0.5.0`
> （88bfc31）为准。**本文档本身未动任何产品代码。**

## 0. 范围与批准基线

| 任务 | 内容 | 批准依据 |
| --- | --- | --- |
| A | 发布流水线：Open VSX + MS Marketplace 一步到位 | §21.5-1，作者已确认 key 自己配 |
| B | `images/`（2 文件）并入 `media/` | §21.5-2 |
| C | README 精简 + 相关项目表 + 4 处实错；`docs/superpowers/` 移走；l10n/i18n 说明段 | §21.1/§21.3，原始诉求 3 |
| D | WebviewDocument：四个 webview 换同一副骨架（核心是缓存视图，P2-2） | §21.5-3 "纳入本轮" |

不在本轮：P1"详情页已添加数据链"（另案）、l10n 重命名（§21.1 明确不做）、合并小目录（§21.2 不做）。

---

## 1. 任务 A：发布流水线（Open VSX + MS Marketplace）

### A1 现状（含一个新查明的事实）

- `.github/workflows/release.yml` 只做：tag 校验 → 测试 → 打包 → 体积/内容门禁 → SHA-256 →
  GitHub Release。**没有任何市场发布步骤。**
- **新查明**：`git tag -l` 最新是 `v0.4.0`，`gh release list` 同——**0.5.0/0.6.0 从未发过版**，
  Marketplace 的 0.4.0（37 安装）就是两个市场上的最新。所以只要流水线赶在打 tag 之前落地，
  **v0.6.0 就是第一个双市场自动发布的版本**（Marketplace 从 0.4.0 直接跳 0.6.0，单调合法，
  CHANGELOG 已覆盖中间版本）。
- Open VSX 侧依赖已就位（§21.4）：`sunrisepeak.mcpp-language-server` 0.0.9 在架且已认证，
  `extensionDependencies` 可解析；本插件 Open VSX API 404。

### A2 `release.yml` 改动（在"创建或更新 GitHub Release"之后追加）

```yaml
- name: 发布到 Open VSX
  shell: bash
  env:
    OVSX_PAT: ${{ secrets.OVSX_PAT }}
  run: |
    set -euo pipefail
    if [ -z "${OVSX_PAT:-}" ]; then
      echo "缺少 OVSX_PAT。到 open-vsx.org → 用户设置 → Access Tokens 建 publish 作用域 token，"
      echo "然后在本仓库 Settings → Secrets → Actions 里配置 OVSX_PAT。"
      exit 1
    fi
    npx ovsx publish "mcpp-vscode-${PACKAGE_VERSION}.vsix"

- name: 发布到 Visual Studio Marketplace
  shell: bash
  env:
    VSCE_PAT: ${{ secrets.VSCE_PAT }}
  run: |
    set -euo pipefail
    if [ -z "${VSCE_PAT:-}" ]; then
      echo "缺少 VSCE_PAT。到 dev.azure.com 建 Personal Access Token"
      echo "（Organization: 所有可访问组织，Scopes: Marketplace → Manage），配到仓库 secrets。"
      exit 1
    fi
    npx vsce publish --packagePath "mcpp-vscode-${PACKAGE_VERSION}.vsix"
```

要点：

- **同一只 VSIX 发两个市场**（`ovsx publish <file>` 直接收文件；`vsce publish --packagePath` 收
  已打包文件），不重新打包——发布产物 = GitHub Release 产物，逐字节一致，SHA-256 对得上。
- secrets 缺失**显式失败**并写明去哪建 token（§21.4 的决定：发布 tag 是郑重动作，不静默跳过）。
- 发布顺序放在 GitHub Release **之后**：市场侧失败时 Release（事实上的源）已就位，重试只补市场。
- `ovsx` 加入 devDependencies 并锁定版本：`npx` 不应在发布中途去网络解析。`@vscode/vsce` 已在。

### A3 一次性人工步骤（作者操作）

1. open-vsx.org 注册/登录（Eclipse 账号）→ Settings → Access Tokens → 新建（publish 作用域）→
   配成仓库 secret `OVSX_PAT`。
2. dev.azure.com → Personal Access Tokens → 新建（Organization: 所有可访问组织；Scopes:
   Marketplace → Manage）→ 配成 secret `VSCE_PAT`。
3. 首次 `ovsx publish` 会自动认领 `mcpp-community` namespace（除非已被占用；发布前可在
   open-vsx.org 搜一下该 namespace 是否已存在他人名下）。

### A4 回归锁（本仓库惯例：门禁本身要有测试）

`test/artifacts.test.ts` 追加对 release.yml 的断言：

- 含 `ovsx publish` 与 `vsce publish --packagePath` 两个步骤，且各自引用 `secrets.OVSX_PAT` /
  `secrets.VSCE_PAT`——将来重构工作流时不能无声丢掉发布；
- `package.json` devDependencies 含 `ovsx`——`npx` 永远离线可用。

### A5 验收

- 干跑：不打 tag，本地按 release.yml 步骤顺序执行到打包（发布步不执行）；
- 真跑：PR 合并后打 `v0.6.0` tag → Release 出现、两个市场各多一个 0.6.0、Open VSX 依赖解析正常
  （在 VSCodium 里装一次即可验证 `extensionDependencies`）。

---

## 2. 任务 B：`images/` 并入 `media/`

全仓库引用恰好 4 处（2026-10-03 grep 复核）：

| 引用点 | 现值 | 改为 |
| --- | --- | --- |
| `package.json` `icon` | `images/logo.png` | `media/logo.png` |
| `README.md:2` 头图 | `images/logo.png` | `media/logo.png` |
| `README.zh-CN.md:2` 头图 | `images/logo.png` | `media/logo.png` |
| `tools/generate-activitybar-icon.mjs:39-40` SOURCE/TARGET | `images/` | `media/`（注释第 3 行同步） |

`git mv images/logo.png media/ && git mv images/activity-bar.png media/`，目录删除；
`.vscodeignore` 两边都不引用 `images/`，无需改；`check:icon` 门禁跑生成的脚本，路径改完自然对齐。
一个 commit，纯机械。

---

## 3. 任务 C：README 精简 + 相关项目表 + 零散文档工程

### C1 README 实错（EN 为主，两份一起修）

| 错 | 位置 | 改为 |
| --- | --- | --- |
| Quick start 写 "Project, Cache and C++ Modules"，无 Library | README.md:47 | 工程 + 库生态 + 缓存（折叠）三视图，与 zh 版对齐 |
| Install 示例 `mcpp-vscode-0.5.0.vsix` | README.md:32 | 去掉具体版本号（写 `<version>`，避免每次发版再烂） |
| 命令表含已删除的 `mcpp.showCachePanel` | README.md:72 | 表整体删除（见 C2），错误随之消失 |
| "All 64 settings" | README.md:77 | 69（实测 `contributes.configuration.properties` 计数；改成"不写死数字"的表述更稳） |

### C2 README 结构（121 行 → 约 75 行，两份同步）

| 现有小节 | 处置 |
| --- | --- |
| Responsibility split 表 | 缩成一句"对 mcppls 只转发不重写" |
| （新增）**相关项目表** | 见下 |
| Install | 三渠道：Marketplace / Open VSX / GitHub Releases VSIX（任务 A 后前两个可用） |
| Quick start | 三视图 + Library |
| Commands 表 / Settings 段 / Editing 段 | 并入 Features 七条 bullets |
| Troubleshooting 五连链接 | 一行 + 一个链接 |

相关项目表（链接 2026-10-03 已验证；Open VSX 列在首发后生效）：

| 项目 | 仓库 | 市场 |
| --- | --- | --- |
| mcpp | github.com/mcpp-community/mcpp | — |
| mcpp-language-server | github.com/Sunrisepeak/mcpp-language-server | Marketplace · Open VSX |
| mcpp-vscode（本插件） | github.com/mcpp-community/mcpp-vscode | Marketplace · Open VSX · Releases |

### C3 其余两件（§21.1/§21.2 的收尾）

- `docs/superpowers/`（7 份历史 plan/spec）→ `.agents/docs/superpowers/`：git mv + 修
  `.agents/docs/2026-10-02-plugin-optimisation-plan.md` 与 `.agents/docs/README.md` 两处引用。
- `docs/architecture.md` Language 小节补 §21.1 那张两层表（`src/i18n`+`data/i18n` 与 `l10n/`
  各管什么、为何不合并）。

---

## 4. 任务 D：WebviewDocument——四个 webview 一副骨架（核心）

### D1 现状证据（2026-10-03，逐文件）

| webview 宿主 | nonce | 赋值 | 变化才重绘 | 风险 |
| --- | --- | --- | --- | --- |
| `src/library/libraryView.ts`（侧边栏） | **每视图**（:139 `private readonly nonce`） | :373 | **有**（:369 `documentNeedsRender` + `this.document` 缓存，resolve/dispose 双清 :156/:170） | 无——这是已证明的模式 |
| `src/views/cachePanel.ts`（侧边栏） | **每次渲染**（:385） | :229 无条件 | 无 | 刷新即整页重载：预算输入与滚动位置丢失；若未来客户端加"加载即上报"，就是 library 踩过的死循环（见 D2） |
| `src/config/panel.ts`（设置面板） | **每次渲染**（:397） | :113 无条件 | 无 | 同上；它监听 `onDidChange`（:85），写设置→事件→重渲染→重载，输入焦点丢失 |
| `src/library/detailPanel.ts`（详情页） | **每次渲染**（:233） | :231 无条件 | 无（§20 已让 add 成功后不重建，渲染点少） | 最低，但模式不一致 |

### D2 库视图已证明的模式（也是这套 API 的出处）

`libraryHtml.ts:127-137` 的注释记录了事故史：文档加 `ready` 上报 + 宿主重渲染 + **每次渲染新
nonce** ⇒ 页面永远不等于上一版 ⇒ 无限重载（闪烁、行点不了、CPU 打满）。修法两条腿：**去掉
ready**（门禁锁死，artifacts.test.ts:205-219）+ **per-view nonce 与变化才赋值**。缓存/设置/
详情三个宿主今天没有 `ready`，但每渲染新 nonce + 无条件赋值的另一半还留着——同一个坑的另一半
没填。

### D3 kit 设计（新模块 `src/webview/document.ts`）

```ts
export interface WebviewAssets { cspSource: string; nonce: string; styleUri: string; }

export function documentNeedsRender(rendered: string | undefined, next: string): boolean;  // 从 libraryHtml.ts 原样搬来（就是 !==，注释保留）

/** 一个 webview 文档：每视图一个 CSP nonce + 只在文档变化时赋值。 */
export class WebviewDocument {
  private readonly nonce = randomBytes(16).toString("base64");
  private current: string | undefined;
  constructor(stylesheet: string) {}
  /** resolve/dispose 时调用：新 webview 是空的，比较基准归零。 */
  invalidate(): void;
  assets(context: vscode.ExtensionContext, webview: vscode.Webview): WebviewAssets;
  /** 文档没变就不赋值——赋值即重载，会丢输入焦点与滚动位置。 */
  paint(webview: vscode.Webview, html: string): void;
}
```

- `assets()` 固定从 `media/` 取样式表（四个宿主今天都用 media/，任务 B 之后更是如此）。
- `paint()` 接收**最终 html**（nonce/styleUri 已嵌入），比较后才赋值——与 libraryView.paint
  现有顺序一致。
- `WebviewView` 与 `WebviewPanel` 共用 `vscode.Webview` 基类，一个 kit 通吃。
- 该模块 import vscode，**不进** architecture.test.ts 的 PURE_MODULES；`documentNeedsRender`
  保持纯函数签名，单测直接测。

### D4 迁移映射（每文件改什么）

| 文件 | 改动 |
| --- | --- |
| `libraryView.ts` | 删 `nonce`/`document` 字段与 `randomNonce()`（:139/:465-467），换 `private readonly kit = new WebviewDocument("library.css")`；`paint()` 用 `kit.assets()` + `kit.paint()`；resolve/dispose 的两处 `this.document = undefined` → `kit.invalidate()`。行为零变化 |
| `cachePanel.ts` | 删 `assets()` 里的 randomBytes（:385）与 :229 的裸赋值；`render()` 末尾换 `kit.assets()` + `kit.paint()`；resolve（:147 起）与 onDidDispose（:153）加 `kit.invalidate()`。`CachePanelDeps`/`CachePanelProvider` 公开接口不动，`cacheView.ts` 零改动 |
| `config/panel.ts` | :397 的 randomBytes、:113 的裸赋值换 kit；panel dispose 时 `invalidate()` |
| `detailPanel.ts` | :233 的 randomBytes、:231 的裸赋值换 kit（顺带获得"同模型不重载"） |
| `libraryHtml.ts` | 删 `documentNeedsRender` 导出（搬去 kit），更新文件头注释出处 |
| `test/library/libraryHtml.test.ts` | `documentNeedsRender` 三条断言（:246-248）改从 kit 导入 |
| `test/artifacts.test.ts` | 见 D5 |

### D5 门禁改写与新增单测

`test/artifacts.test.ts:214-219` 现在锁的是 libraryView 的**实现细节**（`private readonly nonce =
randomNonce();`）——kit 抽取后必然失效，改写为锁**不变量**：

1. `src/` 全树 `randomBytes` 只允许出现在 `src/webview/document.ts`（nonce 全仓库一个铸造点）；
2. 四个宿主文件都 import `WebviewDocument`，且不再出现 `webview.html =` / `panel.webview.html =`
   裸赋值（赋值只许 kit 干）；
3. library 的 no-`ready` 三条（:211-213）原样保留。

新增 `test/webview/document.test.ts`（fake webview 计数赋值次数）：

- 同一 html 连 paint 两次只赋值一次；invalidate 后再 paint 必赋值；
- `assets()` 多次调用 nonce 不变（per-view 语义，正是 library 当年死循环的根因锁）；
- `documentNeedsRender` 的三条语义从 libraryHtml.test.ts 原样搬过来。

**行为可见收益**（也是验收项）：缓存视图开着自动刷新（或动作后刷新）而数据未变时，页面不再
整页重载——预算输入框里用户敲到一半的数字、滚动位置都保留；设置面板写设置触发的重渲染同理。

### D6 两个范围决策点（见 §7）

- **config/detail 一并迁移**：批准口径是"缓存 webview"，但 kit 抽出后这两处是各 ~3 行的顺路
  改动，且关掉同一类隐患。推荐做（独立 commit，可单独 revert）。
- **cache 四文件移入 `src/cache/`**（views/ 只剩工程树，与 library/config 对称）：纯机械移动，
  但要同步 architecture.test.ts 的 PURE_MODULES 两条路径、`test/views/` 四个测试文件挪到
  `test/cache/`、artifacts 门禁里的路径。推荐做但**单独一个 commit**，不与骨架重构混在一个 diff。

---

## 5. 提交切分与验收总表

| # | commit | 验收 |
| --- | --- | --- |
| 1 | `build(release): 双市场发布——ovsx + vsce --packagePath，缺 secret 显式失败` | artifacts 新断言过；本地按 release.yml 顺序干跑到打包 |
| 2 | `chore: images/ 并入 media/（4 处引用对齐）` | `check:icon` 过；VSIX 里 icon 路径正确 |
| 3 | `docs: README 精简 + 相关项目表 + 4 处实错；superpowers 移至 .agents；l10n 两层说明` | 两份 README 同构、无死链；`docs/` 只剩用户文档 |
| 4 | `refactor(webview): 抽出 WebviewDocument，library 迁移，门禁改写为锁不变量` | 全量单测过；artifacts 新门禁过 |
| 5 | `fix(cache): 缓存视图换 WebviewDocument——刷新不再整页重载` | D5 行为验收（预算输入/滚动保留）；cacheView 零改动 |
| 6 | `refactor(config,library): 设置面板与详情页同用 WebviewDocument`（若批准） | 设置面板写设置不重载 |
| 7 | `chore: cache 四文件移入 src/cache/`（若批准） | PURE_MODULES/测试路径/门禁全对齐 |

每个 commit 独立可回滚；全部落地后跑一轮三平台 CI（11 项门禁全绿）再请作者验收。

## 6. 风险与不做的事

- 发布步失败不会回滚 GitHub Release（刻意的：市场可重试，Release 是源）；ovsx 首发可能因
  namespace 争议失败——A3 第 3 步先行排查。
- kit 抽取是行为保持的重构，唯一有意的行为变化就是 D5 末尾那条（不再整页重载）；若某个宿主
  依赖"每次重载"的隐含行为（目前没有发现），门禁与单测会先暴露。
- 不做：CI 加 Open VSX 安装冒烟（§21.4 已定，与 isolated-install 重复）；cache 客户端加
  `ready`（library 的教训，门禁锁死的就是它）。

## 7. 需要你定的

1. **config/detail 两处顺路迁移**（commit 6）：做/不做？（推荐做。）
2. **cache 移入 `src/cache/`**（commit 7）：做/不做？（推荐做，但可砍，不影响 D 的收益。）
3. **v0.6.0 是否等这套流水线一起发**：等（0.6.0 即首个双市场版本）还是先合先发、0.6.1 起自动
   双市场？（推荐等——工程化零风险、都在一个 PR 分支上。）
