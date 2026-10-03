/**
 * The project view's layout: two labelled sections, the two-level dependency
 * group, the keybinding hints (read from `package.json`, never copied) and the
 * folded C++ Modules block.
 *
 * The block's whole reason to exist is the line *above* its chevron: a problem
 * has to be visible without expanding anything, so that is asserted directly.
 * The same applies to what must **not** be there — §8.2 removes `clangd` from the
 * view, and a test is the only way that removal stays removed.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { format } from "../../src/i18n/translate";
import * as models from "../../src/views/models";
import {
  buildProjectTree,
  countSourceFiles,
  formatKeybinding,
  keybindingsFromPackage,
  LANGUAGE_SERVICE_PROVIDER,
  parseLockfile,
  readDependencies,
  readLockfile,
  resolveLockedPackage,
  type Label,
  type LanguageServiceBlock,
  type TreeNode,
} from "../../src/views/models";

function ids(nodes: readonly TreeNode[]): string[] {
  return nodes.map((node) => node.id);
}

function find(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = node.children === undefined ? undefined : find(node.children, id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The label as the tree renders it: `t()` with the English text as the key. */
function text(label: Label | undefined): string {
  if (label === undefined) {
    return "";
  }
  return format(
    label.key,
    (label.args ?? []).map((argument) => (typeof argument === "object" ? text(argument) : argument)),
  );
}

function allText(nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(text(node.label), text(node.description), text(node.tooltip), text(node.command?.title));
    if (node.children !== undefined) {
      out.push(...allText(node.children));
    }
  }
  return out;
}

/* ---------------------------------------------------------------- commands */

const MANIFEST = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  contributes?: { keybindings?: Array<{ command: string; key?: string; mac?: string }> };
};
const BINDINGS = MANIFEST.contributes?.keybindings ?? [];
const HINTS = keybindingsFromPackage(MANIFEST);

test("the command section holds the nine common commands, in order", () => {
  const tree = buildProjectTree({ root: "/w" }, { keybindings: HINTS, platform: "mac" });
  assert.deepEqual(ids(find(tree, "project.section.commands")?.children ?? []), [
    // Creation first: it is the only row that does not act on *this* project.
    "project.action.new",
    "project.action.build",
    "project.action.run",
    "project.action.test",
    "project.action.clean",
    "project.action.toolchain",
    "project.action.librarySearch",
    "project.action.selfCheck",
    "project.action.settings",
  ]);
  for (const child of find(tree, "project.section.commands")?.children ?? []) {
    assert.ok(child.command, `${child.id} must be clickable`);
  }
  assert.equal(find(tree, "project.action.new")?.command?.command, "mcpp.newProject");
  assert.equal(find(tree, "project.action.librarySearch")?.command?.command, "mcpp.library.search");
  assert.equal(find(tree, "project.action.clean")?.command?.command, "mcpp.cleanProjectArtifacts");
  assert.equal(find(tree, "project.action.selfCheck")?.command?.command, "mcpp.selfCheck");
  assert.equal(find(tree, "project.action.settings")?.command?.command, "mcpp.openSettings");
});

test("every keybinding hint is the manifest's own, not a copy of it", () => {
  const tree = buildProjectTree({ root: "/w" }, { keybindings: HINTS, platform: "mac" });
  const bound: ReadonlyArray<readonly [string, string]> = [
    ["mcpp.build", "project.action.build"],
    ["mcpp.run", "project.action.run"],
    ["mcpp.test", "project.action.test"],
    ["mcpp.cleanProjectArtifacts", "project.action.clean"],
  ];
  for (const [command, id] of bound) {
    const binding = BINDINGS.find((entry) => entry.command === command);
    assert.ok(binding, `package.json must still bind ${command}`);
    assert.equal(
      text(find(tree, id)?.description),
      formatKeybinding(binding, "mac"),
      `${id} must show what package.json contributes for ${command}`,
    );
  }
  // A bare `mac`/`key` pair formats to the platform's own spelling.
  assert.equal(formatKeybinding({ key: "ctrl+alt+b", mac: "cmd+alt+b" }, "mac"), "⌘⌥B");
  assert.equal(formatKeybinding({ key: "ctrl+alt+b", mac: "cmd+alt+b" }, "other"), "Ctrl+Alt+B");
  assert.equal(formatKeybinding(undefined, "other"), undefined);
  assert.equal(formatKeybinding({}, "mac"), undefined);
});

