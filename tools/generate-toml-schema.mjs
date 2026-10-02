#!/usr/bin/env node
// Generate data/toml-schema.json from an mcpp checkout.
//
// Sources (all read-only):
//   docs/specs/manifest-semantics.md  — SPEC-004 §2 plane table: which plane each
//                                       section belongs to.
//   docs/04-mcpp-toml.md              — field reference; its section headings give
//                                       the `doc` anchor for each section.
//   modules/manifest/src/toml.cppm    — the authoritative list of accepted section
//                                       names (the string literals the parser
//                                       compares against) plus the key lists it
//                                       checks (`kKnownPackageKeys`, ...). A
//                                       section mcpp stops accepting therefore
//                                       disappears from the schema.
//   mcpp.toml                         — [package] version -> sourceVersion.
//   git rev-parse --short HEAD        — sourceCommit (or "unknown").
//
// The checkout is `$MCPP_REPO`, defaulting to `../mcpp` next to this repository.
//
// The script fails loudly (exit 1) whenever a source cannot be read or yields
// nothing: it must never write an empty or partial schema. The output is
// deterministic — the same checkout produces byte-identical bytes (arrays are
// sorted, no timestamps, no environment data).
//
// ─────────────────────────────────────────────────────────────────────────────
// HAND-MAINTAINED, AND THE ONLY HAND-MAINTAINED PARTS
//
// Everything below the "HAND-MAINTAINED" banner is written by hand rather than
// parsed, because the mcpp checkout does not spell these out as data:
//
//   * PLANE_LABELS — the Chinese plane names of SPEC-004 §2 mapped to the
//     English vocabulary. An unknown label is a hard error, so a rewording of
//     the table is noticed instead of silently producing "unclassified".
//   * LEGACY_SECTIONS — sections docs/04 explicitly marks as a compatibility
//     layer, and what replaces them.
//   * OPEN_KEYS_SECTIONS — sections whose keys are user-chosen names rather
//     than a closed vocabulary (the diagnostics layer must not report those as
//     unknown keys).
//   * KEY_INFO — the enum vocabulary the docs describe but the source does not
//     spell out as a table (standard, kind, bmi_schedule, cache, cxx_runtime,
//     linkage, the Windows keys, the platform vocabulary, profile knobs,
//     toolchain family) plus a type for every key of a section that carries a
//     key table. Keys whose type cannot be expressed by the five-value
//     type vocabulary carry `unmodelled: true`.
//
// The *section list* is never hand-maintained: it comes from toml.cppm alone.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const MCPP_REPO = resolve(process.env.MCPP_REPO ?? join(REPO_ROOT, "..", "mcpp"));
const OUT_FILE = join(REPO_ROOT, "data", "toml-schema.json");

const DOC_BASE = "https://github.com/mcpp-community/mcpp/blob/main/docs/04-mcpp-toml.md";
const SPEC_FILE = "docs/specs/manifest-semantics.md";
const FIELD_DOC_FILE = "docs/04-mcpp-toml.md";
const PARSER_FILE = "modules/manifest/src/toml.cppm";

function fail(message) {
  process.stderr.write(`generate-toml-schema: ${message}\n`);
  process.exit(1);
}

function readSource(relPath) {
  const abs = join(MCPP_REPO, relPath);
  try {
    return readFileSync(abs, "utf8");
  } catch (error) {
    fail(`cannot read ${abs}: ${error?.message ?? error}`);
  }
}

// ─── read the mcpp [package] version ────────────────────────────────────────

function readPackageVersion(tomlText) {
  let section = "";
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== "package") continue;
    const assignment = /^version\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    if (assignment) return assignment[1];
  }
  return undefined;
}

function readSourceCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: MCPP_REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// ─── HAND-MAINTAINED: plane vocabulary ──────────────────────────────────────
// SPEC-004 §2 is written in Chinese; the schema uses an English vocabulary.
// Every row of the table must resolve here, otherwise the script exits 1.
const PLANE_LABELS = new Map([
  ["身份", "identity"],
  ["产物", "artifact"],
  ["编译", "compile"],
  ["库依赖", "dependency"],
  ["工具与环境", "tool"],
  ["门", "gate"],
  ["条件", "condition"],
  ["产物元数据", "metadata"],
  ["生命周期", "lifecycle"],
]);

