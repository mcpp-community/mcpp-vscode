import assert from "node:assert/strict";
import test from "node:test";

import {
  BADGE_UI,
  badgesOf,
  bracedBody,
  codeSnippets,
  declaredDependencies,
  declaredDependencyEntries,
  descriptorDependencies,
  descriptorEntry,
  descriptorId,
  exampleCatalog,
  hasCnMirror,
  idFromFileName,
  installedFor,
  lockPackageVersions,
  mergeSurfaces,
  openkalFacetFor,
  parseDescriptorLua,
  parseOpenkalJson,
  parseSearchOutput,
  parseSelfEnv,
  searchText,
  stripLuaComments,
  surfaceFromDescriptorText,
  surfaceLabel,
  syntheticUsageLines,
  tokenizeCppLine,
  topLevelEntries,
  usageLines,
  usageLinesFor,
  versionsFromDescriptorText,
  type LibraryEntry,
} from "../../src/library/indexModel";
import { SURFACE_TEXT, compareVersions, parseXpkgJsonValue } from "../../src/library/xpkg";

// The descriptor shapes below are copied from the installed index, not invented:
// `compat.argparse` and friends are real `mcpplibs` descriptors.

const ARGPARSE = `-- compat.argparse — argparse is header-only.
package = {
    spec        = "1",
    namespace   = "compat",
    name        = "argparse",
    description = "argparse — header-only argument parser for modern C++",
    licenses    = {"MIT"},
    repo        = "https://github.com/p-ranav/argparse",
    type        = "package",

    xpm = {
        linux = {
            ["3.2"] = {
                url    = "https://example.invalid/argparse-3.2.tar.gz",
                sha256 = "abc",
            },
        },
        windows = {
            ["3.2"] = { url = "https://example.invalid/w.tar.gz" },
        },
    },
    mcpp = {
        language     = "c++23",
        import_std   = false,
        include_dirs = { "*/include" },
        sources      = { "mcpp_generated/argparse_anchor.c" },
    },
}`;

test("parseDescriptorLua reads the single-line catalog fields", () => {
  const fields = parseDescriptorLua(ARGPARSE);
  assert.equal(fields.namespace, "compat");
  assert.equal(fields.name, "argparse");
  assert.equal(fields.description, "argparse — header-only argument parser for modern C++");
  assert.deepEqual(fields.licenses, ["MIT"]);
  assert.equal(fields.repo, "https://github.com/p-ranav/argparse");
});

test("parseDescriptorLua reads a descriptor whose fields share one line", () => {
  // `compat.ffmpeg.lua` writes `spec = "1", namespace = "compat", name = "ffmpeg",`
  // on one line — the shape an anchored `^key =` regex misses.
  const text = `package = {
    spec = "1", namespace = "compat", name = "ffmpeg",
    description = "FFmpeg 8.1.2 multimedia libraries", licenses = {"LGPL-2.1-or-later"}, repo = "https://ffmpeg.org",
    xpm = { linux = { ["8.1.2"] = { url = "x" } } },
}`;
  const fields = parseDescriptorLua(text);
  assert.equal(fields.namespace, "compat");
  assert.equal(fields.name, "ffmpeg");
  assert.deepEqual(fields.licenses, ["LGPL-2.1-or-later"]);
  assert.equal(fields.repo, "https://ffmpeg.org");
});

test("parseDescriptorLua ignores comments and nested tables", () => {
  const text = `-- namespace = "wrong"
package = {
    name = "right",
    -- description = "also wrong",
    xpm = {
        linux = { name = "nested", kind = "bin" },
    },
}`;
  const fields = parseDescriptorLua(text);
  assert.equal(fields.name, "right");
  assert.equal(fields.namespace, undefined);
  // A nested `name` is not the package name, and a nested key is not a field.
  assert.equal(fields.description, undefined);
});

