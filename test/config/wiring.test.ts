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

/**
 * Settings read through a table rather than a literal key.
 *
 * These are still read once per call site — the table is the reviewer's evidence,
 * and `evidence` must appear verbatim in the file, so renaming or deleting the
 * table without updating this entry fails the build.
 */
const READ_INDIRECTLY: ReadonlyArray<{ key: string; file: string; evidence: string }> = [
  {
    key: "mcpp.task.buildArgs",
    file: "src/cli/tasks.ts",
    evidence: 'build: "mcpp.task.buildArgs"',
  },
  {
    key: "mcpp.task.runArgs",
    file: "src/cli/tasks.ts",
    evidence: 'run: "mcpp.task.runArgs"',
  },
  {
    key: "mcpp.task.testArgs",
    file: "src/cli/tasks.ts",
    evidence: 'test: "mcpp.task.testArgs"',
  },
  {
    key: "mcpp.task.cleanArgs",
    file: "src/cli/tasks.ts",
    evidence: 'clean: "mcpp.task.cleanArgs"',
  },
];

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
    if (READ_INDIRECTLY.some((entry_) => entry_.key === entry.key)) {
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

test("an indirect entry names a real setting and its evidence is still in the file", () => {
  const byKey = new Map(SETTINGS.map((entry) => [entry.key, entry]));
  for (const { key, file, evidence } of READ_INDIRECTLY) {
    assert.ok(byKey.has(key), `${key} is not a registry setting`);
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    assert.ok(source.includes(evidence), `${file} no longer contains the evidence for ${key}: ${evidence}`);
  }
});

test("an indirect entry is not left behind once the setting is read literally", () => {
  const keys = readKeys();
  const stale = READ_INDIRECTLY.filter(({ key }) => keys.has(key) || keys.has(key.replace(/^mcpp\./, "")));
  assert.deepEqual(
    stale.map((entry) => entry.key),
    [],
    "these settings are read by literal key now, so move them out of the indirect table",
  );
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

test("there is no exemption left that a literal read could have covered", () => {
  // The audit in §8 G8 listed 40 unwired settings; the indirect table holds the
  // only four that cannot be scanned for. Anything else must be read for real.
  assert.ok(
    READ_INDIRECTLY.length <= 4,
    `the indirect table grew to ${READ_INDIRECTLY.length}; read the setting by literal key instead`,
  );
});

test("the parameterised test uses real files, not an empty scan", () => {
  assert.ok(statSync(path.join(process.cwd(), "src")).isDirectory());
  assert.ok(readKeys().size > 10, "the accessor scan found almost nothing, so it is broken");
});
