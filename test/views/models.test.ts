import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCacheTree,
  buildLanguageServerTree,
  buildProjectTree,
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

test("the project tree carries identity, toolchain and the four actions", () => {
  const tree = buildProjectTree({
    root: "/w",
    name: "greeter",
    version: "0.1.0",
    standard: "c++23",
    profile: "debug",
    toolchainSpec: "llvm@22.1.8",
    target: "x86_64-unknown-linux-gnu",
    targets: [{ name: "greet", kind: "bin" }],
  });
  assert.deepEqual(ids(tree), ["project.identity", "project.toolchain", "project.action.build", "project.action.run", "project.action.test", "project.action.clean"]);
  assert.deepEqual(find(tree, "project.identity")?.label.args, ["greeter", "0.1.0"]);
  assert.deepEqual(find(tree, "project.standard")?.description?.args, ["c++23"]);
  assert.deepEqual(find(tree, "project.toolchain")?.description?.args, ["llvm@22.1.8"]);
  assert.equal(find(tree, "project.target.greet")?.description?.args?.[0], "bin");
  assert.equal(find(tree, "project.action.build")?.command?.command, "mcpp.build");
  assert.equal(find(tree, "project.action.clean")?.command?.command, "mcpp.cleanProjectArtifacts");
});

test("a project without a toolchain says host default rather than inventing one", () => {
  const tree = buildProjectTree({ root: "/w" });
  assert.deepEqual(find(tree, "project.toolchain")?.description?.args, ["host default"]);
  assert.equal(find(tree, "project.standard"), undefined);
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

test("the C++ Modules view offers to install when the dependency is absent", () => {
  const tree = buildLanguageServerTree({ installed: false });
  assert.equal(tree[0].id, "ls.absent");
  assert.equal(tree[0].command?.command, "mcpp.openMcpplsSettings");
});

test("an unreadable state is stated without pretending to know the status", () => {
  const tree = buildLanguageServerTree({ installed: true, state: { available: false, reason: "no status yet" } });
  assert.deepEqual(find(tree, "ls.status")?.description?.args, ["no status yet"]);
  assert.equal(find(tree, "ls.status")?.icon, "question");
  assert.ok(find(tree, "ls.actions"));
});

test("a ready status renders profile, database and engines", () => {
  const tree = buildLanguageServerTree({
    installed: true,
    version: "0.0.9",
    enabled: true,
    state: {
      available: true,
      state: "ready",
      project: { source: "mcpp", level: 3 },
      profile: { compiler: "clang 22.1.8", stdlib: "libc++", target: "x86_64-linux-gnu" },
      engine: { name: "clangd", version: "23.1.0" },
      engines: [
        { name: "clangd", version: "23.1.0", role: "core", state: "ready" },
        { name: "mcppls", version: "0.0.9", role: "modules", state: "ready" },
      ],
    },
  });
  assert.equal(find(tree, "ls.status")?.icon, "pass-filled");
  assert.deepEqual(find(tree, "ls.database")?.description?.args, ["mcpp"]);
  assert.equal(find(tree, "ls.engines")?.children?.length, 2);
  assert.equal(find(tree, "ls.engine.clangd")?.icon, "check");
});

test("an issue carrying S3's own remedy becomes a clickable node", () => {
  const tree = buildLanguageServerTree({
    installed: true,
    state: {
      available: true,
      state: "degraded",
      issues: [
        {
          code: "producer-needs-download",
          message: "needs a download",
          command: { command: "mcppls.describeOnline", arguments: [], title: "Allow" },
        },
      ],
    },
  });
  const issue = find(tree, "ls.issue.0.producer-needs-download");
  assert.equal(issue?.command?.command, "mcppls.describeOnline");
  assert.deepEqual(issue?.command?.title, { key: "{0}", args: ["Allow"] });
});

test("an issue without a remedy stays informative and non-clickable", () => {
  const tree = buildLanguageServerTree({
    installed: true,
    state: { available: true, state: "degraded", issues: [{ code: "x", message: "y" }] },
  });
  assert.equal(find(tree, "ls.issue.0.x")?.command, undefined);
});

test("a disabled workspace says so next to the version", () => {
  const tree = buildLanguageServerTree({ installed: true, version: "0.0.9", enabled: false });
  assert.match(String(find(tree, "ls.identity")?.description?.args?.[1]), /disabled here/);
});