test("parseDescriptorLua omits a field it cannot read, and never throws", () => {
  const multiline = `package = {
    name = "x",
    description = "starts here
        and ends elsewhere",
    licenses = {
        "MIT",
        "Apache-2.0",
    },
    repo = 'https://example.invalid',
}`;
  const fields = parseDescriptorLua(multiline);
  assert.equal(fields.name, "x");
  assert.equal(fields.description, undefined, "a value across lines is omitted, not guessed");
  assert.deepEqual(fields.licenses, ["MIT", "Apache-2.0"]);
  assert.equal(fields.repo, "https://example.invalid", "single-quoted strings are read");
});

test("malformed descriptors degrade to an empty field set", () => {
  for (const text of ["", "not lua at all", "package = {", "package = }", '{ name = "unterminated']) {
    const fields = parseDescriptorLua(text);
    assert.deepEqual(fields.licenses, []);
    assert.equal(typeof fields, "object");
  }
});

test("stripLuaComments keeps string contents and drops comments", () => {
  const text = `a = "x -- not a comment" -- a comment with { brace
b = 1 --[[ long
comment ]] c = 2`;
  const clean = stripLuaComments(text);
  assert.match(clean, /x -- not a comment/);
  assert.doesNotMatch(clean, /a comment with/);
  assert.doesNotMatch(clean, /long/);
  assert.match(clean, /c = 2/);
});

test("bracedBody and topLevelEntries stop at the matching brace", () => {
  const text = `{ key = "a } b", inner = { x = 1 }, other = "y" }`;
  const block = bracedBody(text, 0);
  assert.ok(block !== undefined);
  const entries = topLevelEntries(block.body);
  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["key", "inner", "other"],
  );
  assert.equal(entries[0].value, "a } b");
});

test("idFromFileName splits at the last dot and descriptorId honours INV-NAME", () => {
  assert.deepEqual(idFromFileName("compat.argparse.lua"), { namespace: "compat", name: "argparse" });
  assert.deepEqual(idFromFileName("llmapi.lua"), { name: "llmapi" });
  assert.deepEqual(idFromFileName("huxerui.huxerui.lua"), { namespace: "huxerui", name: "huxerui" });

  // The real `huxerui.huxerui.lua` declares its name fully qualified.
  const huxerui = parseDescriptorLua(`package = { namespace = "huxerui", name = "huxerui.huxerui" }`);
  assert.equal(descriptorId(huxerui, "huxerui.huxerui.lua").id, "huxerui.huxerui");

  // The odd `mcpplibs.capi.lua.lua` is right because its own fields are read.
  const capi = parseDescriptorLua(`package = { namespace = "mcpplibs", name = "capi" }`);
  assert.equal(descriptorId(capi, "mcpplibs.capi.lua.lua").id, "mcpplibs.capi");

  // With no fields at all, the file name is the fallback.
  const none = parseDescriptorLua("-- nothing");
  assert.equal(descriptorId(none, "boost-ext.ut.lua").id, "boost-ext.ut");
});

test("hasCnMirror sees both `CN =` and `[\"CN\"] =`", () => {
  assert.equal(hasCnMirror(`url = { CN = "https://gitcode.com/x" }`), true);
  assert.equal(hasCnMirror(`url = { ["CN"] = "https://gitcode.com/x" }`), true);
  assert.equal(hasCnMirror(`-- CN = "https://gitcode.com/x"`), false);
  assert.equal(hasCnMirror(`url = { GLOBAL = "https://github.com/x" }`), false);
});

