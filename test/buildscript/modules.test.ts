import assert from "node:assert/strict";
import test from "node:test";

import {
  isKnownModule,
  knownModule,
  knownModules,
  scanImports,
} from "../../src/buildscript/modules";

test("scans plain, exported and dotted imports", () => {
  const sites = scanImports([
    "import std;",
    "export import mcpp;",
    "import mcpp.plugins.tool; // trailing comment",
  ]);
  assert.deepEqual(
    sites.map((site) => site.module),
    ["std", "mcpp", "mcpp.plugins.tool"],
  );
  assert.deepEqual(
    sites.map((site) => site.line),
    [0, 1, 2],
  );
});

test("reports the module name's own span, not the statement's", () => {
  const [site] = scanImports(["import   mcpp.core;   "]);
  assert.equal(site.module, "mcpp.core");
  assert.equal(site.startCharacter, 9);
  assert.equal(site.endCharacter, 18);
});

test("finds two imports on one line", () => {
  const sites = scanImports(["import a; import b.c;"]);
  assert.deepEqual(
    sites.map((site) => site.module),
    ["a", "b.c"],
  );
});

test("ignores import inside strings, line comments and block comments", () => {
  assert.deepEqual(
    scanImports([
      "// import fake;",
      'const char* s = "import fake;";',
      "/* import fake; */",
      "/*",
      "import fake;",
      "*/",
      'const char* t = R"(import fake;)";',
      "important(); // import fake;",
    ]),
    [],
  );
});

test("ignores header units, header imports and partitions", () => {
  assert.deepEqual(scanImports(['import <vector>;', 'import "vector.h";', "import :part;"]), []);
});

test("a comment after a real import does not hide it", () => {
  const sites = scanImports(["import std; // import fake;"]);
  assert.deepEqual(
    sites.map((site) => site.module),
    ["std"],
  );
});

test("recognises the standard library, the engine and mcpp plugins", () => {
  for (const name of [
    "std",
    "std.compat",
    "mcpp",
    "mcpp.core",
    "mcpp.plugins.tool",
    "mcpp.plugins.a.b",
    "mcpp.deps.vcpkg",
    "mcpp.rules.qt",
  ]) {
    assert.equal(isKnownModule(name), true, `${name} should be known`);
  }
});

test("does not claim names that are not modules", () => {
  for (const name of [
    "mcpp.toml",
    "mcppx",
    "stdlib",
    "std.compat.x",
    "mcpp.plugins",
    "mcpp.plugins.",
    "mcpp.core.x",
    "",
  ]) {
    assert.equal(isKnownModule(name), false, `${name} should not be known`);
  }
});

test("knownModule() describes a wildcard match with the queried name", () => {
  const plugin = knownModule("mcpp.plugins.tool");
  assert.ok(plugin);
  assert.equal(plugin.name, "mcpp.plugins.tool");
  assert.ok(plugin.description.length > 0);
  assert.ok(plugin.docsUrl?.startsWith("https://github.com/mcpp-community/mcpp"));
  assert.equal(knownModule("mcpp.toml"), undefined);
  assert.equal(knownModule("nope"), undefined);
});

test("knownModules() lists the exact names a build program can import", () => {
  const names = knownModules().map((entry) => entry.name);
  for (const name of ["std", "std.compat", "mcpp", "mcpp.core", "mcpp.plugins.*"]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  for (const entry of knownModules()) {
    assert.ok(entry.description.length > 0, `${entry.name} has no description`);
  }
});
