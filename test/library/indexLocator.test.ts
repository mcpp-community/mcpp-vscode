import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { projectDependencyState, operationMatches } from "../../src/library/projectState";

const loader = Module as unknown as { _load(request: string, parent: unknown, main: boolean): unknown };
const original = loader._load;
loader._load = function (request, parent, main) {
  return request === "vscode" ? {} : original.call(loader, request, parent, main);
};
const locator: typeof import("../../src/library/indexLocator") = createRequire(__filename)("../../src/library/indexLocator");
loader._load = original;

test("official discovery prefers new layout, never substitutes xim, and honors explicit paths", async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), "mcpp-index-test-"));
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