test("versionsFromDescriptorText reads every platform, aliases and non-semver tags", () => {
  assert.deepEqual(versionsFromDescriptorText(ARGPARSE), { linux: ["3.2"], windows: ["3.2"] });

  const single = `xpm = {
    linux = {
        ['0.2.3'] = { url = "x" },
    },
}`;
  assert.deepEqual(versionsFromDescriptorText(single), { linux: ["0.2.3"] });

  const alias = `xpm = {
    linux = {
        deps = { "xim:zlib@1.3.1" },
        ["latest"] = { ref = "1.6.43" },
        ["1.6.43"] = { url = "x" },
    },
}`;
  const versions = versionsFromDescriptorText(alias);
  assert.deepEqual(versions.linux, ["1.6.43"], "the alias is not a version; the ref is");

  const checkpoint = `xpm = {
    linux = {
        ["b10069.2"] = { url = "x" },
        ["b10069.1"] = { url = "y" },
    },
}`;
  // A non-semver revision is a version — `mcpp add` accepts what the descriptor publishes.
  assert.deepEqual(versionsFromDescriptorText(checkpoint).linux.sort(), ["b10069.1", "b10069.2"]);
  assert.deepEqual(versionsFromDescriptorText("package = { name = 'x' }"), {});
});

test("surfaceFromDescriptorText follows the site generator's SURFACES order", () => {
  assert.equal(surfaceFromDescriptorText(`sources = { "*/src/**/*.cppm" }`), "module");
  assert.equal(surfaceFromDescriptorText(`targets = { x = { kind = "bin" } }`), "tool");
  assert.equal(surfaceFromDescriptorText(`sources = { "a.c" }, include_dirs = { "inc" }`), "header");
  assert.equal(surfaceFromDescriptorText(`mcpp = { include_dirs = { "*/include" } }`), "header");
  assert.equal(surfaceFromDescriptorText(`xpm = { linux = { ["1.0"] = { url = "x" } } }`), "external");
  // A comment must not become a fact about the package.
  assert.equal(surfaceFromDescriptorText(`-- sources = { "x.cppm" }\nxpm = { }`), "external");
  assert.equal(surfaceFromDescriptorText(`targets = { y = { kind = "lib" } }`), undefined);
  // A descriptor whose fields cannot be read gets to claim nothing at all.
  assert.equal(surfaceFromDescriptorText("-- nothing readable"), undefined);
});

test("mergeSurfaces lets the parse lead and the text add a tool target", () => {
  const info = parseXpkgJsonValue({ namespace: "compat", name: "protobuf", sources: ["a.cc"], targets: ["protobuf"] });
  assert.ok(info !== undefined);
  assert.deepEqual(mergeSurfaces(info, `targets = { protoc = { kind = "bin" } }`), ["header", "tool"]);
  assert.deepEqual(mergeSurfaces(info, `sources = { "a.cc" }`), ["header"]);
  // The text may not talk the parse out of its own answer: `compat.ftxui` mentions
  // a feature-gated `.cppm`, which is not the package's surface.
  const header = parseXpkgJsonValue({ name: "ftxui", sources: ["a.cc"], include_dirs: ["inc"] });
  assert.ok(header !== undefined);
  assert.deepEqual(mergeSurfaces(header, `features = { modules = { sources = { "*/src/*.cppm" } } }`), ["header"]);
});

test("descriptorDependencies reads the declared edges in both shapes", () => {
  assert.deepEqual(descriptorDependencies(`deps = { ["compat.vulkan"] = "1.4.357.3" }`), [
    { id: "compat.vulkan", version: "1.4.357.3" },
  ]);
  assert.deepEqual(descriptorDependencies(`deps = { "xim:gtk4@4.16.13", "xim:glib@2.88.3" }`), [
    { id: "xim:gtk4", version: "4.16.13" },
    { id: "xim:glib", version: "2.88.3" },
  ]);
  assert.deepEqual(descriptorDependencies(`deps = { ["compat.x"] = { version = "1.2" } }`), [
    { id: "compat.x", version: "1.2" },
  ]);
  assert.deepEqual(descriptorDependencies("package = { name = 'x' }"), []);
});