test("a command without a binding carries no hint at all", () => {
  const tree = buildProjectTree({ root: "/w" }, { keybindings: HINTS, platform: "mac" });
  for (const id of ["project.action.toolchain", "project.action.librarySearch", "project.action.selfCheck", "project.action.settings"]) {
    assert.equal(find(tree, id)?.description, undefined, `${id} has no keybinding, so it has no hint`);
  }
});

/* ------------------------------------------------------------ dependencies */

const MANIFEST_LINES = [
  "[package]",
  'name = "greeter"',
  "",
  "[dependencies]",
  'mcpplibs.openkal = "0.14.0"',
  'compat.freetype = "2.13.3"',
  'compat.argparse = "3.2"',
  'counters = { path = "../counters" }',
  'codec = { git = "https://example.test/codec.git", tag = "v1" }',
  "",
  "[dev-dependencies]",
  'compat.gtest = "1.15.2"',
  "",
  "[dependencies.legacy]",
  'version = "9.9"',
].join("\n")
  .split("\n");

const LOCK_TEXT = [
  "# Auto-generated by mcpp. Do not edit by hand.",
  "version = 2",
  "",
  '[package."openkal"]',
  'namespace = "mcpplibs"',
  'version = "0.14.0"',
  'source  = "index+mcpplibs@0.14.0"',
  'hash    = "fnv1a:e235291048c1a3d8"',
  "",
  '[package."compat.freetype"]',
  'namespace = "compat"',
  'version = "2.13.3"',
  "",
].join("\n");

test("the manifest reader knows the short form, the inline table and the named table", () => {
  const declared = readDependencies(MANIFEST_LINES);
  assert.deepEqual(
    declared.map((entry) => entry.name),
    ["mcpplibs.openkal", "compat.freetype", "compat.argparse", "counters", "codec", "compat.gtest", "legacy"],
  );
  assert.equal(declared.find((entry) => entry.name === "mcpplibs.openkal")?.version, "0.14.0");
  assert.equal(declared.find((entry) => entry.name === "counters")?.path, "../counters");
  assert.equal(declared.find((entry) => entry.name === "codec")?.git, "https://example.test/codec.git");
  assert.equal(declared.find((entry) => entry.name === "compat.gtest")?.dev, true);
  assert.equal(declared.find((entry) => entry.name === "legacy")?.version, "9.9");
});

test("mcpp.lock is read flat, with both key spellings the real files use", () => {
  const locked = parseLockfile(LOCK_TEXT);
  assert.equal(locked.length, 2);
  assert.equal(locked[0].key, "openkal");
  assert.equal(locked[0].namespace, "mcpplibs");
  assert.equal(locked[0].source, "index+mcpplibs@0.14.0");
  assert.equal(locked[0].hash, "fnv1a:e235291048c1a3d8");
  // `[package."openkal"]` carries its namespace in a field…
  assert.equal(resolveLockedPackage(locked, "mcpplibs.openkal")?.version, "0.14.0");
  // …while `[package."compat.freetype"]` already folds it into the key.
  assert.equal(resolveLockedPackage(locked, "compat.freetype")?.version, "2.13.3");
  assert.equal(resolveLockedPackage(locked, "compat.absent"), undefined);
});

test("a missing or malformed lock file is empty, never an exception", () => {
  assert.deepEqual(readLockfile(path.join(tmpdir(), "mcpp-a6-absent-dir", "mcpp.lock")), []);
  assert.deepEqual(parseLockfile(""), []);
  assert.deepEqual(parseLockfile("<<< not toml at all >>>\n[[[package..\n"), []);
  assert.deepEqual(parseLockfile("version = 2\n[workspace]\nname = \"x\""), []);
  // A header with no fields is still a header: the entry exists, its version does not.
  assert.deepEqual(parseLockfile('[package."x"]'), [{ key: "x" }]);
});

