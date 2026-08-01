# mcpp VS Code tag Release 设计

## 目标

为 `mcpp-vscode` 增加基于 GitHub tag 的自动 Release。维护者推送与扩展版本一致的
`v<version>` tag 后，仓库自动验证、测试、打包并发布可安装的 VSIX，避免手工打包和
上传造成版本漂移。

## 范围

- 触发方式：推送匹配 `v*` 的 tag，例如 `v0.2.1`。
- 发布平台：GitHub Releases。
- Release 资产：`mcpp-vscode-<version>.vsix` 和对应的 SHA-256 校验文件。
- 不包含 VS Marketplace 发布；Marketplace 使用独立凭据和审批流程，留待后续设计。

## 工作流

`.github/workflows/release.yml` 使用 GitHub 托管的 Ubuntu runner 和仓库内置
`GITHUB_TOKEN`，执行以下步骤：

1. 检出 tag 对应的提交并安装仓库锁定的 npm 依赖。
2. 读取 `package.json` 版本，要求 tag 精确等于 `v<package.json.version>`。
3. 执行完整 `npm test`，再执行 `npm run package` 生成 VSIX。
4. 为 VSIX 生成 SHA-256 校验文件。
5. 若 tag 尚无 Release，则创建 Release 并生成 GitHub 自动说明；若 Release 已存在，
   则覆盖上传同名资产，支持失败后重新运行工作流。

工作流声明 `contents: write`，只使用必要的发布权限。版本不匹配、测试失败或打包
失败时工作流直接失败，不创建或更新 Release 资产。

## 验证

扩展测试增加工作流契约测试，检查 tag 触发器、版本校验、测试、打包、校验文件和
`gh release` 发布步骤仍存在。发布前本地仍运行完整测试、VSIX 打包和 `unzip -t`；
真实 GitHub Release 由推送 tag 后的 Actions 运行结果验证。
