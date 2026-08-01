# Tag Release 工作流实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 推送与扩展版本匹配的 Git tag 后，自动验证、打包并在 GitHub Releases 发布 VSIX 和 SHA-256 校验文件。

**Architecture:** 新增独立的 tag 触发 GitHub Actions 工作流。工作流读取 `package.json` 的版本并拒绝不匹配的 tag，在测试和打包成功后使用 `gh release` 创建或更新 Release；仓库测试通过检查工作流文本中的关键契约，避免发布链路被静默删改。

**Tech Stack:** GitHub Actions、Node.js/npm、VSCE、GitHub CLI、Node 内置测试框架。

---

### Task 1: 定义 tag Release 工作流契约

**Files:**
- Modify: `test/artifacts.test.ts`
- Create: `.github/workflows/release.yml`

- [x] **Step 1: 写入失败的发布工作流契约测试**

在 `test/artifacts.test.ts` 末尾添加：

```ts
test("tag release 工作流校验版本并发布 VSIX", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- "v\*"/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run package/);
  assert.match(workflow, /GITHUB_REF_NAME.*v\$\{PACKAGE_VERSION\}/s);
  assert.match(workflow, /sha256sum/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release upload.*--clobber/s);
});
```

- [x] **Step 2: 运行测试确认失败**

运行：

```bash
npm test -- --test-name-pattern='tag release 工作流校验版本并发布 VSIX'
```

预期：失败，原因是 `.github/workflows/release.yml` 尚不存在。

- [x] **Step 3: 创建最小发布工作流**

创建 `.github/workflows/release.yml`，内容如下：

```yaml
name: 发布 VSIX

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: 检出 tag
        uses: actions/checkout@v4

      - name: 配置 Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: 安装依赖
        run: npm ci

      - name: 校验 tag 与扩展版本
        shell: bash
        run: |
          PACKAGE_VERSION="$(node -p 'require("./package.json").version')"
          if [[ "$GITHUB_REF_NAME" != "v${PACKAGE_VERSION}" ]]; then
            echo "tag $GITHUB_REF_NAME 与 package.json 版本 $PACKAGE_VERSION 不一致。"
            exit 1
          fi
          echo "PACKAGE_VERSION=$PACKAGE_VERSION" >> "$GITHUB_ENV"

      - name: 运行测试
        run: npm test

      - name: 打包 VSIX
        run: npm run package

      - name: 生成 SHA-256 校验文件
        shell: bash
        run: sha256sum "mcpp-vscode-${PACKAGE_VERSION}.vsix" > "mcpp-vscode-${PACKAGE_VERSION}.vsix.sha256"

      - name: 创建或更新 GitHub Release
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          VSIX="mcpp-vscode-${PACKAGE_VERSION}.vsix"
          CHECKSUM="${VSIX}.sha256"
          if gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1; then
            gh release upload "$GITHUB_REF_NAME" "$VSIX" "$CHECKSUM" --clobber
          else
            gh release create "$GITHUB_REF_NAME" "$VSIX" "$CHECKSUM" \
              --title "mcpp-vscode ${PACKAGE_VERSION}" \
              --generate-notes
          fi
```

- [x] **Step 4: 运行目标测试确认转绿**

运行：

```bash
npm test -- --test-name-pattern='tag release 工作流校验版本并发布 VSIX'
```

预期：测试通过，工作流具备 tag 触发、版本校验、测试、打包、校验文件与可重跑发布步骤。

### Task 2: 验证并提交当前修复与发布链路

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/cliController.ts`
- Modify: `test/artifacts.test.ts`
- Create: `.github/workflows/release.yml`

- [x] **Step 1: 运行完整测试**

运行：

```bash
npm test
```

预期：所有测试通过，包括项目锁释放和 tag release 工作流契约测试。

- [x] **Step 2: 打包并检查 VSIX**

运行：

```bash
npm run package
unzip -t mcpp-vscode-0.2.1.vsix
unzip -p mcpp-vscode-0.2.1.vsix extension/package.json
```

预期：打包成功，压缩包无错误，清单版本为 `0.2.1` 且包含 `images/logo.png`。

- [x] **Step 3: 检查差异与暂存范围**

运行：

```bash
git diff --check
git add CHANGELOG.md README.md package.json package-lock.json src/cliController.ts test/artifacts.test.ts .github/workflows/release.yml
git diff --cached --check
git diff --cached --stat
```

预期：仅暂存 CLI 锁修复、`0.2.1` 发布记录、工作流和对应测试；不暂存现有
`docs/superpowers` 用户改动。

- [x] **Step 4: 提交实现**

运行：

```bash
git commit -m "fix: release project lock before IDE reconciliation"
```

预期：提交作者为 `wellwei <ywellwei@outlook.com>`，发布工作流等待维护者推送
`v0.2.1` tag 后在 GitHub Actions 中进行真实验证。
