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
    commands?: Array<{ command: string; icon?: string }>;
    menus?: { "editor/title"?: Array<{ command: string; group?: string; when?: string }> };
    configuration?: { properties?: Record<string, unknown> };
    configurationDefaults?: Record<string, unknown>;
    languages?: Array<{ id: string; aliases?: string[]; filenames?: string[]; configuration?: string }>;
    grammars?: Array<{ language?: string; scopeName: string; injectTo?: string[]; path: string }>;
  };
}

const root = path.resolve(process.cwd());

test("declares the official clangd dependency and mcpp commands", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  assert.equal(manifest.version, "0.2.7");
  assert.ok(manifest.extensionDependencies?.includes("llvm-vs-code-extensions.vscode-clangd"));
  assert.ok(manifest.activationEvents?.includes("workspaceContains:mcpp.toml"));
  assert.ok(manifest.activationEvents?.includes("onCommand:mcpp.run"));
  assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, "limited");
  assert.equal(
    manifest.capabilities?.untrustedWorkspaces?.description,
    "未受信任工作区仅启用模块语法高亮与 mcpp.toml 结构补全（纯文本分析），不执行 CDB、mcpp 或 clangd 指定的任何程序，也不接管 clangd 配置。",
  );
  assert.deepEqual(
    manifest.contributes?.commands?.map((command) => command.command),
    [
      "mcpp.showMenu",
      "mcpp.newProject",
      "mcpp.build",
      "mcpp.run",
      "mcpp.test",
      "mcpp.clean",
      "mcpp.showToolchains",
      "mcpp.installToolchain",
      "mcpp.selectDefaultToolchain",
      "mcpp.configureIde",
      "mcpp.configureClangd",
      "mcpp.refreshCompilationDatabase",
      "mcpp.checkModuleSupport",
      "mcpp.autoConfigureModules",
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

test("自动模块配置使用非交互复合操作和单一全局锁", () => {
  const source = readFileSync(path.join(root, "src/cliController.ts"), "utf8");
  assert.match(source, /public async readToolchainInventory\s*\(/);
  const start = source.indexOf("public async runAutomaticModuleSetup");
  assert.notEqual(start, -1);
  const end = source.indexOf("public async ", start + 10);
  const method = source.slice(start, end === -1 ? source.length : end);
  assert.match(method, /mcppModuleSetupCommands\(plan\)/);
  assert.match(method, /beginGlobal\(token\)/);
  assert.match(method, /finally\s*\{[\s\S]*finishGlobal\(token\)/);
  assert.doesNotMatch(method, /pickInstallSpec|selectDefaultToolchainFromInventory|showQuickPick|showWarningMessage/);
});

test("一键向导只有一次确认并在构建后重载上下文", () => {
  const source = readFileSync(path.join(root, "src/extension.ts"), "utf8");
  const start = source.indexOf("async function autoConfigureModulesWizard");
  const end = source.indexOf("export async function activate", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const wizard = source.slice(start, end);
  for (const expected of [
    "readToolchainInventory",
    "buildModuleSetupPlan",
    "moduleSetupConfirmation",
    "runAutomaticModuleSetup",
    "executeModuleSetup",
    "loadProjectContext",
  ]) {
    assert.match(wizard, new RegExp(expected));
  }
  assert.match(wizard, /modal:\s*true/);
  assert.match(wizard, /let currentContext/);
  assert.doesNotMatch(wizard, /CLI_COMMANDS\.(installToolchain|selectDefaultToolchain)/);
  assert.doesNotMatch(wizard, /刷新编译数据库|showQuickPick|showInputBox|maybeDisableCppTools/);
  assert.doesNotMatch(wizard, /configureClangd\([^\n]*"interactive"/);
});

test("shows editor title buttons only inside mcpp projects", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  assert.deepEqual(manifest.contributes?.menus?.["editor/title"], [
    { command: "mcpp.run", group: "navigation@1", when: "mcpp.inProject" },
    { command: "mcpp.test", group: "navigation@2", when: "mcpp.inProject" },
  ]);

  const commands = manifest.contributes?.commands ?? [];
  assert.equal(commands.find((command) => command.command === "mcpp.run")?.icon, "$(play)");
  assert.equal(commands.find((command) => command.command === "mcpp.test")?.icon, "$(beaker)");
  assert.ok(!commands.some((command) => command.command === "mcpp.inProject"));
});

test("wires IDE configure before clangd reconciliation", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  assert.ok(manifest.activationEvents?.includes("onCommand:mcpp.configureIde"));

  const source = readFileSync(path.join(root, "src/extension.ts"), "utf8");
  assert.match(source, /ensureIdeConfigured/);
  assert.match(source, /runIdeConfigure/);
  assert.match(source, /registerCommand\(COMMAND_IDE_CONFIGURE/);
});

test("ships syntax-only C++ highlighting for the exact build.mcpp filename", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  const associations = manifest.contributes?.configurationDefaults?.["files.associations"] as
    | Record<string, string>
    | undefined;
  const language = manifest.contributes?.languages?.find((item) => item.id === "mcpp-build");
  const grammar = manifest.contributes?.grammars?.find((item) => item.language === "mcpp-build");

  assert.equal(associations?.["build.mcpp"], undefined);
  assert.equal(associations?.["*.mcpp"], undefined);
  assert.deepEqual(language, {
    id: "mcpp-build",
    aliases: ["mcpp build script", "build.mcpp"],
    filenames: ["build.mcpp"],
    configuration: "./syntaxes/mcpp-build-language-configuration.json",
  });
  assert.deepEqual(grammar, {
    language: "mcpp-build",
    scopeName: "source.mcpp-build",
    path: "./syntaxes/mcpp-build.tmLanguage.json",
  });

  const grammarText = readFileSync(path.join(root, "syntaxes/mcpp-build.tmLanguage.json"), "utf8");
  const grammarDocument = JSON.parse(grammarText) as { patterns?: Array<{ include?: string }> };
  assert.ok(grammarDocument.patterns?.some((pattern) => pattern.include === "source.cpp"));
});

test("ships TOML highlighting for the exact mcpp.toml filename", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  const language = manifest.contributes?.languages?.find((item) => item.id === "mcpp-toml");
  assert.deepEqual(language, {
    id: "mcpp-toml",
    aliases: ["mcpp TOML", "mcpp.toml"],
    filenames: ["mcpp.toml"],
  });

  const grammar = manifest.contributes?.grammars?.find((item) => item.language === "mcpp-toml");
  assert.deepEqual(grammar, {
    language: "mcpp-toml",
    scopeName: "source.toml.mcpp",
    path: "./syntaxes/mcpp-toml.tmLanguage.json",
  });

  const grammarText = readFileSync(path.join(root, "syntaxes/mcpp-toml.tmLanguage.json"), "utf8");
  const grammarDocument = JSON.parse(grammarText) as {
    repository?: Record<string, { match?: string }>;
  };
  for (const key of ["comment", "table", "key", "string", "datetime", "number", "boolean", "punctuation"]) {
    assert.ok(grammarDocument.repository?.[key], `missing TOML grammar rule: ${key}`);
  }

  const tablePattern = new RegExp(grammarDocument.repository?.table.match ?? "");
  assert.match("[package]", tablePattern);
  assert.match("[[target.generated]]", tablePattern);

  const keyPattern = new RegExp(grammarDocument.repository?.key.match ?? "");
  assert.match('standard = "c++23"', keyPattern);
  assert.match('"quoted.key" = true', keyPattern);

  for (const scope of [
    "comment.line.number-sign.toml",
    "entity.name.section.toml",
    "variable.other.key.toml",
    "string.quoted.double.toml",
    "constant.numeric.toml",
    "constant.language.boolean.toml",
  ]) {
    assert.match(grammarText, new RegExp(scope.replaceAll(".", "\\.")));
  }
});

test("ships an injection grammar with module-specific scopes", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  const grammar = manifest.contributes?.grammars?.find((item) => item.scopeName === "source.cpp.mcpp-modules");
  assert.deepEqual(grammar, {
    scopeName: "source.cpp.mcpp-modules",
    injectTo: ["source.cpp", "source.mcpp-build"],
    path: "./syntaxes/mcpp-modules.tmLanguage.json",
  });

  const grammarText = readFileSync(path.join(root, "syntaxes/mcpp-modules.tmLanguage.json"), "utf8");
  const grammarDocument = JSON.parse(grammarText) as {
    injectionSelector?: string;
    repository?: Record<string, unknown>;
  };
  assert.match(grammarDocument.injectionSelector ?? "", /source\.mcpp-build/);
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

  const importRuleWithCaptures = importRule as {
    captures?: Record<string, { name?: string }>;
  };
  assert.equal(importRuleWithCaptures.captures?.["2"]?.name, "keyword.control.import.cpp");
  assert.match("import mcpp;", importPattern);
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

test("新建工程先校验目标路径再确认创建，成功后只打开不构建", () => {
  const source = readFileSync(path.join(root, "src/cliController.ts"), "utf8");
  const start = source.indexOf("public async newProject");
  const end = source.indexOf("private guarded", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  // 控制流本身由 test/newProject.test.ts 对 runNewProjectFlow 的行为级测试覆盖；
  // 这里只验证控制器把 UI/进程依赖注入流程函数。
  const method = source.slice(start, end);
  assert.match(method, /validateNewProjectName/);
  assert.match(method, /runNewProjectFlow/);
  const flow = method.indexOf("runNewProjectFlow");
  const exists = method.indexOf("existsSync", flow);
  const confirm = method.indexOf("showWarningMessage", flow);
  const create = method.indexOf("runProcess", flow);
  const open = method.indexOf('executeCommand("vscode.openFolder"', flow);
  assert.ok(exists >= 0 && exists < confirm);
  assert.ok(confirm >= 0 && confirm < create);
  assert.ok(create >= 0 && create < open);
});

test("新建工程契约是创建并打开，不自动构建", () => {
  const controller = readFileSync(path.join(root, "src/cliController.ts"), "utf8");
  const extension = readFileSync(path.join(root, "src/extension.ts"), "utf8");
  assert.doesNotMatch(controller, /globalState|PENDING_NEW_PROJECT/);
  assert.doesNotMatch(extension, /PENDING_NEW_PROJECT/);
});

test("声明 GitHub 仓库和扩展图标", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  assert.equal(manifest.icon, "images/logo.png");
  assert.equal(manifest.repository?.url, "https://github.com/mcpp-community/mcpp-vscode.git");
  assert.equal(manifest.homepage, "https://github.com/mcpp-community/mcpp-vscode#readme");
  assert.equal(manifest.bugs?.url, "https://github.com/mcpp-community/mcpp-vscode/issues");

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

test("PR CI 分离单元打包和 Extension Host E2E", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /concurrency:[\s\S]*cancel-in-progress: true/);
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /unit-and-package:/);
  assert.match(workflow, /extension-host-e2e:/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run package/);
  assert.match(workflow, /unzip -t/);
  assert.match(workflow, /xvfb-run -a npm run test:e2e/);
});