test("declaredDependencies mirrors the generator's _collect_dependencies", () => {
  assert.deepEqual(declaredDependencies(`[dependencies.compat]\nargparse = "3.2"`), ["compat.argparse"]);

  // Sorted: the answer is a set, so the unqualified name and the default-namespace
  // form are both present, in a stable order.
  assert.deepEqual(declaredDependencies(`[dependencies]\ntinyhttps = "1.0"`), ["mcpplibs.tinyhttps", "tinyhttps"]);

  assert.deepEqual(declaredDependencies(`[dependencies]\ncompat = { argparse = "3.2" }`), ["compat.argparse"]);

  assert.deepEqual(declaredDependencies(`[dependencies]\ncompat = {\n    argparse = "3.2",\n}`), ["compat.argparse"]);

  assert.deepEqual(
    declaredDependencies(`[dev-dependencies]\ncatch2 = "3.5"\n[dependencies.mcpplibs]\ncmdline = "0.3.1"`),
    ["catch2", "mcpplibs.catch2", "mcpplibs.cmdline"],
  );
  assert.deepEqual(declaredDependencies(`[dependencies]\nzlib = "1.0"\nalpha = "2.0"`), [
    "alpha",
    "mcpplibs.alpha",
    "mcpplibs.zlib",
    "zlib",
  ]);

  assert.deepEqual(
    declaredDependencies(`[target.'cfg(linux)'.dependencies.ocornut]\nimgui = "1.0"`),
    ["ocornut.imgui"],
  );

  // A commented-out dependency is not declared.
  assert.deepEqual(declaredDependencies(`[dependencies]\n# argparse = "3.2"`), []);

  // A qualifier outside any dependencies table is not a dependency.
  assert.deepEqual(declaredDependencies(`[package]\nname = "x"\nversion = "1.0"`), []);
});

test("declaredDependencyEntries keeps the constraint and the dev flag (§22)", () => {
  const entries = declaredDependencyEntries([
    "[dependencies]",
    'tinyhttps = "1.0"',
    'compat = { argparse = "3.2" }',
    'counters = { path = "../counters" }',
    "[dev-dependencies]",
    'catch2 = "3.5"',
    'counters = { path = "../counters" }',
  ].join("\n"));
  assert.deepEqual(entries, [
    { id: "tinyhttps", version: "1.0", dev: false },
    { id: "compat.argparse", version: "3.2", dev: false },
    { id: "counters", dev: false },
    { id: "catch2", version: "3.5", dev: true },
    { id: "counters", dev: true },
  ]);
  // A multi-line source table is joined before it is read, and an already
  // qualified key stays qualified.
  const multiline = declaredDependencyEntries(
    ["[dependencies]", "backend = {", '  git = "https://example.invalid/x.git",', '  branch = "main"', "}", 'mcpplibs.cmdline = "0.3.1"'].join("\n"),
  );
  assert.deepEqual(multiline, [
    { id: "backend", dev: false },
    { id: "mcpplibs.cmdline", version: "0.3.1", dev: false },
  ]);
});

test("lockPackageVersions reads the lock mcpp actually writes", () => {
  // Shape copied from a real mcpp.lock (format version 2, written by
  // mcpp 2026.9.30.2): one [package."<name>"] table with namespace/version.
  const lock = [
    "# Auto-generated by mcpp. Do not edit by hand.",
    "version = 2",
    "",
    '[package."openkal"]',
    'namespace = "mcpplibs"',
    'version = "0.12.0"',
    'source  = "index+mcpplibs@0.12.0"',
    'hash    = "fnv1a:c37ee3e201991c70"',
    "",
    '[package."openkal-emscripten"]',
    'namespace = "mcpplibs"',
    'version = "0.1.0"',
    "",
    '[package."bare"]',
    'version = "1.0"',
    "",
    "[other]",
    'version = "9.9"',
  ].join("\n");
  assert.deepEqual(lockPackageVersions(lock), [
    { id: "mcpplibs.openkal", version: "0.12.0" },
    { id: "mcpplibs.openkal-emscripten", version: "0.1.0" },
    { id: "bare", version: "1.0" },
  ]);
  // A lock without a single readable package is an empty answer, not an error.
  assert.deepEqual(lockPackageVersions(""), []);
  assert.deepEqual(lockPackageVersions("not toml at all\n"), []);
});