// Sections the plane table does not name. The table is the spec's own closure
// claim ("a section MUST fall in one of these planes") but the parser reads
// more sections than the table lists, so the gap is surfaced as an explicit
// plane rather than invented away. A later revision of SPEC-004 can move a
// section out of this plane simply by adding it to §2.
const UNCLASSIFIED_PLANE = "unclassified";

// ─── HAND-MAINTAINED: legacy sections ───────────────────────────────────────
// docs/04 §4.1: `[language]` is the old configuration, `[package].standard` is
// authoritative when both are present.
const LEGACY_SECTIONS = new Map([["language", "[package].standard"]]);

// ─── HAND-MAINTAINED: sections whose keys are user-chosen names ─────────────
// `[toolchain]` is a platform -> spec map (`[toolchain] linux = "gcc@16"`) plus
// `bootstrap`, so its keys cannot be a closed list; the diagnostics layer skips
// unknown-key checking for these sections.
const OPEN_KEYS_SECTIONS = new Set(["toolchain"]);

// ─── HAND-MAINTAINED: enum vocabulary and key types ─────────────────────────
// C++ standards, docs/04 §2.1 (`c++2a`/`c++2c` are normalized aliases;
// `gnu++NN`, `c++latest` and the experimental `c++fly` are documented too).
const CXX_STANDARDS = [
  "c++20",
  "c++23",
  "c++26",
  "c++2a",
  "c++2c",
  "gnu++20",
  "gnu++23",
  "gnu++26",
  "c++latest",
  "c++fly",
];

// docs/04 §2.12: the platform vocabulary is fixed by mcpp.
const PLATFORMS = ["linux", "macos", "windows", "ios", "android", "emscripten"];

// docs/20 §"the toolchain": families of a managed spec. A `[toolchain]` entry
// *named by path* accepts only "gcc" or "llvm" (toml.cppm read_local_toolchain).
const TOOLCHAIN_FAMILIES = ["gcc", "llvm", "msvc", "emsdk", "android-ndk"];

