import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { contributedCommandIds } from "../src/commands/ids";

interface PackageManifest {
  version?: string;
  displayName?: string;
  description?: string;
  icon?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  repository?: { url?: string };
  homepage?: string;
  bugs?: { url?: string };
  engines?: { vscode?: string };
  extensionDependencies?: string[];
  activationEvents?: string[];
  capabilities?: { untrustedWorkspaces?: { supported?: string; description?: string } };
  contributes?: {
    commands?: Array<{ command: string; title?: string; category?: string; icon?: string }>;
    menus?: { "editor/title"?: Array<{ command: string; group?: string; when?: string }> };
    configuration?: { title?: string; properties?: Record<string, unknown> };
    configurationDefaults?: Record<string, unknown>;
    languages?: Array<{ id: string; aliases?: string[]; filenames?: string[]; configuration?: string }>;
    viewsContainers?: { activitybar?: Array<{ id: string; title?: string; icon?: string }> };
    views?: Record<
      string,
      Array<{ id: string; name?: string; description?: string; when?: string; type?: string; visibility?: string }>
    >;
    viewsWelcome?: Array<{ view: string; contents: string; when?: string }>;
    colors?: Array<{ id: string; description?: string }>;
    keybindings?: Array<{ command: string; key?: string; mac?: string; when?: string }>;
    grammars?: Array<{ language?: string; scopeName: string; injectTo?: string[]; path: string }>;
  };
}

const root = path.resolve(process.cwd());

test("declares mcpp-language-server as the C++ modules language service", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  // The version lives in three places; they must agree or a release tag is a lie.
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
    version?: string;
    packages?: Record<string, { version?: string }>;
  };
  assert.match(manifest.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages?.[""]?.version, manifest.version);
  // User-visible strings live in the nls bundle; the manifest only names them.
  assert.equal(manifest.description, "%description%");
  assert.equal(manifest.displayName, "%displayName%");
  assert.equal(manifest.engines?.vscode, "^1.91.0");
  assert.deepEqual(manifest.extensionDependencies, ["sunrisepeak.mcpp-language-server"]);
  assert.ok(!manifest.extensionDependencies?.includes("llvm-vs-code-extensions.vscode-clangd"));
  // Since VS Code 1.74 every contributes.commands entry implies its own
  // onCommand activation, so only the file- and folder-based triggers remain.
  assert.deepEqual(manifest.activationEvents, [
    "workspaceContains:mcpp.toml",
    "onLanguage:mcpp-toml",
    "onLanguage:mcpp-build",
  ]);
  assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, "limited");
  assert.equal(manifest.capabilities?.untrustedWorkspaces?.description, "%untrustedWorkspaces.description%");
  // Same set, not necessarily the same order: the manifest's order is the
  // palette's presentation order, which `ids.ts` has no business dictating.
  assert.deepEqual(
    (manifest.contributes?.commands?.map((command) => command.command) ?? []).slice().sort(),
    contributedCommandIds().slice().sort(),
  );
  assert.deepEqual(
    manifest.contributes?.viewsContainers?.activitybar?.map((container) => container.id),
    ["mcpp"],
  );
  assert.deepEqual(
    manifest.contributes?.views?.mcpp?.map((view) => view.id),
    ["mcpp.project", "mcpp.library", "mcpp.cache"],
  );
  assert.deepEqual(
    manifest.contributes?.colors?.map((color) => color.id),
    ["mcpp.cacheOkForeground", "mcpp.cacheStaleForeground"],
  );
  assert.ok(manifest.contributes?.configuration?.properties?.["mcpp.path"]);
  assert.ok(manifest.contributes?.configuration?.properties?.["mcpp.tomlCompletion"]);
  assert.equal(manifest.contributes?.configuration?.title, "%mcpp.configuration.title%");
  for (const command of manifest.contributes?.commands ?? []) {
    assert.match(command.title ?? "", /^%command\.[^%]+\.title%$/, `command ${command.command} title must be an nls key`);
    assert.equal(command.category, "%category%");
  }
  assert.equal(manifest.dependencies?.["vscode-languageclient"], undefined);
  assert.equal(manifest.devDependencies?.["vscode-languageclient"], undefined);
  assert.deepEqual(manifest.contributes?.configurationDefaults?.["files.associations"], {
    "*.ccm": "cpp",
    "*.cppm": "cpp",
    "*.ixx": "cpp",
    "*.mpp": "cpp",
  });
});

