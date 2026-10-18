import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { watchProjectFiles } from "../../src/library/projectWatcher";
import { projectDependencyState, readProjectDeclarations, dependencyLocation, operationMatches } from "../../src/library/projectState";

const loader = Module as unknown as { _load(request: string, parent: unknown, main: boolean): unknown };
let configured = "";
const vscodeStub = { workspace: { isTrusted: false, getConfiguration: () => ({ inspect: (key: string) => ({ globalValue: key === "library.indexPath" ? configured : undefined }) }) } };
const original = loader._load;
loader._load = function (request, parent, main) {
  return request === "vscode" ? vscodeStub : original.call(loader, request, parent, main);
};
const locator: typeof import("../../src/library/indexLocator") = createRequire(__filename)("../../src/library/indexLocator");
loader._load = original;

test("official discovery prefers new layout, never substitutes xim, and honors explicit paths", async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "mcpp-index-test-")));
  const make = async (relative: string) => fs.mkdir(path.join(home, relative, "pkgs"), { recursive: true });
  try {
    await make("registry/data/xim-pkgindex");
    assert.deepEqual(await locator.discoverIndexRoots("", home), []);
    await make("registry/data/mcpplibs");
    assert.equal((await locator.discoverIndexRoots("", home))[0].path, path.join(home, "registry/data/mcpplibs"));
    await make("indices/mcpplibs");
    const roots = await locator.discoverIndexRoots("", home);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].path, path.join(home, "indices/mcpplibs"));
    assert.equal(roots[0].kind, "official");
    const custom = await locator.discoverIndexRoots(path.join(home, "registry/data/xim-pkgindex/pkgs"), home);
    assert.equal(custom[0].kind, "custom");
    assert.equal(custom[0].site, undefined);
    assert.equal((await locator.discoverIndexRoots(path.join(home, "registry/data"), home)).length, 2);
    await assert.rejects(locator.discoverIndexRoots(path.join(home, "missing"), home), /No package index/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("project state distinguishes declarations, lock-only edges, source dependencies and ambiguous short names", () => {
  const catalog = ["compat.zlib", "other.zlib", "compat.argparse"];
  assert.equal(projectDependencyState("compat.zlib", [{ id: "zlib", version: "1", dev: false }], [], catalog).ambiguous, true);
  const state = projectDependencyState("compat.argparse", [{ id: "argparse", version: "3.2", dev: true }], [{ id: "compat.argparse", version: "3.1" }], catalog);
  assert.equal(state.declaredVersion, "3.2");
  assert.equal(state.resolvedVersion, "3.1");
  assert.equal(state.dev, true);
  const lockOnly = projectDependencyState("compat.zlib", [], [{ id: "compat.zlib", version: "1" }], catalog);
  assert.equal(lockOnly.declared, false);
  assert.equal(lockOnly.resolvedVersion, "1");
  assert.equal(projectDependencyState("compat.argparse", [{ id: "argparse", dev: false }], [], catalog).sourceType, "path-or-git");
});

test("async results cannot cross package, project or page lifetime", () => {
  const operation = { key: "a", projectRoot: "/one", generation: 1 };
  assert.equal(operationMatches(operation, { ...operation }), true);
  for (const page of [{ ...operation, key: "b" }, { ...operation, projectRoot: "/two" }, { ...operation, generation: 2 }]) {
    assert.equal(operationMatches(operation, page), false);
  }
});


test("catalog caching observes nested descriptor edits and reapplies fresh project declarations", async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "mcpp-snapshot-test-")));
  const previousHome = process.env.MCPP_HOME;
  process.env.MCPP_HOME = base;
  const directory = path.join(base, "indices/mcpplibs/pkgs/c");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "compat.argparse.lua");
  const descriptor = 'package = { name = "argparse", namespace = "compat", description = "before", xpm = { linux = { ["3.2"] = {} } } }';
  try {
    await fs.writeFile(file, descriptor);
    await fs.writeFile(path.join(base, "mcpp.toml"), '[package]\nname = "test"\n');
    locator.invalidateIndexCache();
    const first = await locator.loadSnapshot({ projectRoot: base });
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0].added, false);
    await fs.writeFile(path.join(base, "mcpp.toml"), '[dependencies.compat]\nargparse = "3.2"\n');
    const second = await locator.loadSnapshot({ projectRoot: base });
    assert.equal(second.revision, first.revision);
    assert.equal(second.entries[0].added, true);
    assert.equal(first.entries[0].added, false, "project overlays must not mutate cached entries");
    await fs.writeFile(file, descriptor.replace("before", "after edit"));
    const edited = await locator.loadSnapshot({ projectRoot: base });
    assert.notEqual(edited.revision, first.revision);
    assert.equal(edited.entries[0].description, "after edit");
    const other = path.join(base, "other/pkgs/c");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "compat.argparse.lua"), descriptor.replace("before", "other source"));
    configured = path.join(base, "other");
    const switched = await locator.loadSnapshot({ projectRoot: base });
    assert.equal(switched.entries[0].description, "other source");
  } finally {
    configured = "";
    if (previousHome === undefined) { delete process.env.MCPP_HOME; } else { process.env.MCPP_HOME = previousHome; }
    locator.invalidateIndexCache();
    await fs.rm(base, { recursive: true, force: true });
  }
});


