import assert from "node:assert/strict";
import test from "node:test";

import { analyseBuildScript } from "../../src/buildscript/analysis";
import { isKnownModule } from "../../src/buildscript/modules";
import { buildScriptContributions } from "../../src/buildscript/settings";

/**
 * The four boolean keys `settings.ts` resolves, with the registry's defaults.
 * A stub reader records what was asked for, so a wiring change that stops
 * reading a key fails the first test instead of silently keeping a default.
 */
const DEFAULTS: Readonly<Record<string, unknown>> = {
  "mcpp.buildScript.intelligence": true,
  "mcpp.buildScript.diagnostics": true,
  "mcpp.buildScript.snippets": true,
  "mcpp.buildScript.imports.knownModules": true,
};

function reader(overrides: Record<string, unknown> = {}): {
  read: <T>(key: string) => T;
  keys: string[];
} {
  const keys: string[] = [];
  const values: Record<string, unknown> = { ...DEFAULTS, ...overrides };
  return {
    keys,
    read: <T>(key: string): T => {
      keys.push(key);
      return values[key] as T;
    },
  };
}

test("all four switches are resolved, each from its own registry key", () => {
  const { read, keys } = reader();
  const contributions = buildScriptContributions(read, () => "warning");
  assert.deepEqual(contributions, {
    intelligence: true,
    diagnosticSeverity: "warning",
    snippets: true,
    knownModules: true,
  });
  // The four literal keys matter: `test/config/wiring.test.ts` scans the sources
  // for exactly this accessor shape to prove each declared setting is read.
  assert.deepEqual(keys.sort(), [
    "mcpp.buildScript.diagnostics",
    "mcpp.buildScript.imports.knownModules",
    "mcpp.buildScript.intelligence",
    "mcpp.buildScript.snippets",
  ]);
});

test("mcpp.buildScript.snippets=false drops snippets and nothing else", () => {
  const contributions = buildScriptContributions(
    reader({ "mcpp.buildScript.snippets": false }).read,
    () => "warning",
  );
  assert.equal(contributions.snippets, false);
  assert.equal(contributions.intelligence, true, "snippets must not turn the whole layer off");
  assert.equal(contributions.diagnosticSeverity, "warning", "diagnostics must stay");
  assert.equal(contributions.knownModules, true, "import completion must stay");
});

test("mcpp.buildScript.imports.knownModules=false drops only the completion list", () => {
  const contributions = buildScriptContributions(
    reader({ "mcpp.buildScript.imports.knownModules": false }).read,
    () => "warning",
  );
  assert.equal(contributions.knownModules, false);
  assert.equal(contributions.intelligence, true);
  assert.equal(contributions.snippets, true);
  assert.equal(contributions.diagnosticSeverity, "warning");
});

test("mcpp.buildScript.diagnostics=false stops diagnostics but keeps completion and hover", () => {
  const contributions = buildScriptContributions(
    reader({ "mcpp.buildScript.diagnostics": false }).read,
    () => "warning",
  );
  assert.equal(contributions.diagnosticSeverity, undefined);
  assert.equal(contributions.intelligence, true);
  assert.equal(contributions.snippets, true);
  assert.equal(contributions.knownModules, true);
});

test("mcpp.buildScript.intelligence=false leaves no build.mcpp intelligence at all", () => {
  const contributions = buildScriptContributions(
    reader({ "mcpp.buildScript.intelligence": false }).read,
    () => "off",
  );
  assert.equal(contributions.intelligence, false);
  assert.equal(contributions.diagnosticSeverity, undefined);
  assert.equal(contributions.snippets, false);
  assert.equal(contributions.knownModules, false);
});

test("a severity of off publishes nothing, and a valid severity is passed through", () => {
  const off = buildScriptContributions(reader().read, () => "off");
  assert.equal(off.diagnosticSeverity, undefined);
  assert.equal(off.intelligence, true, "severity=off must not disable completion or hover");

  const info = buildScriptContributions(reader().read, () => "info");
  assert.equal(info.diagnosticSeverity, "info");
});

test("known modules stay recognised and are never reported missing with every switch off", () => {
  const { read } = reader({
    "mcpp.buildScript.intelligence": false,
    "mcpp.buildScript.diagnostics": false,
    "mcpp.buildScript.snippets": false,
    "mcpp.buildScript.imports.knownModules": false,
  });
  const contributions = buildScriptContributions(read, () => "off");
  assert.equal(contributions.diagnosticSeverity, undefined, "no diagnostics with everything off");

  // §3.2.1: mcpp keeps `build.mcpp` out of the compilation database, so this
  // extension can never validate an import. The "never report std/std.compat/
  // mcpp.* as missing" rule is therefore absolute and lives in the analyser and
  // the recognition table, not behind `mcpp.buildScript.imports.knownModules`
  // (that key removes the *completion list* only). The two `mcpp.toml.
  // indexCompletion*` switches act on a different language and cannot reach
  // this path, so "every switch off" here is the five `mcpp.buildScript.*` keys.
  const lines = [
    "import std;",
    "import std.compat;",
    "import mcpp;",
    "import mcpp.core;",
    "import mcpp.plugins.tool;",
    "import mcpp.deps.something;",
  ];
  assert.deepEqual(analyseBuildScript(lines, "warning"), []);
  for (const name of ["std", "std.compat", "mcpp", "mcpp.core", "mcpp.plugins.tool"]) {
    assert.equal(isKnownModule(name), true, `${name} stopped being recognised`);
  }
});
