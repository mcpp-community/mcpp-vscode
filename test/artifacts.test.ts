import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

interface PackageManifest {
  version?: string;
  icon?: string;
  repository?: { url?: string };
  homepage?: string;
  bugs?: { url?: string };
  extensionDependencies?: string[];
  activationEvents?: string[];
  capabilities?: { untrustedWorkspaces?: { supported?: string; description?: string } };
  contributes?: {
    commands?: Array<{ command: string }>;
    configuration?: { properties?: Record<string, unknown> };
    configurationDefaults?: Record<string, unknown>;
    grammars?: Array<{ scopeName: string; injectTo?: string[]; path: string }>;
  };
}

const root = path.resolve(process.cwd());

test("declares the official clangd dependency and mcpp commands", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  assert.equal(manifest.version, "0.2.1");
  assert.ok(manifest.extensionDependencies?.includes("llvm-vs-code-extensions.vscode-clangd"));
  assert.ok(manifest.activationEvents?.includes("workspaceContains:mcpp.toml"));
  assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, "limited");
  assert.equal(
    manifest.capabilities?.untrustedWorkspaces?.description,
    "未受信任工作区仅启用模块语法高亮，不执行 CDB、mcpp 或 clangd 指定的任何程序，也不接管 clangd 配置。",
  );
  assert.deepEqual(
    manifest.contributes?.commands?.map((command) => command.command),
    [
      "mcpp.showMenu",
      "mcpp.build",
      "mcpp.run",
      "mcpp.test",
      "mcpp.clean",
      "mcpp.showToolchains",
      "mcpp.installToolchain",
      "mcpp.selectDefaultToolchain",
      "mcpp.configureClangd",
      "mcpp.refreshCompilationDatabase",
      "mcpp.checkModuleSupport",
    ],
  );
  assert.ok(manifest.contributes?.configuration?.properties?.["mcpp.path"]);
  assert.ok(manifest.contributes?.configuration?.properties?.["mcpp.modulesSupport"]);
  assert.deepEqual(manifest.contributes?.configurationDefaults?.["files.associations"], {
    "*.ccm": "cpp",
    "*.cppm": "cpp",
    "*.ixx": "cpp",
    "*.mpp": "cpp",
  });
});

test("ships an injection grammar with module-specific scopes", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  const grammar = manifest.contributes?.grammars?.find((item) => item.scopeName === "source.cpp.mcpp-modules");
  assert.deepEqual(grammar, {
    scopeName: "source.cpp.mcpp-modules",
    injectTo: ["source.cpp"],
    path: "./syntaxes/mcpp-modules.tmLanguage.json",
  });

  const grammarText = readFileSync(path.join(root, "syntaxes/mcpp-modules.tmLanguage.json"), "utf8");
  const grammarDocument = JSON.parse(grammarText) as { repository?: Record<string, unknown> };
  for (const key of ["module-declaration", "import-declaration", "module-name"]) {
    assert.ok(grammarDocument.repository?.[key], `missing grammar rule: ${key}`);
  }
  const importRule = grammarDocument.repository?.["import-declaration"] as { match?: string };
  assert.ok(importRule.match?.includes("(?:\\.[A-Za-z_][A-Za-z0-9_]*)*"));
  assert.ok(importRule.match?.includes("(?:\\s*;)?"));
  assert.ok(!importRule.match?.includes("(?=;)"));

  const javascriptPattern = (importRule.match ?? "").replace(/^\(\?x\)/, "");
  const importPattern = new RegExp(javascriptPattern);
  assert.match("import xxx", importPattern);
  assert.match("export import foo.bar;", importPattern);
});

test("设置全局默认后先释放工具链锁再提供立即构建", () => {
  const source = readFileSync(path.join(root, "src/cliController.ts"), "utf8");
  const start = source.indexOf("private async selectDefaultToolchainFromInventory");
  const end = source.indexOf("private async pickInstallSpec", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const method = source.slice(start, end);
  const unlock = method.indexOf("this.operations.finishGlobal(token)");
  const immediateBuild = method.indexOf("const buildChoice");
  assert.ok(unlock >= 0 && unlock < immediateBuild);
});

test("项目任务结束后先释放项目锁再重新协调 IDE", () => {
  const source = readFileSync(path.join(root, "src/cliController.ts"), "utf8");
  const start = source.indexOf("public async runProjectTask");
  const end = source.indexOf("public async showToolchains", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const method = source.slice(start, end);
  const unlock = method.indexOf("this.operations.finishProject(project.root, token)");
  const reconcile = method.indexOf("this.options.afterProjectTask(project, kind, completion)");
  assert.ok(unlock >= 0 && unlock < reconcile);
});

test("安装流程把系统工具链和 target 兼容 spec 交给 mcpp 解析", () => {
  const source = readFileSync(path.join(root, "src/cliController.ts"), "utf8");
  const start = source.indexOf("public async installToolchain");
  const end = source.indexOf("public async selectDefaultToolchain", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const method = source.slice(start, end);
  assert.doesNotMatch(
    method,
    /if \(isMsvcToolchainSpec\(spec\) \|\| toolchainSpecTargetHint\(spec\) !== undefined\)/,
  );
  assert.match(method, /toolchainInstallKind\(spec\)/);
});

test("泛化 triple 工具链由 mcpp 最终校验", () => {
  const source = readFileSync(path.join(root, "src/cliController.ts"), "utf8");
  const start = source.indexOf("public async installToolchain");
  const end = source.indexOf("public async selectDefaultToolchain", start);
  const method = source.slice(start, end);

  assert.match(method, /可能携带 target 语义.*最终由 mcpp 校验/s);
});

test("声明 GitHub 仓库和扩展图标", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  assert.equal(manifest.icon, "images/logo.png");
  assert.equal(manifest.repository?.url, "https://github.com/wellwei/mcpp-vscode.git");
  assert.equal(manifest.homepage, "https://github.com/wellwei/mcpp-vscode#readme");
  assert.equal(manifest.bugs?.url, "https://github.com/wellwei/mcpp-vscode/issues");

  const icon = readFileSync(path.join(root, manifest.icon));
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("README 区分 mcpp 的 MSVC 构建能力和 clangd 的 IFC 限制", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /0\.0\.90 起 native `cl\.exe` 后端支持/);
  assert.match(readme, /mcpp 可以正常构建它们，但 clangd\s+不能直接消费/);
  assert.doesNotMatch(readme, /native MSVC\s+构建仍提示/);
});

test("嵌套工程提示不猜测它一定是 mcpp 工作区成员", () => {
  const source = readFileSync(path.join(root, "src/cliController.ts"), "utf8");
  assert.doesNotMatch(source, /isWorkspaceMember/);
  assert.doesNotMatch(source, /当前是工作区成员/);
});

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