test("一键向导只执行普通 build 并在之后刷新 C++ 模块语言服务", () => {
  const controller = readFileSync(path.join(root, "src/cli/controller.ts"), "utf8");
  const source = readFileSync(path.join(root, "src/extension.ts"), "utf8");
  // Slice up to a marker that exists for its own sake, not as a test hook: the
  // wizard is the last function before `activate`.
  const start = source.indexOf("async function autoConfigureModulesWizard");
  const end = source.indexOf("export async function activate(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const wizard = source.slice(start, end);
  for (const expected of [
    "buildModuleSetupPlan",
    "moduleSetupConfirmation",
    "executeModuleSetup",
    'runProjectTask("build", { notify: false })',
    "refreshLanguageServerAfterBuild",
  ]) {
    assert.ok(wizard.includes(expected), `wizard missing ${expected}`);
  }
  assert.match(wizard, /modal:\s*true/);
  assert.doesNotMatch(wizard, /CLI_COMMANDS\.(installToolchain|selectDefaultToolchain)/);
  assert.doesNotMatch(wizard, /readToolchainInventory|runAutomaticModuleSetup|ensureClangd|loadProjectContext/);
  assert.doesNotMatch(controller, /runAutomaticModuleSetup|executeAutomaticModuleSetupCommand/);
});

test("the promised keybindings are contributed and scoped to a project", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  const bindings = manifest.contributes?.keybindings ?? [];
  assert.deepEqual(
    bindings.map((binding) => binding.command),
    ["mcpp.build", "mcpp.run", "mcpp.test", "mcpp.cleanProjectArtifacts", "mcpp.showMenu"],
  );
  for (const binding of bindings) {
    assert.match(binding.key ?? "", /^ctrl\+alt\+[a-z]$/);
    assert.match(binding.mac ?? "", /^cmd\+alt\+[a-z]$/);
    assert.equal(binding.when, "mcpp.inProject");
  }
});

test("each view is gated by its own visibility setting", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  // The master switch comes first, in negated form: with `mcpp.views.enabled` off
  // every view is hidden and VS Code drops the container from the activity bar.
  assert.deepEqual(manifest.contributes?.views?.mcpp?.map((view) => view.when), [
    "!mcpp.sidebarHidden && mcpp.views.project",
    "!mcpp.sidebarHidden && mcpp.views.library",
    "!mcpp.sidebarHidden && mcpp.views.cache",
  ]);
  assert.deepEqual(manifest.contributes?.views?.mcpp?.map((view) => view.type), [
    undefined,
    "webview",
    "webview",
  ]);
  // The cache view starts folded, so the sidebar opens on the library list; the
  // two above it start open. `visibility` is the only way a view can say this —
  // VS Code keeps whatever the user does to the header afterwards.
  assert.deepEqual(manifest.contributes?.views?.mcpp?.map((view) => view.visibility), [
    undefined,
    undefined,
    "collapsed",
  ]);
});

test("every webview view registers the provider that fills it", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  const webviews = (manifest.contributes?.views?.mcpp ?? []).filter((view) => view.type === "webview");
  assert.ok(webviews.length > 0, "this gate is pointless without a webview view");
  for (const view of webviews) {
    // The view id is declared once, in the module that owns the view (other
    // modules re-export the constant), and that module must also call
    // `registerWebviewViewProvider`. Without it VS Code never asks the view for
    // a document and every `refresh()` silently does nothing — which is exactly
    // the bug this test exists for: the library view declared its id, exported a
    // provider, wired its listeners, and never registered.
    const declaration = new RegExp(`export const \\w*_VIEW_ID = "${view.id}"`);
    const owners = sourceFiles().filter(([, text]) => declaration.test(text));
    assert.equal(owners.length, 1, `${view.id} must have exactly one declaring module, found ${owners.length}`);
    assert.ok(
      owners[0][1].includes("registerWebviewViewProvider("),
      `${owners[0][0]} declares ${view.id} but never calls registerWebviewViewProvider`,
    );
  }
});