test("project TOML reads quoted identities and does not treat a versioned source dependency as registry", () => {
  const text = `[dependencies]
"compat.argparse" = { path = "../parser#local", version = "3.2" }
[dev-dependencies.compat]
zlib = "1.3"
[target.linux.dependencies]
json = "1"
`;
  const declarations = readProjectDeclarations(text);
  const state = projectDependencyState("compat.argparse", declarations, [], ["compat.argparse"]);
  assert.equal(state.sourceType, "path-or-git");
  assert.equal(state.declaredVersion, "3.2");
  assert.equal(projectDependencyState("compat.zlib", declarations, [], ["compat.zlib"]).dev, true);
  assert.equal(projectDependencyState("json", declarations, [], ["json"]).ambiguous, true);
});


test("selected-project fallback observes disk changes and stops on disposal", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "mcpp-project-watch-")));
  await fs.writeFile(path.join(root, "mcpp.toml"), "before");
  let changes = 0;
  const watcher = watchProjectFiles(root, () => { changes++; }, 30);
  try {
    await fs.writeFile(path.join(root, "mcpp.toml"), "after edit");
    const start = Date.now();
    while (changes === 0 && Date.now() - start < 2000) { await new Promise((resolve) => setTimeout(resolve, 40)); }
    assert.ok(changes > 0);
    await watcher.check();
    await fs.writeFile(path.join(root, "mcpp.lock"), "transient lock");
    await watcher.check();
    const created = changes;
    await fs.rm(path.join(root, "mcpp.lock"));
    const removedAt = Date.now();
    while (changes === created && Date.now() - removedAt < 2000) { await new Promise((resolve) => setTimeout(resolve, 40)); }
    assert.ok(changes > created, "a lock seen by native events between polling ticks must still report deletion");
    watcher.dispose();
    const previous = changes;
    await fs.writeFile(path.join(root, "mcpp.lock"), "new lock");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(changes, previous);
  } finally { watcher.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});


test("build declarations have a separate identity and TOML destinations retain namespaces", () => {
  const declarations = readProjectDeclarations('[dependencies.compat]\nargparse = "3.1"\n[build-dependencies.compat]\nargparse = "3.2"\n');
  assert.equal(projectDependencyState("compat.argparse", declarations, [], ["compat.argparse"], "normal").declaredVersion, "3.1");
  assert.equal(projectDependencyState("compat.argparse", declarations, [], ["compat.argparse"], "build").declaredVersion, "3.2");
  assert.equal(projectDependencyState("compat.argparse", declarations, [], ["compat.argparse"], "dev").declared, false);
  assert.deepEqual(dependencyLocation("compat.argparse", "build"), { table: "build-dependencies.compat", name: "argparse" });
  assert.deepEqual(dependencyLocation("mcpplibs.cmdline", "dev"), { table: "dev-dependencies", name: "cmdline" });
});