// Keys are grouped by the section that owns them. For the four sections whose
// key list is generated from toml.cppm (package, targets, build, target), this
// table supplies the type/enum metadata for keys the parser names; a key the
// parser grows that is not listed here is emitted with `unmodelled: true`.
const KEY_INFO = {
  package: {
    accelerators: { type: "array", note: "accelerator backends the package supports (docs/04 §2.12b)" },
    authors: { type: "array" },
    "c-environment": { type: "string" },
    description: { type: "string" },
    exclusive: { type: "array" },
    license: { type: "string" },
    mcpp: {
      type: "string",
      since: "2026.9.28.3",
      note: 'release floor, only the ">=<release>" form is accepted (docs/04 §2.1)',
    },
    metadata: {
      type: "string",
      unmodelled: true,
      note: "table keyed by tool name; mcpp keeps it and does not interpret it",
    },
    name: { type: "string" },
    namespace: { type: "string" },
    platforms: { type: "enum", values: PLATFORMS, note: "array of platform names (docs/04 §2.12)" },
    provides: { type: "array" },
    repo: { type: "string" },
    requires: { type: "array" },
    requires_abi: { type: "array" },
    standard: {
      type: "enum",
      values: CXX_STANDARDS,
      default: "c++23",
      note: "c++2a/c++2c are aliases; gnu++NN, c++latest and c++fly are documented too",
    },
    "std-compat-module": { type: "string" },
    "std-module": { type: "string" },
    "std-module-flags": { type: "array" },
    version: { type: "string" },
  },
  targets: {
    cflags: { type: "array" },
    cxxflags: { type: "array" },
    defines: { type: "array" },
    exports: {
      type: "string",
      unmodelled: true,
      note: "a path to a symbol-pattern file, or an inline array of patterns (docs/04 §2.2)",
    },
    kind: {
      type: "enum",
      values: ["bin", "lib", "shared", "app"],
      since: "2026.9.12.3",
      note: '"app" requires mcpp 2026.9.12.3+; library/binary/dylib/so/shlib are accepted aliases',
    },
    linkage: { type: "enum", values: ["static", "shared"], since: "2026.9.15.2" },
    main: { type: "string" },
    required_features: { type: "array" },
    soname: { type: "string" },
    windows_code_page: { type: "enum", values: ["utf-8", "legacy"], since: "2026.9.26.1" },
    windows_entry: { type: "enum", values: ["main", "wmain", "WinMain", "wWinMain"], since: "2026.9.12.2" },
    windows_subsystem: { type: "enum", values: ["console", "windows"], since: "2026.9.12.2" },
  },
  build: {
    accel: { type: "string", note: "which device backends/architectures this build targets" },
    allow_host_libs: { type: "boolean" },
    bmi_schedule: {
      type: "enum",
      values: ["auto", "on", "off"],
      default: "auto",
      note: 'module-edge scheduling; "auto" currently means off',
    },
    build_program_timeout: { type: "number", default: 600, note: "seconds a build.mcpp may run; 0 = no limit" },
    c_standard: { type: "string", default: "c11" },
    cache: { type: "enum", values: ["global", "local", "off"], default: "global" },
    cflags: { type: "array" },
    cxxflags: { type: "array" },
    cxx_runtime: {
      type: "enum",
      values: ["self-contained", "toolchain-coupled", "host-coupled"],
      default: "self-contained",
      note: "docs/20; static_stdlib is the old spelling",
    },
    "default-profile": { type: "string", note: 'profile name, e.g. "release"' },
    defines: { type: "array" },
    dependency_linkage: { type: "enum", values: ["static", "shared"], default: "static" },
    dialect_cxxflags: { type: "array", since: "2026.9.28.1" },
    flags: { type: "array", unmodelled: true, note: "array of { glob, cflags, cxxflags, asmflags, defines } tables" },
    include_dirs: { type: "array" },
    include_dirs_after: { type: "array" },
    private_include_dirs: { type: "array" },
    ios_deployment_target: { type: "string" },
    jobs: {
      type: "enum",
      values: ["auto"],
      unmodelled: true,
      note: "a positive integer is accepted as well; the type is either",
    },
    ldflags: { type: "array" },
    macos_deployment_target: { type: "string" },
    module_extensions: { type: "array" },
    "platform-dependencies": { type: "string", note: "names a platform" },
    profile: { type: "string", note: "accepted alias of default-profile" },
    sources: { type: "array" },
    static_stdlib: { type: "boolean", legacy: true, note: "replaced by [build] cxx_runtime" },
    target: { type: "string", note: "default target triple when no --target is passed" },
    "std-compat-module": { type: "string" },
    "std-module": { type: "string" },
    "std-module-flags": { type: "array" },
  },
  target: {
    cxx_runtime: { type: "enum", values: ["self-contained", "toolchain-coupled", "host-coupled"] },
    linkage: { type: "enum", values: ["static", "shared"] },
    min_api_level: { type: "number" },
    runner: { type: "array", note: "argv template for mcpp run/test on this target" },
    sysroot: { type: "string" },
    toolchain: { type: "string" },
  },
  // Sections whose key list is not generated from a toml.cppm array, so the
  // keys themselves are hand-maintained here as well.
  lib: {
    path: { type: "string" },
  },
  test: {
    discover: { type: "array", note: "globs whose every match is one test program" },
  },
  language: {
    import_std: { type: "boolean", legacy: true, note: "replaced by [package].standard and the module scan" },
    modules: { type: "boolean", legacy: true, note: "replaced by the module scan" },
    standard: { type: "enum", values: CXX_STANDARDS, default: "c++23", legacy: true, note: "replaced by [package].standard" },
  },
  profile: {
    cflags: { type: "array" },
    cxxflags: { type: "array" },
    debug: { type: "boolean", note: "-g" },
    dependency_linkage: { type: "enum", values: ["static", "shared"] },
    ldflags: { type: "array" },
    lto: { type: "boolean", note: "-flto" },
    // docs/04 §2.9 spells the key `opt` (a number, or the string "s"/"z").
    opt: {
      type: "enum",
      values: ["s", "z"],
      unmodelled: true,
      note: 'an -O level: a number, or "s"/"z"',
    },
    strip: { type: "boolean", note: "-s at link time" },
  },
  resources: {
    "extra-inputs": { type: "array" },
    files: { type: "array" },
    icon: { type: "string" },
    "version-info": { type: "boolean" },
  },
  modules: {
    exports: { type: "array" },
    sources: { type: "array" },
    strict: { type: "boolean" },
  },
  pack: {
    "bundle-project": { type: "string", unmodelled: true, note: "table of fine-grained overrides" },
    debug_symbols: { type: "string" },
    default_mode: { type: "enum", values: ["static", "bundle-project", "bundle-all"] },
    exclude: { type: "array" },
    include: { type: "array" },
    strip: { type: "boolean" },
  },
  toolchain: {
    bootstrap: { type: "string", note: "managed spec for the toolchain that builds build programs" },
    default: { type: "string", note: "a platform key: a managed spec or `{ path = ... }`" },
    family: {
      type: "enum",
      values: TOOLCHAIN_FAMILIES,
      note: 'on a `[toolchain.<platform>]` entry table; a table named by `path` accepts only "gcc" or "llvm"',
    },
  },
};