test("installedFor: the manifest first, the lock second, short keys included (§20.1)", () => {
  const toml = '[dependencies]\nargparse = "3.2"\n[dev-dependencies]\ncatch2 = "3.5"\ncounters = { path = "../counters" }';
  // The lock's key is the short name with the namespace beside it — the shape
  // a real mcpp.lock writes; the fully-qualified key form is read too.
  const lock = '[package."cmdline"]\nnamespace = "mcpplibs"\nversion = "0.3.1"';

  // The manifest's short key is the answer for the dotted index id.
  assert.deepEqual(installedFor("compat.argparse", toml, lock), { version: "3.2", dev: false });
  assert.deepEqual(installedFor("catch2", toml, lock), { version: "3.5", dev: true });
  // A path dependency names no version, so the lock answers for index deps.
  assert.deepEqual(installedFor("mcpplibs.cmdline", toml, lock), { version: "0.3.1", dev: false });
  // The manifest wins when both speak.
  const both = installedFor("compat.argparse", toml, '[package."argparse"]\nnamespace = "compat"\nversion = "3.0"');
  assert.deepEqual(both, { version: "3.2", dev: false });
  // A path-only dependency the lock cannot know either: not installed as far
  // as an exact version is concerned.
  assert.equal(installedFor("counters", toml, lock), undefined);
  assert.equal(installedFor("compat.zlib", toml, lock), undefined);
});

const EXAMPLE_MANIFEST = `[package]
name = "argparse-tests"
version = "0.1.0"

[dependencies.compat]
argparse = "3.2"
`;

test("exampleCatalog maps a package to the project that demonstrates it", () => {
  const catalog = exampleCatalog([
    { project: "zlib", text: `[dependencies]\ncompat = { zlib = "1.0" }\n`, sources: ["tests/examples/zlib/tests/a.cpp"] },
    { project: "argparse", text: EXAMPLE_MANIFEST, sources: ["tests/examples/argparse/tests/parse.cpp"] },
    // No test file means the generator skips the project entirely.
    { project: "empty", text: EXAMPLE_MANIFEST, sources: [] },
  ]);
  const ref = catalog.get("compat.argparse");
  assert.ok(ref !== undefined);
  assert.equal(ref.project, "argparse");
  assert.equal(ref.path, "tests/examples/argparse/tests/parse.cpp");
  assert.deepEqual(ref.paths, ["tests/examples/argparse/tests/parse.cpp"]);
  assert.equal(ref.count, 1);
  assert.equal(catalog.get("compat.zlib")?.project, "zlib");
});

test("usageLines finds the interface lines and nothing else", () => {
  const lines = usageLines([
    {
      path: "a.cpp",
      text: [
        "// import std;",
        "import compat.argparse;",
        "  #include <argparse/argparse.hpp>",
        "int main() { return 0; }",
        '#include "local.h"',
      ].join("\n"),
    },
  ]);
  assert.deepEqual(
    lines.map((line) => [line.line, line.text]),
    [
      [2, "import compat.argparse;"],
      [3, "  #include <argparse/argparse.hpp>"],
      [5, '#include "local.h"'],
    ],
  );
});

test("usageLinesFor keeps only the lines that name this package", () => {
  const files = [
    {
      path: "a.cpp",
      text: [
        "import std;",
        "import compat.argparse;",
        "#include <argparse/argparse.hpp>",
        "import mcpplibs.cmdline;",
      ].join("\n"),
    },
    { path: "b.cpp", text: "#include <argparse/argparse.hpp>" },
  ];
  assert.deepEqual(usageLinesFor(files, "compat.argparse"), [
    "import compat.argparse;",
    "#include <argparse/argparse.hpp>",
  ]);
  // The dotted id matches too, and a package nothing names gets nothing.
  assert.deepEqual(usageLinesFor(files, "compat.zlib"), []);
  assert.deepEqual(usageLinesFor(files, "mcpplibs.cmdline"), ["import mcpplibs.cmdline;"]);
});

