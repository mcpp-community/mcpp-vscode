# Issue #7 PR CI 与 Extension Host E2E 设计

## 背景

仓库当前只有 `.github/workflows/release.yml`，仅在 `v*` tag push 时执行测试、打包和
Release 上传。普通 pull request 没有自动检查。现有 `npm test` 是 TypeScript 编译加
Node `node:test`，没有启动真实 VS Code Extension Host 的 E2E。

Issue #7 要求 PR 自动触发单元测试和 E2E，提前发现扩展打包、激活和 VS Code API
接线问题。

## 目标

- 对 pull request 自动运行编译、全部 Node 单元测试、VSIX 打包校验和 Extension Host
  smoke E2E。
- 对 `main` push 重跑相同检查，确保合并后的提交仍可复现。
- 单元/打包与 E2E 使用独立 job，失败来源清晰，可分别设为 required check。
- E2E 在干净 runner 上可重复，不依赖用户缓存或真实工具链下载。

## 非目标

- 不替代 tag release workflow。
- 不在每个 PR 下载 mcpp LLVM 工具链、xlings 包或真实 clangd。
- 不承诺 macOS/Windows 的真实语言服务集成覆盖；本次 smoke lane 使用 Linux。
- 不在 workflow 中自动修改依赖或执行 `npm audit fix`。

## Workflow

新增 `.github/workflows/ci.yml`：

- 触发：`pull_request` 和 `push` 到 `main`。
- 权限：`contents: read`。
- concurrency：同一 workflow/ref 只保留最新运行，PR 更新时取消旧任务。
- Node：与发布流程一致使用 Node.js 22 和 npm cache。

### `unit-and-package`

1. `actions/checkout@v4`
2. `actions/setup-node@v4`，Node 22，`cache: npm`
3. `npm ci`
4. `npm test`
5. `npm run package`
6. 校验只生成一个与 `package.json.version` 一致的 VSIX，并执行 ZIP 完整性检查

该 job 复用发布前的核心检查，但不创建 Release，也不需要写权限。

### `extension-host-e2e`

1. checkout、setup-node、`npm ci`
2. `npm run compile`
3. 通过 `xvfb-run -a npm run test:e2e` 启动 VS Code Extension Host

`@vscode/test-electron` 负责下载并启动稳定版 VS Code。首次实现固定 npm lockfile 中的
测试 runner 版本，不额外固定 VS Code patch；runner 下载失败应表现为明确的 job 失败。

## E2E 结构

### `test/e2e/runTest.ts`

Node 启动器解析扩展根目录、编译后的测试入口和 fixture workspace，调用
`@vscode/test-electron` 的 `runTests`。启动参数关闭更新和遥测，并使用隔离的临时
user-data/extensions 目录，防止本机配置污染。隔离 extensions 目录只放置测试 fixture
提供的 `llvm-vs-code-extensions.vscode-clangd` stub，满足被测扩展的 dependency，而不
从 Marketplace 下载真实 clangd 扩展。

### `test/e2e/suite/index.ts`

Extension Host 内的测试入口，负责发现和运行 smoke cases，并在失败时返回非零退出码。
测试框架只服务 Extension Host E2E；现有纯 Node 测试继续使用 `node:test`。

### `test/e2e/suite/extension.test.ts`

首批 smoke cases：

- 在包含 `mcpp.toml` 的 fixture 中找到并激活 `mcpp-community.mcpp-vscode`。
- 验证 `mcpp.autoConfigureModules`、`mcpp.build` 和其他 manifest 命令实际注册到 VS Code。
- 设置 workspace scoped `mcpp.path` 指向 fake CLI，执行一个无 modal 的项目命令，验证
  fake CLI 收到参数且扩展没有依赖开发机 PATH。
- 验证 mcpp 工程 context key 驱动的命令路径在 Extension Host 中可用。

### `test/e2e/fixtures/`

提供最小 `mcpp.toml`、源文件、可执行 fake mcpp 和 no-op clangd dependency stub。
fake CLI 只实现 smoke case 需要的参数，把 argv 写入 fixture 临时记录文件并返回确定
退出码；stub 只提供扩展 id 和 `clangd.restart` 命令。二者都不伪装真实编译、CDB 或
clangd 兼容性。

## npm Scripts 与依赖

- 增加 `test:e2e`，只运行 Extension Host 测试。
- 保留 `test` 的现有含义，避免本地每次单测都下载 VS Code。
- 增加 `test:all` 作为本地完整验证入口：`npm test && npm run test:e2e`。
- 开发依赖增加当前稳定的 `@vscode/test-electron` 及其测试 runner 所需的最小依赖；
  所有版本写入 `package-lock.json`。

## 稳定性与安全边界

- PR E2E 不访问真实 mcpp/xlings registry，不依赖缓存命中。
- fake CLI 的路径由测试显式设置，不修改用户级 VS Code 配置。
- fixture 和日志写入测试临时目录，测试结束后清理。
- CI 不接收 secrets，不运行来自 issue/PR 文本的 shell 内容。
- workflow shell 命令只处理仓库内固定路径和从 `package.json` 读取的版本。
- E2E 超时必须有限，Extension Host 退出失败不能被吞掉。

## 验收标准

- 新 PR 自动出现独立的 `unit-and-package` 与 `extension-host-e2e` checks。
- 任一单元测试、TypeScript 编译、VSIX 打包或 Extension Host smoke case 失败时 workflow
  返回失败。
- 本地 `npm test` 继续快速运行且不下载 VS Code。
- 本地 `npm run test:e2e` 可在支持的 macOS/Linux 图形或 Xvfb 环境复现。
- tag release workflow 保持原发布职责，不混入 PR 权限或 E2E 副作用。
