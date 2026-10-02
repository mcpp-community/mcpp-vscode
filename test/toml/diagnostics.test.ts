import assert from "node:assert/strict";
import test from "node:test";

import {
  DIAGNOSTIC_CODES,
  analyseManifest,
  type DiagnosticSettings,
} from "../../src/toml/diagnostics";

function settings(overrides: Partial<DiagnosticSettings> = {}): DiagnosticSettings {
  return {
    syntax: "error",
    unknownSection: "warning",
    unknownKey: "warning",
    planeSeparation: "warning",
    legacyKeys: "info",
    ...overrides,
  };
}

function codes(lines: readonly string[], overrides: Partial<DiagnosticSettings> = {}): string[] {
  return analyseManifest(lines, settings(overrides)).map((diagnostic) => diagnostic.code);
}

// ── rule 1: syntax ──────────────────────────────────────────────────────────

test("rule 1: a line that is neither a header nor key = value is a syntax error", () => {
  const found = analyseManifest(["[package]", 'name = "x"', "this is broken"], settings());
  assert.equal(found.length, 1);
  assert.equal(found[0].code, DIAGNOSTIC_CODES.syntax);
  assert.equal(found[0].severity, "error");
  assert.equal(found[0].line, 3);
  assert.deepEqual([found[0].startCharacter, found[0].endCharacter], [1, 15]);
});

test("rule 1: a key without a value and a malformed header are syntax errors", () => {
  assert.deepEqual(codes(["[package]", "name ="]), [DIAGNOSTIC_CODES.syntax]);
  assert.deepEqual(codes(["[package", 'name = "x"']), [DIAGNOSTIC_CODES.syntax]);
  assert.deepEqual(codes(["[package]", "= 1"]), [DIAGNOSTIC_CODES.syntax]);
});

test("rule 1: headers, comments, continuations and quoted # are not syntax errors", () => {
  const lines = [
    "# a comment",
    "",
    "[package]",
    'description = """',
    "a # inside a string",
    "and a = sign",
    '"""',
    "",
    "[build]",
    "sources = [",
    '  "src/**/*.cppm", # a real comment',
    '  "src/**",',
    "]",
    'cxxflags = ["-DA#B"]',
  ];
  assert.deepEqual(codes(lines), []);
});

// ── rule 2: unknown section ─────────────────────────────────────────────────

test("rule 2: a section the schema does not know is reported", () => {
  const found = analyseManifest(["[packag]", 'name = "x"'], settings());
  assert.equal(found.length, 1);
  assert.equal(found[0].code, DIAGNOSTIC_CODES.unknownSection);
  assert.equal(found[0].line, 1);
  assert.equal(found[0].relatedKey, "packag");
});

test("rule 2: a dotted conditional name matches its prefix section", () => {
  assert.deepEqual(
    codes(["[package]", 'name = "x"', "[target.'cfg(os = \"linux\")'.dependencies]", 'foo = "1"']),
    [],
  );
  assert.deepEqual(codes(["[targets.app]", 'kind = "bin"']), []);
  assert.deepEqual(codes(["[package]", 'name = "x"', "[package.metadata.demo]", 'anything = 1']), []);
});

// ── rule 3: unknown key ─────────────────────────────────────────────────────

test("rule 3: a key absent from a section's key table is reported", () => {
  const found = analyseManifest(["[package]", 'nmae = "x"'], settings());
  assert.equal(found.length, 1);
  assert.equal(found[0].code, DIAGNOSTIC_CODES.unknownKey);
  assert.equal(found[0].relatedKey, "nmae");
  assert.deepEqual(codes(["[package]", 'name = "x"', 'standard = "c++23"']), []);
});

test("rule 3: row tables inherit their base section's key table", () => {
  assert.deepEqual(codes(["[targets.app]", 'kind = "bin"', "bogus = 1"]), [DIAGNOSTIC_CODES.unknownKey]);
  assert.deepEqual(codes(["[profile.dist]", "opt = 3"]), []);
});

test("rule 3: deeper sub-tables have their own vocabulary and are not checked", () => {
  assert.deepEqual(codes(["[runtime.\"display.present\"]", 'provider = "acme@2.0"']), []);
  assert.deepEqual(codes(["[toolchain.linux]", 'path = "/opt"', 'family = "gcc"']), []);
  assert.deepEqual(codes(["[target.windows.build]", 'dialect_cxxflags = ["-DX"]']), []);
});

// ── rule 4: plane separation ────────────────────────────────────────────────

test("rule 4: a tool payload inside a dependency table is a plane mistake", () => {
  const found = analyseManifest(["[dependencies]", '"xim:ninja" = "1.0"'], settings());
  assert.equal(found.length, 1);
  assert.equal(found[0].code, DIAGNOSTIC_CODES.planeSeparation);
  assert.match(found[0].message, /xim:ninja/);
  assert.match(found[0].message, /\[xlings\]/);
});

test("rule 4: an mcpp package inside [xlings] is a plane mistake", () => {
  assert.deepEqual(codes(["[xlings.workspace]", 'mcpplibs.cmdline = "1.0"']), [
    DIAGNOSTIC_CODES.planeSeparation,
  ]);
});

