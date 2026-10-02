import assert from "node:assert/strict";
import test from "node:test";

import {
  SURFACES,
  SURFACE_TEXT,
  compareVersions,
  latestVersion,
  parseXpkgJson,
  parseXpkgJsonValue,
  platformKey,
  sortVersions,
  surfaceOf,
  surfacesOf,
  textNamesBinaryTarget,
  versionGroups,
  versionsFor,
} from "../../src/library/xpkg";

/** The real answer for `compat.argparse.lua`, byte for byte from mcpp 2026.9.30.2. */
const ARGPARSE = `{"namespace":"compat","name":"argparse","versions":{"linux":["3.2"],"macosx":["3.2"],"windows":["3.2"]},"standard":"c++23","import_std":false,"sources":["mcpp_generated/argparse_anchor.c"],"include_dirs":["*/include"],"generated_files":[{"path":"mcpp_generated/argparse_anchor.c","bytes":52}],"generated_contents":{"mcpp_generated/argparse_anchor.c":"int x(void) { return 0; }\\n"},"targets":["argparse"],"unknown_keys":[]}`;

test("parseXpkgJson decodes the documented document", () => {
  const info = parseXpkgJson(ARGPARSE);
  assert.ok(info !== undefined);
  assert.equal(info.namespace, "compat");
  assert.equal(info.name, "argparse");
  assert.deepEqual(info.versions, { linux: ["3.2"], macosx: ["3.2"], windows: ["3.2"] });
  assert.equal(info.standard, "c++23");
  assert.equal(info.importStd, false);
  assert.deepEqual(info.includeDirs, ["*/include"]);
  assert.deepEqual(info.generatedFiles, ["mcpp_generated/argparse_anchor.c"]);
  assert.deepEqual(info.generatedContents, ["mcpp_generated/argparse_anchor.c"]);
  assert.deepEqual(info.targets, [{ name: "argparse" }]);
  assert.deepEqual(info.unknownKeys, []);
});

test("parseXpkgJson refuses anything that is not that document", () => {
  assert.equal(parseXpkgJson(""), undefined);
  assert.equal(parseXpkgJson("   "), undefined);
  assert.equal(parseXpkgJson("error: unknown option: --format"), undefined);
  assert.equal(parseXpkgJson("[]"), undefined);
  assert.equal(parseXpkgJson('{"kind":"error","diagnostics":[]}'), undefined, "an error envelope has no name");
  assert.equal(parseXpkgJson('{"namespace":"compat"}'), undefined, "a document without a name is not a package");
  assert.equal(parseXpkgJsonValue(null), undefined);
  assert.equal(parseXpkgJsonValue("x"), undefined);
});

test("a malformed field is dropped, never allowed to break the rest", () => {
  const info = parseXpkgJsonValue({
    namespace: 7,
    name: "x",
    versions: { linux: ["1.0", 3], windows: "nope", macosx: [] },
    sources: "not a list",
    include_dirs: ["a", null],
    targets: ["t", { kind: "bin" }, 9],
    generated_files: [{ path: "a.cppm" }, "b.cppm", { bytes: 3 }],
    unknown_keys: ["future_key"],
  });
  assert.ok(info !== undefined);
  assert.equal(info.namespace, "");
  assert.deepEqual(info.versions, { linux: ["1.0"] }, "empty groups are not groups");
  assert.deepEqual(info.sources, []);
  assert.deepEqual(info.includeDirs, ["a"]);
  assert.deepEqual(info.targets, [{ name: "t" }, { kind: "bin" }]);
  assert.deepEqual(info.generatedFiles, ["a.cppm", "b.cppm"]);
  assert.deepEqual(info.unknownKeys, ["future_key"]);
});

