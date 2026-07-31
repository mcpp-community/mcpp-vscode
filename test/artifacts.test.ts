import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

interface PackageManifest {
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
  assert.ok(manifest.extensionDependencies?.includes("llvm-vs-code-extensions.vscode-clangd"));
  assert.ok(manifest.activationEvents?.includes("workspaceContains:mcpp.toml"));
  assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, "limited");
  assert.equal(
    manifest.capabilities?.untrustedWorkspaces?.description,
    "未受信任工作区仅启用模块语法高亮，不执行 CDB、mcpp 或 clangd 指定的任何程序，也不接管 clangd 配置。",
  );
  assert.deepEqual(
    manifest.contributes?.commands?.map((command) => command.command),
    ["mcpp.configureClangd", "mcpp.refreshCompilationDatabase", "mcpp.checkModuleSupport"],
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