test("rule 4: the correct plane in each table is not reported", () => {
  assert.deepEqual(codes(["[dependencies]", 'lua = "5.4.7"']), []);
  assert.deepEqual(codes(["[dependencies]", 'foo = { path = "../foo" }']), []);
  assert.deepEqual(codes(["[xlings.workspace]", '"xim:ninja" = "1.0"']), []);
  assert.deepEqual(codes(["[xlings.workspace]", 'mcpplibs.cmdline = { path = "../cmdline" }']), []);
});

// ── rule 5: [package].mcpp floor ────────────────────────────────────────────

test("rule 5: [package].mcpp must be a >= floor", () => {
  const found = analyseManifest(["[package]", 'mcpp = "2026.9.28.3"'], settings());
  assert.equal(found.length, 1);
  assert.equal(found[0].code, DIAGNOSTIC_CODES.mcppFloor);
  assert.equal(found[0].relatedKey, "mcpp");
});

test("rule 5: the >= form and a package without the key are fine", () => {
  assert.deepEqual(codes(["[package]", 'mcpp = ">=2026.9.28.3"']), []);
  assert.deepEqual(codes(["[package]", 'name = "x"']), []);
  // A key of the same name in another section is not this rule.
  assert.deepEqual(codes(["[build]", "accel = 1"]), []);
});

// ── rule 6: legacy section or key ───────────────────────────────────────────

test("rule 6: a deprecated section names its replacement", () => {
  const found = analyseManifest(["[language]", 'standard = "c++20"'], settings());
  assert.equal(found.length, 1);
  assert.equal(found[0].code, DIAGNOSTIC_CODES.legacyKey);
  assert.match(found[0].message, /\[package\]\.standard/);
});

test("rule 6: a legacy key names its replacement", () => {
  const found = analyseManifest(["[build]", "static_stdlib = true"], settings());
  assert.equal(found.length, 1);
  assert.equal(found[0].code, DIAGNOSTIC_CODES.legacyKey);
  assert.match(found[0].message, /cxx_runtime/);
  assert.deepEqual(codes(["[package]", 'standard = "c++23"']), []);
});

// ── rule 7: array tables ────────────────────────────────────────────────────

test("rule 7: an array table mcpp does not use is reported", () => {
  const found = analyseManifest(["[[targets.app]]", 'kind = "bin"'], settings());
  assert.equal(found.length, 1);
  assert.equal(found[0].code, DIAGNOSTIC_CODES.arrayTable);
  assert.equal(found[0].line, 1);
});

test("rule 7: the array tables mcpp accepts are not reported", () => {
  assert.deepEqual(codes(["[[build.flags]]", 'glob = "src/**"']), []);
  assert.deepEqual(codes(["[[features.simd.flags]]", 'glob = "src/**"']), []);
  assert.deepEqual(codes(["[targets.app]", 'kind = "bin"']), []);
});

// ── severity and quoting ────────────────────────────────────────────────────

test("severity off silences its rule and leaves the others alone", () => {
  const lines = ["[packag]", 'name = "x"', "this is broken"];
  assert.deepEqual(codes(lines), [DIAGNOSTIC_CODES.unknownSection, DIAGNOSTIC_CODES.syntax]);
  assert.deepEqual(codes(lines, { syntax: "off" }), [DIAGNOSTIC_CODES.unknownSection]);
  assert.deepEqual(codes(lines, { unknownSection: "off" }), [DIAGNOSTIC_CODES.syntax]);
  assert.deepEqual(codes(["[language]", 'standard = "c++20"'], { legacyKeys: "off" }), []);
  assert.deepEqual(codes(["[dependencies]", '"xim:ninja" = "1.0"'], { planeSeparation: "off" }), []);
  assert.deepEqual(codes(["[package]", 'nmae = "x"'], { unknownKey: "off" }), []);
});

test("a # inside a string is not a comment, and later lines are still checked", () => {
  assert.deepEqual(
    codes(["[package]", 'description = "a # not a comment"', "license = 'MIT' # trailing"]),
    [],
  );
  const found = analyseManifest(["[package]", 'description = "#"', "still broken"], settings());
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
});

test("a multi-line string hides its contents from every rule", () => {
  const lines = ["[package]", 'description = """', "not a key = value", "[[not a table]]", '"""'];
  assert.deepEqual(codes(lines), []);
});

test("positions are 1-based and cover the offending token", () => {
  const header = analyseManifest(["  [packag]"], settings());
  assert.deepEqual(
    header.map((diagnostic) => [diagnostic.line, diagnostic.startCharacter, diagnostic.endCharacter]),
    [[1, 3, 11]],
  );
  const key = analyseManifest(["[package]", '  nmae = "x"'], settings());
  assert.deepEqual(
    key.map((diagnostic) => [diagnostic.line, diagnostic.startCharacter, diagnostic.endCharacter]),
    [[2, 3, 7]],
  );
});

test("a clean manifest produces no diagnostics", () => {
  const lines = [
    "[package]",
    'name = "greeter"',
    'version = "0.1.0"',
    'standard = "c++23"',
    'mcpp = ">=2026.9.28.3"',
    "",
    "[build]",
    'sources = ["src/**/*.cppm", "src/**/*.cpp"]',
    'bmi_schedule = "on"',
    "",
    "[targets.greeter]",
    'kind = "bin"',
    "",
    "[dependencies]",
    'fmt = "11.0.2"',
    "",
    "[xlings.workspace]",
    '"xim:ninja" = "1.12.1"',
  ];
  assert.deepEqual(codes(lines), []);
});