test("surfacesOf asks the four SURFACES questions in the generator's order", () => {
  const module = parseXpkgJsonValue({ name: "cmdline", sources: ["*/src/**/*.cppm"], include_dirs: [], targets: ["cmdline"] });
  assert.ok(module !== undefined);
  assert.deepEqual(surfacesOf(module), ["module"], "a .cppm source is a module surface");
  assert.equal(surfaceOf(module), "module");

  const header = parseXpkgJson(ARGPARSE);
  assert.ok(header !== undefined);
  assert.deepEqual(surfacesOf(header), ["header"]);

  const generated = parseXpkgJsonValue({
    name: "fmt",
    sources: [],
    generated_contents: { "mcpp_generated/fmt_module.cppm": "export module fmt;" },
    targets: ["fmt"],
  });
  assert.ok(generated !== undefined);
  assert.deepEqual(surfacesOf(generated), ["module"], "a generated .cppm counts too");

  const tool = parseXpkgJsonValue({ name: "protoc", sources: ["a.cc"], targets: [{ name: "protoc", kind: "bin" }] });
  assert.ok(tool !== undefined);
  assert.deepEqual(surfacesOf(tool), ["header", "tool"]);

  // Form A: the descriptor names no build shape of its own.
  const external = parseXpkgJsonValue({ namespace: "mcpplibs", name: "llmapi", versions: { linux: ["0.2.8"] }, form: "A" });
  assert.ok(external !== undefined);
  assert.deepEqual(surfacesOf(external), ["external"]);
  assert.equal(SURFACE_TEXT.external.label, "upstream mcpp.toml");
  assert.equal(SURFACE_TEXT.external.uiKey, "library.surface.external");

  // A Form B package with sources and no module keeps the header surface — that
  // is the seven `compat.*-runtime` anchor packages, and the site says the same.
  const anchor = parseXpkgJsonValue({ name: "vulkan-runtime", sources: ["mcpp_generated/empty.c"], include_dirs: [], targets: ["vulkan_runtime"] });
  assert.ok(anchor !== undefined);
  assert.deepEqual(surfacesOf(anchor), ["header"]);

  // Targets and nothing else: an empty answer is a real answer.
  const opaque = parseXpkgJsonValue({ name: "opaque", targets: ["opaque"] });
  assert.ok(opaque !== undefined);
  assert.deepEqual(surfacesOf(opaque), []);

  assert.deepEqual(SURFACES, ["module", "header", "tool", "external"]);
  assert.equal(SURFACE_TEXT.module.label, "import");
  assert.equal(SURFACE_TEXT.header.label, "#include");
  assert.equal(SURFACE_TEXT.tool.label, "tool");
  for (const surface of SURFACES) {
    assert.equal(typeof SURFACE_TEXT[surface].usage, "string");
  }
});

test("textNamesBinaryTarget sees the descriptor's own manifest, not a comment alone", () => {
  assert.equal(textNamesBinaryTarget(`targets = { p = { kind = "bin" } }`), true);
  assert.equal(textNamesBinaryTarget(`targets = { p = { kind = "binary" } }`), true);
  assert.equal(textNamesBinaryTarget(`targets = { p = { kind = "lib" } }`), false);
});

test("platformKey maps the three platforms the index knows", () => {
  assert.equal(platformKey("linux"), "linux");
  assert.equal(platformKey("darwin"), "macosx");
  assert.equal(platformKey("win32"), "windows");
  assert.equal(platformKey("freebsd"), undefined);
});

test("compareVersions is a total order over the shapes this index publishes", () => {
  assert.ok(compareVersions("3.10", "3.9") > 0, "10 is after 9");
  assert.ok(compareVersions("1.0.0", "1.0") > 0, "a longer version is greater");
  assert.ok(compareVersions("1.0.0-rc1", "1.0.0") < 0, "a prerelease sorts below its release");
  assert.ok(compareVersions("1.6.43", "latest") > 0, "numbers rank above aliases");
  assert.ok(compareVersions("b10069.2", "b10069.1") > 0);
  assert.ok(compareVersions("b10069.10", "b10069.9") > 0);
  assert.equal(compareVersions("22.1.8.1", "22.1.8.1"), 0);
  assert.equal(compareVersions("1.0", "1.0"), 0);
});

test("latestVersion and versionsFor answer for one platform only", () => {
  const versions = { linux: ["0.2.4", "0.2.8", "0.2.10"], macosx: ["0.2.4"], windows: [] };
  assert.equal(latestVersion(versions, "linux"), "0.2.10");
  assert.equal(latestVersion(versions, "macosx"), "0.2.4");
  assert.equal(latestVersion(versions, "windows"), undefined, "no versions is not a version");
  assert.equal(latestVersion(versions, undefined), undefined, "an unknown platform guesses nothing");
  assert.deepEqual(versionsFor(versions, "linux"), ["0.2.10", "0.2.8", "0.2.4"]);
  assert.deepEqual(versionsFor(versions, undefined), []);
  assert.deepEqual(sortVersions(["3.2", "3.10"]), ["3.10", "3.2"]);
});

test("versionGroups puts the current platform first", () => {
  const versions = { windows: ["1.0"], linux: ["2.0"], macosx: ["1.5"] };
  assert.deepEqual(
    versionGroups(versions, "linux").map((group) => group.platform),
    ["linux", "windows", "macosx"],
  );
  assert.deepEqual(
    versionGroups(versions, undefined).map((group) => group.platform),
    ["windows", "linux", "macosx"],
  );
  // A copy, so a caller cannot mutate the model through it.
  const groups = versionGroups(versions, "linux");
  groups[0].versions.push("9.9");
  assert.deepEqual(versions.linux, ["2.0"]);
});
