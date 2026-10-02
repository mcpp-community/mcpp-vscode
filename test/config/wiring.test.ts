import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { SETTINGS } from "../../src/config/registry";

/**
 * "Declared but not read" is the failure this test exists for.
 *
 * A setting that nothing reads is worse than no setting: it is offered in the
 * Settings UI, it is documented, and it does nothing. The audit in
 * `.agents/docs/2026-10-02-implementation-plan.md` §8 found thirteen such gaps,
 * so this gate makes the rule executable — a new registry entry that no module
 * reads fails the build.
 *
 * The scan looks for the accessor calls this codebase actually uses:
 * `read(...)`/`read<T>(...)` from `src/config/access.ts`, and
 * `get(...)`/`get<T>(...)` on a `getConfiguration` result. A key named in either
 * form counts as read. The exceptions below are the honest, shrinking list of
 * settings still waiting for their feature; each must name why.
 */

const EXCEPTIONS: Readonly<Record<string, string>> = {
  "mcpp.task.buildArgs": "§8 G8 — extra argv for a task is not plumbed through `projectTaskPlan` yet",
  "mcpp.task.runArgs": "§8 G8 — same",
  "mcpp.task.testArgs": "§8 G8 — same",
  "mcpp.task.cleanArgs": "§8 G8 — same",
  "mcpp.task.revealTerminal": "§8 G8 — task presentation is fixed",
  "mcpp.task.focusTerminal": "§8 G8 — task presentation is fixed",
  "mcpp.task.clearTerminal": "§8 G8 — task presentation is fixed",
  "mcpp.task.problemMatcher": "§8 G8 — no problem matcher is contributed yet",
  "mcpp.task.editorTitleButtons": "§8 G8 — the editor/title `when` clause is fixed",
  "mcpp.task.confirmClean": "§8 G8 — the clean command's own plan already confirms",
  "mcpp.languageService.notifyOnDegraded": "§8 G8 — the notice is unconditional",
  "mcpp.languageService.readState": "§8 G8 — the state read is unconditional",
  "mcpp.languageService.stateRefreshSeconds": "§8 G8 — there is no polling to configure",
  "mcpp.languageService.confirmResetCache": "§8 G8 — the capability's own danger level confirms",
  "mcpp.cache.warnAboveGiB": "§8 G8 — only the tree renders it, not the panel",
  "mcpp.cache.autoRefreshSeconds": "§8 G8 — the view is refreshed on demand only",
  "mcpp.cache.showLegacy": "§8 G6 — the legacy node is not populated yet",
  "mcpp.cache.gc.confirmAboveGiB": "§8 G6 — the budget dialogue does not add a second confirmation",
  "mcpp.views.project.show": "§8 G8 — the view's `when` clause is fixed",
  "mcpp.views.cache.show": "§8 G8 — same",
  "mcpp.views.languageServer.show": "§8 G8 — same",
  "mcpp.ui.statusBar.showLanguageServer": "§8 G8 — the status text is mcpp-only",
  "mcpp.ui.notifications.success": "§8 G8 — the success notice is fixed",
  "mcpp.ui.notifications.dedupeMinutes": "§8 G8 — notices are not de-duplicated yet",
  "mcpp.ui.confirmDestructiveOnly": "§8 G8 — confirmation comes from the cleanup plan",
  "mcpp.project.discoveryBoundary": "§8 G8 — discovery always stops at the workspace folder",
  "mcpp.log.level": "§8 G8 — the output channel is not levelled yet",
  "mcpp.buildScript.imports.knownModules": "§8 G8 — known-module recognition is unconditional",
  "mcpp.buildScript.snippets": "§8 G8 — snippets are always offered",
  "mcpp.toml.indexCompletion": "§8 G3 — the search adapter is not wired into completion yet",
  "mcpp.toml.indexCompletionTimeoutSeconds": "§8 G3 — same",
};

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, found);
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/** The keys a module actually asks for, in either accessor form. */
function readKeys(): Set<string> {
  const keys = new Set<string>();
  const accessor = /(?:read|get)(?:<[^>]*>)?\(\s*["']([^"']+)["']/g;
  for (const file of sourceFiles(path.join(process.cwd(), "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(accessor)) {
      keys.add(match[1]);
      // Callers may pass the whole `mcpp.` key; the sub-key is what VS Code sees.
      keys.add(match[1].replace(/^mcpp\./, ""));
    }
  }
  return keys;
}

test("every declared setting is either read by a module or listed with a reason", () => {
  const keys = readKeys();
  const unwired: string[] = [];
  for (const entry of SETTINGS) {
    if (entry.deprecated === true) {
      continue; // deprecated settings must NOT be read; see the test below
    }
    const sub = entry.key.replace(/^mcpp\./, "");
    if (keys.has(entry.key) || keys.has(sub)) {
      continue;
    }
    if (entry.key in EXCEPTIONS) {
      continue;
    }
    unwired.push(entry.key);
  }
  assert.deepEqual(
    unwired,
    [],
    `these settings are declared but nothing reads them, and they carry no documented exception:\n  ${unwired.join("\n  ")}`,
  );
});

test("a documented exception names a reason and is still real", () => {
  const byKey = new Map(SETTINGS.map((entry) => [entry.key, entry]));
  for (const [key, reason] of Object.entries(EXCEPTIONS)) {
    assert.ok(byKey.has(key), `${key} is not a registry setting; remove the stale exception`);
    assert.match(reason, /§8 G\d+/, `${key} must point at the audit item that will remove it`);
  }
});

test("an exception is not left behind once the setting is wired", () => {
  const keys = readKeys();
  const stale = Object.keys(EXCEPTIONS).filter((key) => {
    const sub = key.replace(/^mcpp\./, "");
    return keys.has(key) || keys.has(sub);
  });
  assert.deepEqual(stale, [], `these settings are read now, so remove their exceptions:\n  ${stale.join("\n  ")}`);
});

test("deprecated settings are kept but read by nothing", () => {
  const keys = readKeys();
  const deprecated = SETTINGS.filter((entry) => entry.deprecated === true);
  assert.equal(deprecated.length, 4);
  for (const entry of deprecated) {
    const sub = entry.key.replace(/^mcpp\./, "");
    assert.ok(!keys.has(entry.key) && !keys.has(sub), `${entry.key} is deprecated but still read`);
  }
});

test("the exception list only shrinks: it never grows beyond what §8 records", () => {
  // 31 today, down from the 42 the audit listed. Lowering this number is the
  // point of the list; raising it means a new setting was added without wiring it.
  assert.ok(
    Object.keys(EXCEPTIONS).length <= 31,
    `the exception list grew to ${Object.keys(EXCEPTIONS).length}; wire the setting instead`,
  );
});

test("the parameterised test uses real files, not an empty scan", () => {
  assert.ok(statSync(path.join(process.cwd(), "src")).isDirectory());
  assert.ok(readKeys().size > 10, "the accessor scan found almost nothing, so it is broken");
});