test("syntheticUsageLines: the module form names the package, the header form stays a placeholder", () => {
  // The module name is the dotted id — nlohmann.json's descriptor says so in
  // as many words ("exposed as the C++23 module nlohmann.json") — except the
  // default mcpplibs namespace, whose packages export their short name:
  // measured in a real project (import openkal.types;) and in cmdline.
  assert.deepEqual(syntheticUsageLines(["module"], "nlohmann.json"), ["import nlohmann.json;"]);
  assert.deepEqual(syntheticUsageLines(["module"], "mcpplibs.openkal"), ["import openkal;"]);
  assert.deepEqual(syntheticUsageLines(["module", "tool"], "mcpplibs.cmdline"), ["import cmdline;"]);
  // A header package's real path lives in the upstream archive and cannot be
  // known offline, so the index site's own placeholder answers, not an
  // invented path.
  assert.deepEqual(syntheticUsageLines(["header"], "compat.argparse"), ["#include <foo.h>"]);
  assert.deepEqual(syntheticUsageLines(["tool"], "flex"), []);
  assert.deepEqual(syntheticUsageLines(["external"], "ut"), []);
});

test("codeSnippets windows the interface line, merges overlaps and caps itself", () => {
  const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n").replace("line 5", "import a.b;");
  const snippets = codeSnippets([{ path: "a.cpp", text }], { context: 2, maxSnippets: 1, maxLines: 6 });
  assert.equal(snippets.length, 1);
  assert.equal(snippets[0].usageLine, 5);
  assert.equal(snippets[0].startLine, 3);
  assert.deepEqual(snippets[0].lines, ["line 3", "line 4", "import a.b;", "line 6", "line 7"]);

  const many = Array.from({ length: 20 }, (_, index) => (index % 4 === 0 ? `import m${index};` : `x${index}`)).join("\n");
  assert.ok(codeSnippets([{ path: "b.cpp", text: many }], { maxSnippets: 2 }).length <= 2);
  assert.deepEqual(codeSnippets([{ path: "c.cpp", text: "int main() {}" }]), []);
});

test("tokenizeCppLine classifies without losing a character", () => {
  const line = '#include <argparse/argparse.hpp> // note "x"';
  const tokens = tokenizeCppLine(line);
  assert.equal(tokens.map((token) => token.text).join(""), line, "tokens must tile the line exactly");
  const kinds = new Map(tokens.map((token) => [token.text, token.kind]));
  assert.equal(kinds.get("#"), "punctuation");
  assert.equal(kinds.get("include"), "keyword");
  assert.equal(kinds.get("// note \"x\""), "comment");
  assert.equal(kinds.get("<"), "punctuation");

  const stringLine = 'const char* s = "hello // not a comment";';
  const stringKinds = new Map(tokenizeCppLine(stringLine).map((token) => [token.text, token.kind]));
  assert.equal(stringKinds.get('"hello // not a comment"'), "string");
  assert.equal(stringKinds.get("const"), "keyword");

  const code = "import std; // trailing";
  const codeKinds = tokenizeCppLine(code).map((token) => `${token.kind}:${token.text}`);
  assert.deepEqual(codeKinds, ["keyword:import", "plain: std", "punctuation:;", "plain: ", "comment:// trailing"]);
  assert.deepEqual(tokenizeCppLine(""), []);
});

const OPENKAL = JSON.stringify({
  measured: "2026-09-23",
  members: {
    argparse: {
      packages: ["compat.argparse"],
      portable: true,
      targets: { "x86_64-linux-gnu": { kind: "posix", status: "runs" } },
    },
    "build-only": {
      packages: ["compat.buildonly"],
      portable: true,
      targets: { "x86_64-linux-gnu": { kind: "platform", status: "builds" } },
    },
    glfw: {
      packages: ["compat.glfw"],
      portable: true,
      targets: {
        "x86_64-linux-gnu": { kind: "posix", status: "runs" },
        "x86_64-windows-musl": { kind: "platform", status: "runs" },
      },
    },
  },
});

