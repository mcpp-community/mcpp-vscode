import assert from "node:assert/strict";
import test from "node:test";

import { format } from "../../src/i18n/translate";
import { buildProjectTree, type Label, type TreeNode } from "../../src/views/models";

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
  // The empty state names the situation and offers the one action that fits it:
  // `mcpp new` cannot initialise a folder that already exists, so there is no
  // "make this folder a project" row to add.
  assert.deepEqual(ids(tree), ["project.none", "project.action.new"]);
  assert.match(tree[0].tooltip?.key ?? "", /mcpp: New Project/);
});

test("an unreadable manifest is reported instead of half-rendered", () => {
  const tree = buildProjectTree({ root: "/w", error: "bad TOML" });
  assert.equal(tree[0].id, "project.error");
  assert.equal(tree[0].icon, "error");
  assert.deepEqual(tree[0].description?.args, ["bad TOML"]);
});

test("the project view is two labelled sections: commands open, basics folded", () => {
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
  // The sidebar opens on what can be *done*; 「基本信息」 is one click away.
  assert.equal(find(tree, "project.section.basic")?.expanded, undefined);
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
