import assert from "node:assert/strict";
import test from "node:test";

import { format } from "../../src/i18n/translate";
import { buildCacheTree, buildProjectTree, type Label, type TreeNode } from "../../src/views/models";

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

test("an empty workspace says so and suggests the fix", () => {
  const tree = buildProjectTree(undefined);
  assert.deepEqual(ids(tree), ["project.none"]);
  assert.match(tree[0].tooltip?.key ?? "", /mcpp: New Project/);
});

test("an unreadable manifest is reported instead of half-rendered", () => {
  const tree = buildProjectTree({ root: "/w", error: "bad TOML" });
  assert.equal(tree[0].id, "project.error");
  assert.equal(tree[0].icon, "error");
  assert.deepEqual(tree[0].description?.args, ["bad TOML"]);
});

test("the project view is two labelled, expanded sections", () => {
  const tree = buildProjectTree({
    root: "/w",
    name: "greeter",
    version: "0.1.0",
    standard: "c++23",
    profile: "debug",
    toolchainSpec: "llvm@22.1.8",
    target: "x86_64-unknown-linux-gnu",
    targets: [{ name: "greet", kind: "bin" }],
    sourceFiles: 87,
  });
  assert.deepEqual(ids(tree), ["project.section.basic", "project.section.commands"]);
  assert.equal(find(tree, "project.section.basic")?.label.key, "Basics");
  assert.equal(find(tree, "project.section.commands")?.label.key, "Common commands");
  assert.equal(find(tree, "project.section.basic")?.expanded, true);
  assert.equal(find(tree, "project.section.commands")?.expanded, true);
});

test("the identity row carries the name, the standard and the source count", () => {
  const tree = buildProjectTree({ root: "/w", name: "greeter", version: "0.1.0", standard: "c++23", sourceFiles: 87 });
  const identity = find(tree, "project.package");
  assert.equal(identity?.label.key, "greeter");
  assert.equal(text(identity?.description), "c++23 · 87 source file(s)");
  // The version is still reachable, just not competing with the name.
  assert.match(text(identity?.tooltip), /0\.1\.0/);
  assert.equal(find(tree, "project.target"), undefined);
  assert.equal(find(tree, "project.toolchain")?.description?.args?.[0], "host default");
});

test("a standard without a source count still renders, and vice versa", () => {
  assert.equal(text(find(buildProjectTree({ root: "/w", standard: "c++23" }), "project.package")?.description), "c++23");
  assert.equal(
    text(find(buildProjectTree({ root: "/w", sourceFiles: 3 }), "project.package")?.description),
    "3 source file(s)",
  );
  assert.equal(find(buildProjectTree({ root: "/w" }), "project.package")?.description, undefined);
});

test("a project without a toolchain says host default rather than inventing one", () => {
  const tree = buildProjectTree({ root: "/w" });
  assert.deepEqual(find(tree, "project.toolchain")?.description?.args, ["host default"]);
  assert.equal(find(tree, "project.target"), undefined);
});

test("a project with no declared dependency has no dependency group", () => {
  assert.equal(find(buildProjectTree({ root: "/w" }), "project.dependencies"), undefined);
  assert.equal(
    find(buildProjectTree({ root: "/w", dependencies: [] }), "project.dependencies"),
    undefined,
  );
});

test("the cache tree separates project artifacts from the shared cache", () => {
  const tree = buildCacheTree({ projectRoot: "/w/target" });
  assert.deepEqual(ids(tree), ["cache.project", "cache.global.unknown"]);
  assert.equal(find(tree, "cache.project")?.contextValue, "mcppCacheProject");
  assert.equal(find(tree, "cache.global.unknown")?.command?.command, "mcpp.refreshCacheStats");
});

test("an unmeasured target/ offers to measure rather than showing a zero", () => {
  const tree = buildCacheTree({});
  assert.equal(find(tree, "cache.project.unread")?.command?.command, "mcpp.refreshCacheStats");
});

test("a missing target/ is stated, not shown as 0 bytes", () => {
  const tree = buildCacheTree({ artifacts: { exists: false, totalBytes: 0, files: 0, groups: 0 } });
  assert.equal(find(tree, "cache.project.absent")?.label.key, "No target/ directory");
});

test("a truncated estimate is labelled a lower bound", () => {
  const tree = buildCacheTree({
    artifacts: { exists: true, totalBytes: 1024, files: 3, groups: 2, truncated: "entries" },
  });
  assert.ok(find(tree, "cache.project.truncated"));
  assert.equal(find(tree, "cache.project.stale")?.command?.command, "mcpp.cleanStaleArtifacts");
});

test("the global cache shows kinds, ages, the largest packages and the actions", () => {
  const tree = buildCacheTree({
    inventory: {
      root: "/home/u/.mcpp/build-cache/v1",
      totalBytes: 7_736_306_884,
      totalEntries: 657,
      byKind: [
        { kind: "pkg", entries: 576, bytes: 7_000_000_000 },
        { kind: "std", entries: 81, bytes: 736_306_884 },
      ],
      topLabels: [{ label: "ns/name@1.0.0", entries: 5, bytes: 1_200_000_000 }],
      incomplete: 2,
      ageBuckets: [
        { fromDays: 0, toDays: 1, entries: 1, bytes: 10 },
        { fromDays: 30, entries: 2, bytes: 20 },
      ],
    },
  });
  assert.equal(find(tree, "cache.kind.pkg")?.description?.args?.[1], "576");
  assert.equal(find(tree, "cache.kind.std")?.icon, "library");
  assert.equal(find(tree, "cache.age.1")?.label.key, "more than {0} day(s) ago");
  assert.equal(find(tree, "cache.top.ns/name@1.0.0")?.command?.command, "mcpp.showCacheEntry");
  assert.deepEqual(find(tree, "cache.top.ns/name@1.0.0")?.command?.arguments, ["ns/name@1.0.0"]);
  assert.ok(find(tree, "cache.incomplete"));
  for (const id of ["cache.action.refresh", "cache.action.panel", "cache.action.gc", "cache.action.prune", "cache.action.verify"]) {
    assert.ok(find(tree, id), id);
  }
});

test("an empty cache has no largest-packages node", () => {
  const tree = buildCacheTree({
    inventory: { root: "/c", totalBytes: 0, totalEntries: 0, byKind: [], topLabels: [], incomplete: 0, ageBuckets: [] },
  });
  assert.equal(find(tree, "cache.top"), undefined);
  assert.equal(find(tree, "cache.incomplete"), undefined);
});

test("a pre-v1 cache is offered for removal only when it exists", () => {
  assert.equal(find(buildCacheTree({ legacyBytes: 0 }), "cache.legacy"), undefined);
  const tree = buildCacheTree({ legacyBytes: 175_000_000 });
  assert.equal(find(tree, "cache.legacy")?.command?.command, "mcpp.cleanLegacyCache");
});