test("the library view cannot reload itself in a loop", () => {
  const view = readFileSync(path.join(root, "src/library", "libraryView.ts"), "utf8");
  const html = readFileSync(path.join(root, "src/library", "libraryHtml.ts"), "utf8");
  // Assigning `webview.html` reloads the document. The library document used to
  // announce its own load with a `ready` message and the host answered it with a
  // repaint, so the view reloaded itself forever: flicker, rows that could not be
  // clicked, a pegged CPU. Both halves of that handshake are gone.
  assert.doesNotMatch(html, /post\(\{\s*type:\s*"ready"\s*\}\)/, "the document must not announce its own load");
  assert.doesNotMatch(view, /case "ready"/, "the host must not answer a load with a re-render");
  assert.doesNotMatch(html, /\| \{ type: "ready" \}/);
  // Two guards keep it shut: the comparison, and a nonce that is per *view* — a
  // nonce per render would make every render a different document, so the
  // comparison could never say "unchanged".
  assert.match(view, /if \(!documentNeedsRender\(this\.document, document\)\) \{/);
  assert.match(view, /private readonly nonce = randomNonce\(\);/);
  assert.doesNotMatch(view, /nonce: randomNonce\(\)/);
  // A freshly resolved view is a new, empty webview: the last document says
  // nothing about it, so it must be forgotten when the old view goes away.
  assert.match(view, /this\.document = undefined;/);
});

/** `src/**\/*.ts`, relative path and text, for the source-level gates. */
function sourceFiles(directory = path.join(root, "src")): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push([path.relative(root, full), readFileSync(full, "utf8")]);
    }
  }
  return out;
}

test("shows editor title buttons only inside mcpp projects", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  // Both conditions matter: a project must be open, and the user must not have
  // turned the buttons off with `mcpp.task.editorTitleButtons`.
  assert.deepEqual(manifest.contributes?.menus?.["editor/title"], [
    { command: "mcpp.run", group: "navigation@1", when: "mcpp.inProject && mcpp.editorTitleButtons" },
    { command: "mcpp.test", group: "navigation@2", when: "mcpp.inProject && mcpp.editorTitleButtons" },
  ]);

  const commands = manifest.contributes?.commands ?? [];
  assert.equal(commands.find((command) => command.command === "mcpp.run")?.icon, "$(play)");
  assert.equal(commands.find((command) => command.command === "mcpp.test")?.icon, "$(beaker)");
  assert.ok(!commands.some((command) => command.command === "mcpp.inProject"));
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
  const source = readFileSync(path.join(root, "src/cli/controller.ts"), "utf8");
  const start = source.indexOf("private async selectDefaultToolchainFromInventory");
  const end = source.indexOf("private async pickInstallSpec", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const method = source.slice(start, end);
  const unlock = method.indexOf("this.operations.finishGlobal(token)");
  const immediateBuild = method.indexOf("const buildChoice");
  assert.ok(unlock >= 0 && unlock < immediateBuild);
});