test("openkalFacetFor reads the measurement, never a descriptor field", () => {
  const index = parseOpenkalJson(OPENKAL);
  assert.ok(index !== undefined);
  assert.deepEqual(openkalFacetFor(index, "compat.argparse"), { level: "compat", kind: "posix" });
  // `builds` is not `runs`: the site files such a package under neither level.
  assert.deepEqual(openkalFacetFor(index, "compat.buildonly"), { kind: "platform" });
  // `platform` wins over `posix`: the package-level kind is the strictest target.
  assert.deepEqual(openkalFacetFor(index, "compat.glfw"), { level: "compat", kind: "platform" });
  assert.equal(openkalFacetFor(index, "compat.unknown"), undefined);
  // The family list is separate from the measurement file.
  assert.deepEqual(openkalFacetFor(index, "mcpplibs.openkal"), { level: "ecosystem" });
});

test("openkal parsing degrades to undefined", () => {
  assert.equal(parseOpenkalJson("not json"), undefined);
  assert.equal(parseOpenkalJson("{}"), undefined);
  assert.equal(parseOpenkalJson(`{"members": "nope"}`), undefined);
  const partial = parseOpenkalJson(`{"members": {"m": {"packages": ["a.b"]}}}`);
  assert.deepEqual(partial?.members.m, { packages: ["a.b"], portable: true, targets: {} });
  assert.equal(openkalFacetFor(undefined, "a.b"), undefined);
});

test("badgesOf shows the site's badges, in the site's order", () => {
  assert.deepEqual(badgesOf({ hasExamples: true }), ["examples"]);
  assert.deepEqual(badgesOf({ hasCnMirror: true }), ["cn"]);
  assert.deepEqual(badgesOf({ openkal: { level: "ecosystem", kind: "platform" } }), [
    "openkal-ecosystem",
    "openkal-platform",
  ]);
  assert.deepEqual(badgesOf({ hasExamples: true, hasCnMirror: true, openkal: { level: "compat", kind: "posix" } }), [
    "examples",
    "cn",
    "openkal-compat",
    "openkal-posix",
  ]);
  assert.deepEqual(badgesOf({}), []);
  for (const key of Object.keys(BADGE_UI)) {
    assert.equal(typeof BADGE_UI[key as keyof typeof BADGE_UI].fallback, "string");
  }
});

test("surfaceLabel falls back to the vocabulary the site emits untranslated", () => {
  assert.equal(surfaceLabel("module", () => "MODULE"), "import");
  assert.equal(surfaceLabel("header", () => "HEADER"), "#include");
  assert.equal(surfaceLabel("tool", () => "TOOL"), "tool");
  assert.equal(surfaceLabel("external", (key) => (key === SURFACE_TEXT.external.uiKey ? "上游 mcpp.toml" : key)), "上游 mcpp.toml");
  assert.equal(surfaceLabel("external", (key) => key), "upstream mcpp.toml");
});

function entry(id: string, fields: Partial<LibraryEntry> = {}): LibraryEntry {
  const dot = id.indexOf(".");
  return {
    id,
    ...(dot > 0 ? { namespace: id.slice(0, dot) } : {}),
    name: dot > 0 ? id.slice(dot + 1) : id,
    licenses: [],
    registry: "mcpplibs",
    file: `/index/pkgs/x/${id}.lua`,
    surfaces: [],
    hasCnMirror: false,
    hasExamples: false,
    versions: {},
    added: false,
    ...fields,
  };
}

