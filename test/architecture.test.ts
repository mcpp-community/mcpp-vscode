import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The architectural rule this codebase is built on: **pure modules never import
 * `vscode`**.
 *
 * It is what makes the logic testable under plain `node --test`, and it is easy
 * to break by accident — a convenience `vscode.window.showWarningMessage` in a
 * policy helper, or an `import * as vscode` at the top of a translation module,
 * silently takes the whole file out of the unit test's reach. So the rule is
 * checked two ways: the import is absent from the source, and the module can
 * actually be loaded outside an editor host.
 */

/** The modules that must stay importable without VS Code. */
const PURE_MODULES = [
  "src/i18n/t.ts",
  "src/i18n/translate.ts",
  "src/cli/clean.ts",
  "src/cli/cache.ts",
  "src/cli/artifacts.ts",
  "src/cli/process.ts",
  "src/cli/protocol.ts",
  "src/cli/search.ts",
  "src/cli/tasks.ts",
  "src/cli/newProject.ts",
  "src/cli/toolchain.ts",
  "src/cli/labels.ts",
  "src/cli/statusBar.ts",
  "src/cli/selfCheck.ts",
  "src/config/registry.ts",
  "src/config/validate.ts",
  "src/config/panelHtml.ts",
  "src/mcppls/contract.ts",
  "src/mcppls/state.ts",
  "src/mcppls/messages.ts",
  "src/mcppls/timers.ts",
  "src/projects/discovery.ts",
  "src/projects/summary.ts",
  "src/toml/completion.ts",
  "src/toml/diagnostics.ts",
  "src/toml/parser.ts",
  "src/toml/schema.ts",
  "src/toml/hover.ts",
  "src/toml/navigation.ts",
  "src/views/models.ts",
  "src/cache/cacheState.ts",
  "src/library/indexModel.ts",
  "src/library/xpkg.ts",
  "src/library/libraryHtml.ts",
  "src/library/detailHtml.ts",
  "src/cache/cachePanelHtml.ts",
  "src/views/viewPolicy.ts",
  "src/buildscript/analysis.ts",
  "src/buildscript/api.ts",
  "src/buildscript/modules.ts",
  "src/buildscript/settings.ts",
  "src/buildscript/snippets.ts",
  "src/util/format.ts",
  "src/util/log.ts",
  "src/util/text.ts",
  "src/webview/render.ts",
  "src/workflows/moduleSetup.ts",
];

const root = process.cwd();

test("a pure module does not import vscode", () => {
  const offenders: string[] = [];
  for (const relative of PURE_MODULES) {
    const text = readFileSync(path.join(root, relative), "utf8");
    // `import type` is fine: it is erased at compile time and costs nothing at
    // runtime, which is exactly how `src/i18n/t.ts` reads the l10n API lazily.
    for (const match of text.matchAll(/^\s*import\s+(?!type\b)[^;]*from\s+"vscode";/gm)) {
      offenders.push(`${relative}: ${match[0].trim()}`);
    }
    assert.ok(!/require\(\s*["']vscode["']\s*\)/.test(text.replace(/require\(\s*["']vscode["']\s*\)\s*as\s+typeof\s+vscode/g, "")),
      `${relative} requires vscode at module scope`);
  }
  assert.deepEqual(offenders, [], `these pure modules must not import vscode:\n  ${offenders.join("\n  ")}`);
});

test("a pure module can actually be loaded without an editor host", async () => {
  // The source check above proves the absence of an import; this proves the
  // consequence, which is the property the unit tests depend on.
  const failed: string[] = [];
  for (const relative of PURE_MODULES) {
    const compiled = path.join(root, "dist", relative.replace(/\.ts$/, ".js"));
    try {
      await import(compiled);
    } catch (error) {
      failed.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failed, [], `these pure modules could not load outside VS Code:\n  ${failed.join("\n  ")}`);
});

test("the list is not so short that the rule stops meaning anything", () => {
  assert.ok(PURE_MODULES.length >= 40, `only ${PURE_MODULES.length} modules are checked`);
});

test("every listed module exists", () => {
  for (const relative of PURE_MODULES) {
    readFileSync(path.join(root, relative), "utf8");
  }
});

test("runProcess stays inside src/cli — everything else runs mcpp through the trust-gated seam", () => {
  // The external review's P0 (2026-10-03): `mcpp.path` is a resource-scoped
  // setting, so any call site that skips the workspace-trust gate lets an
  // untrusted workspace name the program that runs. The seam is `runMcpp`;
  // `src/cli/` keeps `runProcess` because its controller wraps whole commands
  // in `requireTrusted()` prompts of its own.
  const offenders: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) {
        continue;
      }
      const relative = path.relative(root, full);
      if (relative.split(path.sep)[1] === "cli") {
        continue;
      }
      const text = readFileSync(full, "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/\brunProcess\b/.test(code)) {
        offenders.push(relative);
      }
    }
  };
  walk(path.join(root, "src"));
  assert.deepEqual(offenders, [], "these files call runProcess directly; use runMcpp(trusted, …) instead");
});