test("项目任务结束后先释放项目锁再刷新 C++ 模块语言服务", () => {
  const source = readFileSync(path.join(root, "src/cli/controller.ts"), "utf8");
  const start = source.indexOf("public async runProjectTask");
  const end = source.indexOf("public async showToolchains", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const method = source.slice(start, end);
  const unlock = method.indexOf("this.operations.finishProject(project.root, token)");
  const refresh = method.indexOf("this.options.afterProjectTask(project, kind, completion)");
  assert.ok(unlock >= 0 && unlock < refresh);
});

test("安装流程把系统工具链和 target 兼容 spec 交给 mcpp 解析", () => {
  const source = readFileSync(path.join(root, "src/cli/controller.ts"), "utf8");
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
  const source = readFileSync(path.join(root, "src/cli/controller.ts"), "utf8");
  const start = source.indexOf("public async installToolchain");
  const end = source.indexOf("public async selectDefaultToolchain", start);
  const method = source.slice(start, end);

  assert.match(method, /may carry target semantics.*mcpp validates it in the end/s);
});

test("新建工程先校验目标路径再确认创建，成功后只打开不构建", () => {
  const source = readFileSync(path.join(root, "src/cli/controller.ts"), "utf8");
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
  const controller = readFileSync(path.join(root, "src/cli/controller.ts"), "utf8");
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

test("the activity bar gets the stencil, not the marketplace badge", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageManifest;
  const container = manifest.contributes?.viewsContainers?.activitybar?.[0];
  // VS Code masks a container icon with the theme's foreground colour
  // (`mask: url(icon)` at 24 px), so what is painted is the icon's *alpha
  // channel*. The official badge is an opaque rounded square with the wordmark
  // on it: as a stencil that is a solid block, which is what shipped. The
  // marketplace icon keeps the real logo; the activity bar gets its derived
  // stencil, and `npm run check:icon` proves the derivation is current.
  assert.equal(manifest.icon, "images/logo.png");
  assert.equal(container?.icon, "images/activity-bar.png");
  const stencil = readFileSync(path.join(root, "images", "activity-bar.png"));
  assert.deepEqual([...stencil.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  // Read from IHDR: 8-bit RGBA, and wider than tall, because the wordmark is.
  assert.equal(stencil.readUInt32BE(16), 96);
  assert.equal(stencil.readUInt32BE(20), 56);
});

test("the READMEs state the responsibility split, the boundary and the limits", () => {
  // The English README is the Marketplace listing; the Chinese one is its mirror.
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const chinese = readFileSync(path.join(root, "README.zh-CN.md"), "utf8");

  for (const text of [readme, chinese]) {
    assert.match(text, /sunrisepeak\.mcpp-language-server/);
    assert.match(text, /darwin-x64/);
    assert.match(text, /mcpp\.path/);
  }
  assert.match(readme, /README\.zh-CN\.md/);
  assert.match(chinese, /README\.md/);

  // The claims that must not creep back in: this extension is not a language
  // client, does not read clangd settings, and does not claim LLVM-only support.
  for (const text of [readme, chinese]) {
    assert.doesNotMatch(text, /starts? (a|its own) (second )?LSP client/i);
    assert.doesNotMatch(text, /reads your `clangd\./);
  }
  assert.doesNotMatch(readme, /only LLVM/i);
});

test("嵌套工程提示不猜测它一定是 mcpp 工作区成员", () => {
  const source = readFileSync(path.join(root, "src/cli/controller.ts"), "utf8");
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

test("the release workflow guards the published artefact against local leakage", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /校验 VSIX 体积与内容/);
  assert.match(workflow, /forbidden in \.dev-profile\/ \.agents\/ test\/ tools\/ src\/ node_modules\//);
  assert.match(workflow, /unzip -t/);
});

test("CI runs the gates, the package checks, the drift check and every e2e variant", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /concurrency:[\s\S]*cancel-in-progress: true/);
  assert.match(workflow, /node-version: \$\{\{ env.NODE_VERSION \}\}/);
  assert.match(workflow, /NODE_VERSION: 22/);
  // Cross-platform confidence: the unit gates run on Linux and macOS ARM64.
  assert.match(workflow, /os: \[ubuntu-latest, macos-14\]/);
  assert.match(workflow, /gates:/);
  assert.match(workflow, /extension-host-e2e:/);
  assert.match(workflow, /package:/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run package/);
  assert.match(workflow, /unzip -t/);
  // A local dev profile once leaked into the VSIX (64 MB); the guard is now explicit.
  assert.match(workflow, /The VSIX stays small and free of local state/);
  assert.match(workflow, /forbidden in \.dev-profile\/ \.agents\/ test\/ tools\/ src\/ node_modules\//);
  assert.match(workflow, /xvfb-run -a npm run test:e2e:one/);
  // The snapshot drift gate only means something with an mcpp checkout present.
  assert.match(workflow, /generated-drift:/);
  assert.match(workflow, /repository: mcpp-community\/mcpp/);
  assert.match(workflow, /MCPP_REPO: \$\{\{ github.workspace \}\}\/\.mcpp-source/);
  // The end-to-end dependency resolution check.
  assert.match(workflow, /isolated-install:/);
  assert.match(workflow, /sunrisepeak.mcpp-language-server@/);
});