test("descriptorEntry assembles a row and omits what it does not know", () => {
  const item = descriptorEntry({
    fileName: "compat.argparse.lua",
    registry: "mcpplibs",
    file: "/index/pkgs/c/compat.argparse.lua",
    text: ARGPARSE,
    platform: "linux",
    example: { project: "argparse", path: "p.cpp", paths: ["p.cpp"], count: 1 },
    openkal: { level: "compat", kind: "posix" },
    added: true,
  });
  assert.equal(item.id, "compat.argparse");
  assert.equal(item.surface, "header");
  assert.equal(item.version, "3.2");
  assert.equal(item.hasExamples, true);
  assert.equal(item.added, true);
  assert.deepEqual(item.openkal, { level: "compat", kind: "posix" });
  assert.deepEqual(item.example?.paths, ["p.cpp"]);

  const bare = descriptorEntry({
    fileName: "mystery.lua",
    registry: "xim-pkgindex",
    file: "/index/pkgs/m/mystery.lua",
    text: "-- nothing readable",
  });
  assert.equal(bare.id, "mystery");
  assert.equal(bare.unreadable, true);
  assert.equal(bare.description, undefined);
  assert.equal(bare.surface, undefined);
});

test("parseSearchOutput reads mcpp search's human output tolerantly", () => {
  const output = [
    "  compat:argparse       argparse — header-only argument parser for modern C++  (3.2)",
    "  xim:libpng            Official PNG reference library",
    "garbage line without an id",
    "  compat:argparse       duplicate of the line above (3.2)",
    "",
  ].join("\n");
  assert.deepEqual(parseSearchOutput(output), [
    { id: "compat.argparse", description: "argparse — header-only argument parser for modern C++", version: "3.2" },
    { id: "xim.libpng", description: "Official PNG reference library" },
  ]);
  assert.deepEqual(parseSearchOutput(""), []);
  assert.deepEqual(parseSearchOutput("nothing to see"), []);
});

test("parseSelfEnv reads only the machine envelope it recognises", () => {
  // The real answer from `mcpp self env --format json` (abridged).
  const real = JSON.stringify({
    data: {
      buildCache: "/home/u/.mcpp/build-cache/v1",
      mcppHome: "/home/u/.mcpp",
      mcppVersion: "2026.10.1.3",
      registry: "/home/u/.mcpp/registry",
    },
    diagnostics: [],
    effects: [],
    kind: "mcpp.env",
    kindVersion: 1,
    mcpp: { protocol: { max: 1, min: 1 }, version: "2026.10.1.3" },
    schemaVersion: 1,
  });
  assert.deepEqual(parseSelfEnv(real), { mcppHome: "/home/u/.mcpp", registry: "/home/u/.mcpp/registry" });

  // A machine shape that is not this one is refused rather than guessed at.
  assert.equal(parseSelfEnv('{"data":{"mcppHome":"/x"},"kind":"mcpp.cache","schemaVersion":1}'), undefined);
  assert.equal(parseSelfEnv('{"kind":"mcpp.env","schemaVersion":1}'), undefined);
  assert.equal(parseSelfEnv('{"data":{"mcppHome":"/x"},"kind":"mcpp.env"}'), undefined, "no schemaVersion");
  assert.equal(
    parseSelfEnv('{"data":{"mcppHome":"/x"},"kind":"mcpp.env","schemaVersion":"1"}'),
    undefined,
    "a string schemaVersion is not a document we can trust",
  );
  assert.equal(parseSelfEnv("mcpp home is /x"), undefined);
  assert.equal(parseSelfEnv(""), undefined);
  // An empty string is not a directory.
  assert.deepEqual(parseSelfEnv('{"data":{"mcppHome":"  "},"kind":"mcpp.env","schemaVersion":1}'), {});
});

test("compareVersions orders numbers numerically and aliases last", () => {
  assert.ok(compareVersions("1.10", "1.9") > 0);
  assert.ok(compareVersions("3.2", "3.10") < 0);
  assert.ok(compareVersions("1.6.43", "latest") > 0);
  assert.ok(compareVersions("b10069.2", "b10069.1") > 0);
  assert.equal(compareVersions("3.2", "3.2"), 0);
});