// toml.cppm arrays that are the authoritative key list of a section; the array
// declarations are read by name so a renamed list is a hard error rather than a
// silently empty key table.
const GENERATED_KEY_LISTS = {
  package: ["kKnownPackageKeys"],
  targets: ["kKnownTargetKeys"],
  build: ["kKnownBuildKeys"],
  target: ["kKnownTargetScalars", "kKnownTargetArrays"],
};

// The manifest rules and their default severities. Ids match the diagnostics
// layer's rule names (src/toml/diagnostics.ts).
const RULES = [
  { id: "syntax", severity: "error" },
  { id: "unknown-section", severity: "warning" },
  { id: "unknown-key", severity: "warning" },
  { id: "plane-separation", severity: "warning" },
  { id: "mcpp-floor", severity: "error" },
  { id: "legacy-key", severity: "info" },
  { id: "array-table", severity: "error" },
];

// ─── parse SPEC-004 §2 (planes) ─────────────────────────────────────────────

function parsePlaneTable(specText) {
  const lines = specText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+2\.\s/.test(line));
  if (start < 0) fail(`${SPEC_FILE}: no "## 2." plane section`);

  const planes = new Map();
  let rows = 0;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    // ["", plane, sections, meaning, ""]
    if (cells.length < 4) continue;
    const label = cells[1];
    if (label === "" || label === "平面" || /^-+$/.test(label)) continue;
    const plane = PLANE_LABELS.get(label);
    if (!plane) fail(`${SPEC_FILE}: plane table row "${label}" has no English mapping`);
    const tokenPattern = /`\[([^\]]+)\]`/g;
    let match;
    let named = 0;
    while ((match = tokenPattern.exec(cells[2])) !== null) {
      const base = match[1].split(".")[0].trim();
      if (base === "") continue;
      planes.set(base, plane);
      named += 1;
    }
    if (named === 0) fail(`${SPEC_FILE}: plane table row "${label}" names no section`);
    rows += 1;
  }
  if (rows === 0) fail(`${SPEC_FILE}: plane table yielded no rows`);
  return planes;
}

// ─── parse docs/04 (doc anchors) ────────────────────────────────────────────

// GitHub's heading slug: lowercase, drop everything that is not a letter,
// number, space, underscore or hyphen, then each space becomes a hyphen.
// (Verified against an in-tree link: `dependency_linkage` — static … →
// #dependency_linkage--static-or-shared-is-the-consumers-decision.)
function headingSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

function parseDocAnchors(docText) {
  const anchors = new Map();
  for (const line of docText.split(/\r?\n/)) {
    const heading = /^#{2,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const title = heading[1].trim();
    const slug = headingSlug(title);
    const tokenPattern = /`\[([^\]]+)\]`/g;
    let match;
    while ((match = tokenPattern.exec(title)) !== null) {
      const raw = match[1].trim();
      const base = raw.split(".")[0].trim();
      if (base === "") continue;
      // A heading whose bracket is exactly the section name is preferred over
      // one that only mentions it (e.g. `[build]` over `[build] cache`).
      const exact = raw === base;
      const existing = anchors.get(base);
      if (existing === undefined || (exact && !existing.exact)) {
        anchors.set(base, { slug, exact });
      }
    }
  }
  if (anchors.size === 0) fail(`${FIELD_DOC_FILE}: no section headings yielded a doc anchor`);
  return anchors;
}

// ─── parse toml.cppm (sections and key lists) ───────────────────────────────

