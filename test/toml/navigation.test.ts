import assert from "node:assert/strict";
import test from "node:test";

import { definitionAt } from "../../src/toml/navigation";

test("workspace = true jumps to the same key in [workspace.dependencies]", () => {
  const lines = [
    "[dependencies]",
    "compat.zlib = { workspace = true }",
    "",
    "[workspace.dependencies]",
    'compat.zlib = "1.3.2"',
  ];
  // 光标在值 true 上，也在键 workspace 上：都应落到同名依赖键。
  assert.deepEqual(definitionAt(lines, 1, 30), {
    line: 4,
    startCharacter: 0,
    endCharacter: "compat.zlib".length,
  });
  assert.deepEqual(definitionAt(lines, 1, 20), {
    line: 4,
    startCharacter: 0,
    endCharacter: "compat.zlib".length,
  });
});

test("workspace = true also works in a table-per-dependency section", () => {
  const lines = ["[dependencies.foo]", "workspace = true", "", "[workspace.dependencies]", 'foo = "1"'];
  assert.deepEqual(definitionAt(lines, 1, 3), { line: 4, startCharacter: 0, endCharacter: 3 });

  const inline = ["[dependencies]", "foo = { workspace = true }", "", "[workspace.dependencies]", 'foo = "1"'];
  assert.deepEqual(definitionAt(inline, 1, 20), { line: 4, startCharacter: 0, endCharacter: 3 });
});

test("workspace = true without a matching workspace dependency jumps nowhere", () => {
  assert.equal(
    definitionAt(["[dependencies]", "foo = { workspace = true }"], 1, 20),
    undefined,
  );
});

test("a relative path jumps to the resolved manifest's [package] header", () => {
  const lines = ["[dependencies]", 'mylib = { path = "../mylib" }'];
  const seen: string[] = [];
  const found = definitionAt(lines, 1, 20, (relative) => {
    seen.push(relative);
    return 7;
  });
  assert.deepEqual(seen, ["../mylib"]);
  assert.deepEqual(found, { line: 7, startCharacter: 0, endCharacter: "[package]".length });
});

test("a path that the callback cannot resolve jumps nowhere", () => {
  const lines = ["[dependencies]", 'mylib = { path = "../mylib" }'];
  assert.equal(definitionAt(lines, 1, 20, () => undefined), undefined);
  // 回调可省略：纯函数在主 manifest 内没有任何目标可指。
  assert.equal(definitionAt(lines, 1, 20), undefined);
});

test("absolute paths and non-dependency path keys are left alone", () => {
  const absolute = ["[dependencies]", 'mylib = { path = "/opt/mylib" }'];
  assert.equal(definitionAt(absolute, 1, 20, () => 3), undefined);

  const lib = ["[lib]", 'path = "src/x.cppm"'];
  assert.equal(definitionAt(lib, 1, 3, () => 3), undefined);
});

test("features = [...] jumps to the header of the element under the cursor", () => {
  const lines = [
    "[dependencies]",
    'fmt = { features = ["simd", "gpu"] }',
    "",
    "[features.simd]",
    "defines = []",
  ];
  assert.deepEqual(definitionAt(lines, 1, 21), {
    line: 3,
    startCharacter: 0,
    endCharacter: "[features.simd]".length,
  });
  // 光标在 "gpu" 上，但没有 [features.gpu]。
  assert.equal(definitionAt(lines, 1, 31), undefined);
});

test("ordinary positions have no definition", () => {
  assert.equal(definitionAt(["[package]", 'name = "x"'], 1, 10), undefined);
  assert.equal(definitionAt(["[dependencies]", 'zlib = "1.0"'], 1, 10), undefined);
  assert.equal(definitionAt([], 3, 3), undefined);
});

test("never throws on malformed input", () => {
  const inputs: string[][] = [
    [""],
    ["["],
    ["[", "]]", "= = ="],
    ["[dependencies]", 'foo = { path = "../'],
    ["[[x]]", "{"],
  ];
  for (const lines of inputs) {
    assert.doesNotThrow(() => definitionAt(lines, 0, 99, () => 0));
    assert.doesNotThrow(() => definitionAt(lines, 99, 99));
  }
});