test("the dependency group is two levels, marked and resolved, with no connector", () => {
  const declared = readDependencies(MANIFEST_LINES);
  const tree = buildProjectTree({ root: "/w", dependencies: declared }, { lock: parseLockfile(LOCK_TEXT) });
  const group = find(tree, "project.dependencies");
  assert.ok(group);
  assert.equal(text(group.label), "Dependencies (7)");
  assert.equal(text(group.description), "1 dev");
  assert.equal(group.expanded, true);
  assert.deepEqual(ids(group.children ?? []), declared.map((entry) => `project.dependency.${entry.name}`));
  assert.equal(group.tooltip?.key, "Declared in mcpp.toml; the resolved version comes from mcpp.lock.");

  // `mcpplibs.openkal` matches `[package."openkal"]` through the namespace field;
  // `compat.freetype` matches `[package."compat.freetype"]` through its key.
  assert.equal(text(find(tree, "project.dependency.mcpplibs.openkal")?.description), "Resolved 0.14.0");
  assert.equal(text(find(tree, "project.dependency.compat.freetype")?.description), "Resolved 2.13.3");
  assert.equal(text(find(tree, "project.dependency.compat.argparse")?.description), "Resolved —");
  assert.equal(text(find(tree, "project.dependency.counters")?.description), "path · ../counters · Resolved —");
  assert.equal(
    text(find(tree, "project.dependency.codec")?.description),
    "git · https://example.test/codec.git · Resolved —",
  );
  assert.equal(text(find(tree, "project.dependency.compat.gtest")?.description), "dev · Resolved —");
  assert.equal(find(tree, "project.dependency.counters")?.icon, "folder");
  assert.equal(find(tree, "project.dependency.compat.argparse")?.icon, "package");

  // Level 2 is the end of it: mcpp.lock has no parent/child edges, so a third
  // level (or a drawn connector) would be invented rather than read.
  const CONNECTOR = /[├└│─┌┐┘┬┴┼╰╭╯╮]/;
  for (const rendered of allText([group])) {
    assert.doesNotMatch(rendered, CONNECTOR, rendered);
  }
  for (const child of group.children ?? []) {
    assert.equal(child.children, undefined, `${child.id} must not have a third level`);
  }
});

test("the basics section ends with the dependencies and the language-service block", () => {
  const tree = buildProjectTree(
    { root: "/w", target: "x86_64-linux-gnu", dependencies: [{ name: "compat.zlib" }] },
    { lock: parseLockfile(LOCK_TEXT), languageService: { installed: false } },
  );
  assert.deepEqual(ids(find(tree, "project.section.basic")?.children ?? []), [
    "project.package",
    "project.target",
    "project.toolchain",
    "project.dependencies",
    "project.languageService",
  ]);
});

/* ------------------------------------------------------------- source count */