function extractTopLevelSections(parserText) {
  const names = new Set();
  const pattern =
    /(?:doc->(?:get|get_table|get_string|get_bool|get_int|get_string_array|get_int_array|contains)\("([^"]+)"\)|(?:load_deps|read_deps|assign_dep|load_nested_dep_table|load_selector_dep_table)\("([^"]+)")/g;
  let match;
  while ((match = pattern.exec(parserText)) !== null) {
    const path = match[1] ?? match[2];
    const base = path.split(".")[0].trim();
    if (base !== "") names.add(base);
  }
  if (names.size === 0) fail(`${PARSER_FILE}: no accepted section names found`);
  return names;
}

function extractStringArray(parserText, arrayName) {
  const block = new RegExp(
    `(?:static\\s+)?constexpr\\s+std::string_view\\s+${arrayName}\\s*\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`,
  ).exec(parserText);
  if (!block) fail(`${PARSER_FILE}: key list ${arrayName}[] not found`);
  const values = [];
  const literal = /"([^"]*)"/g;
  let match;
  while ((match = literal.exec(block[1])) !== null) {
    if (match[1] !== "") values.push(match[1]);
  }
  if (values.length === 0) fail(`${PARSER_FILE}: key list ${arrayName}[] is empty`);
  return values;
}

// ─── assemble ───────────────────────────────────────────────────────────────

function buildKey(section, key) {
  const info = KEY_INFO[section]?.[key];
  if (info === undefined) {
    // The parser grew a key the hand table has not caught up with. Emit it so
    // it is not reported as unknown, and say the type is a guess.
    return { key, type: "string", unmodelled: true };
  }
  const out = { key, type: info.type };
  if (info.values !== undefined) out.values = [...info.values];
  if (info.default !== undefined) out.default = info.default;
  if (info.since !== undefined) out.since = info.since;
  if (info.legacy === true) out.legacy = true;
  if (info.note !== undefined) out.note = info.note;
  if (info.unmodelled === true) out.unmodelled = true;
  return out;
}

function sectionKeys(section, parserText) {
  const listNames = GENERATED_KEY_LISTS[section];
  let keyNames;
  if (listNames !== undefined) {
    keyNames = [];
    for (const name of listNames) keyNames.push(...extractStringArray(parserText, name));
  } else {
    keyNames = Object.keys(KEY_INFO[section] ?? {});
  }
  keyNames = [...new Set(keyNames)].sort();
  if (keyNames.length === 0) return undefined;
  return keyNames.map((key) => buildKey(section, key));
}

function main() {
  const version = readPackageVersion(readSource("mcpp.toml"));
  if (!version) fail(`mcpp.toml: [package] version not found`);

  const planes = parsePlaneTable(readSource(SPEC_FILE));
  const anchors = parseDocAnchors(readSource(FIELD_DOC_FILE));
  const parserText = readSource(PARSER_FILE);
  const sectionNames = extractTopLevelSections(parserText);

  const sections = [...sectionNames].sort().map((name) => {
    const section = {
      header: `[${name}]`,
      name,
      plane: planes.get(name) ?? UNCLASSIFIED_PLANE,
      doc: anchors.has(name) ? `${DOC_BASE}#${anchors.get(name).slug}` : DOC_BASE,
      deprecatedBy: LEGACY_SECTIONS.get(name) ?? null,
    };
    if (OPEN_KEYS_SECTIONS.has(name)) section.openKeys = true;
    const keys = sectionKeys(name, parserText);
    if (keys !== undefined) section.keys = keys;
    return section;
  });

  // Refuse to write a schema that cannot drive anything: every section must be
  // named by the parser, and a plane table that matched nothing is a hard
  // error (parsePlaneTable already guarantees the latter).
  if (sections.length === 0) fail("no sections assembled");

  const schema = {
    sourceVersion: version,
    sourceCommit: readSourceCommit(),
    sections,
    rules: RULES,
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

  const keys = sections.reduce((total, section) => total + (section.keys?.length ?? 0), 0);
  process.stdout.write(
    `generate-toml-schema: wrote ${OUT_FILE}\n` +
      `  mcpp ${version} (${schema.sourceCommit}), ${sections.length} sections, ${keys} keys, ` +
      `${sections.filter((section) => section.plane === UNCLASSIFIED_PLANE).length} unclassified\n`,
  );
}

main();