test("the source count skips the build directories instead of flattering itself", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mcpp-a6-src-"));
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "target", "debug"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(root, "src", "main.cpp"), "");
    writeFileSync(path.join(root, "src", "app.cppm"), "");
    writeFileSync(path.join(root, "src", "util.hpp"), "");
    writeFileSync(path.join(root, "src", "notes.txt"), "");
    writeFileSync(path.join(root, "target", "debug", "generated.cpp"), "");
    writeFileSync(path.join(root, "node_modules", "dep", "dep.cpp"), "");
    assert.equal(countSourceFiles(root), 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("counting a directory that does not exist is zero, not a throw", () => {
  assert.equal(countSourceFiles(path.join(tmpdir(), "mcpp-a6-absent-root")), 0);
});

/* -------------------------------------------------------- language service */

const HEALTHY: LanguageServiceBlock = {
  show: true,
  installed: true,
  version: "0.0.9",
  state: { available: true, state: "ready" },
};

const DEGRADED: LanguageServiceBlock = {
  show: true,
  installed: true,
  version: "0.0.9",
  state: {
    available: true,
    state: "degraded",
    issues: [{ code: "module-graph-stale", message: "The module graph needs rebuilding" }],
  },
};

test("a problem is visible without expanding the folded block", () => {
  const tree = buildProjectTree({ root: "/w" }, { languageService: DEGRADED });
  const row = find(tree, "project.languageService");
  assert.ok(row, "the block must be in the tree when the setting is on");
  // Collapsed: the tree provider only expands what the model marks expanded.
  assert.equal(row.expanded, undefined);
  assert.equal(row.icon, "warning");
  assert.equal(text(row.description), "mcppls 0.0.9 · 1 problem(s)");
  assert.equal(row.label.key, "Language service");
});

test("a healthy language service says so without a problem count", () => {
  const row = find(buildProjectTree({ root: "/w" }, { languageService: HEALTHY }), "project.languageService");
  assert.equal(row?.icon, "pass");
  assert.equal(text(row?.description), "mcppls 0.0.9");
});

test("the folded block hides entirely when its setting is off", () => {
  const tree = buildProjectTree({ root: "/w" }, { languageService: { ...HEALTHY, show: false } });
  assert.equal(find(tree, "project.languageService"), undefined);
  assert.equal(find(buildProjectTree({ root: "/w" }), "project.languageService"), undefined);
});

test("expanded, the block states the provider, each problem, four actions and the rest", () => {
  const row = find(buildProjectTree({ root: "/w" }, { languageService: DEGRADED }), "project.languageService");
  assert.deepEqual(ids(row?.children ?? []), [
    "project.languageService.status",
    "project.languageService.provider",
    "project.languageService.issue.0.module-graph-stale",
    "project.languageService.action.restart",
    "project.languageService.action.selectContext",
    "project.languageService.action.graph",
    "project.languageService.action.logs",
    "project.languageService.action.more",
  ]);
  assert.equal(text(find(row?.children ?? [], "project.languageService.status")?.label), "Degraded");
  const provider = find(row?.children ?? [], "project.languageService.provider");
  assert.equal(provider?.label.key, "Provided by");
  assert.equal(provider?.description?.key, LANGUAGE_SERVICE_PROVIDER);
  assert.equal(LANGUAGE_SERVICE_PROVIDER, "sunrisepeak.mcpp-language-server");
  assert.equal(
    text(find(row?.children ?? [], "project.languageService.issue.0.module-graph-stale")?.label),
    "The module graph needs rebuilding",
  );
  // §8.2's count: eleven actions, four of them permanent, the other seven folded.
  const more = find(row?.children ?? [], "project.languageService.action.more");
  assert.equal(text(more?.label), "More (7)…");
  assert.equal(more?.children?.length, 7);
  for (const child of more?.children ?? []) {
    assert.ok(child.command, `${child.id} must forward to mcppls`);
  }
});

test("the four common actions forward to mcppls and are always present", () => {
  const row = find(buildProjectTree({ root: "/w" }, { languageService: HEALTHY }), "project.languageService");
  const expected: ReadonlyArray<readonly [string, string]> = [
    ["project.languageService.action.restart", "mcpp.languageServer.restart"],
    ["project.languageService.action.selectContext", "mcpp.languageServer.selectContext"],
    ["project.languageService.action.graph", "mcpp.languageServer.showModuleGraph"],
    ["project.languageService.action.logs", "mcpp.languageServer.showLogs"],
  ];
  for (const [id, command] of expected) {
    assert.equal(find(row?.children ?? [], id)?.command?.command, command, id);
  }
});

test("the block never renders clangd, even when mcppls reports it", () => {
  // The state object is deliberately richer than the block's own type: mcppls's
  // real state carries engines and a semantic profile, and none of them may leak
  // into what the project view shows.
  const block = {
    show: true,
    installed: true,
    version: "0.0.9",
    state: {
      available: true,
      state: "ready",
      engine: { name: "clangd", version: "23.1.0" },
      engines: [{ name: "clangd", version: "23.1.0", role: "core", state: "ready" }],
      profile: { compiler: "clang 22.1.8", stdlib: "libc++", target: "x86_64-linux-gnu" },
      project: { root: "/w", source: "mcpp build-database" },
    },
  } as unknown as LanguageServiceBlock;
  const tree = buildProjectTree({ root: "/w" }, { languageService: block });
  for (const rendered of allText(tree)) {
    assert.doesNotMatch(rendered, /clangd/i, rendered);
  }
});

test("an installed-but-unreadable state keeps the reason on the row, not in the shown text", () => {
  const tree = buildProjectTree(
    { root: "/w" },
    { languageService: { show: true, installed: true, version: "0.0.9", state: { available: false, reason: "no status yet" } } },
  );
  const row = find(tree, "project.languageService");
  assert.equal(row?.icon, "warning");
  assert.equal(text(row?.tooltip), "no status yet");
  assert.equal(text(find(row?.children ?? [], "project.languageService.status")?.label), "Unavailable");
  assert.equal(text(find(row?.children ?? [], "project.languageService.status")?.description), "no status yet");
});

test("a missing C++ Modules offers to install itself, not to configure clangd", () => {
  const row = find(buildProjectTree({ root: "/w" }, { languageService: { show: true, installed: false } }), "project.languageService");
  const status = find(row?.children ?? [], "project.languageService.status");
  assert.equal(text(status?.label), "C++ Modules is not installed");
  assert.equal(status?.command?.command, "mcpp.openMcpplsSettings");
});

/* -------------------------------------------------------- deleted structure */

test("the standalone C++ Modules view is gone", () => {
  assert.equal((models as Record<string, unknown>).buildLanguageServerTree, undefined);
  const source = readFileSync(path.join(process.cwd(), "src", "views", "languageServerView.ts"), "utf8");
  assert.doesNotMatch(source, /LANGUAGE_SERVER_VIEW_ID/);
  assert.doesNotMatch(source, /createTreeView/);
  assert.match(source, /export function registerLanguageServerCommands\(/);
});
