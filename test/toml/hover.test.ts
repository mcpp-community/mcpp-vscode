import assert from "node:assert/strict";
import test from "node:test";

import { hoverAt } from "../../src/toml/hover";

test("hovers a section header with its plane, key count and doc link", () => {
  const info = hoverAt(["[package]", 'name = "x"'], 0, 3);
  assert.ok(info);
  assert.equal(info.title, "[package]");
  assert.match(info.body, /plane: `identity`/);
  assert.match(info.body, /keys: 20/);
  assert.match(info.documentation ?? "", /04-mcpp-toml\.md#21-package--package-metadata$/);
});

test("hovers a legacy section with what replaces it", () => {
  const info = hoverAt(["[language]"], 0, 2);
  assert.ok(info);
  assert.equal(info.title, "[language]");
  assert.match(info.body, /legacy: replaced by `\[package\]\.standard`/);
});

test("hovers a parameterized row header on its base section", () => {
  const info = hoverAt(["[targets.app]", 'kind = "lib"'], 0, 4);
  assert.ok(info);
  assert.equal(info.title, "[targets]");
  assert.match(info.body, /plane: `artifact`/);
  assert.match(info.documentation ?? "", /#22-targetsname--build-targets$/);
});

test("hovers a key with type, enum values, default and since", () => {
  const standard = hoverAt(["[package]", "standard = c++23"], 1, 3);
  assert.ok(standard);
  assert.equal(standard.title, "standard");
  assert.match(standard.body, /type: `enum`/);
  assert.match(standard.body, /c\+\+23/);
  assert.match(standard.body, /default: `"c\+\+23"`/);

  const mcpp = hoverAt(["[package]", 'mcpp = ">=2026.9.28.3"'], 1, 1);
  assert.ok(mcpp);
  assert.match(mcpp.body, /since: 2026\.9\.28\.3/);
  assert.match(mcpp.body, /release floor/);
});

test("hovers an unmodelled key with the inference caveat", () => {
  const info = hoverAt(["[build]", "flags = []"], 1, 2);
  assert.ok(info);
  assert.equal(info.title, "flags");
  assert.match(info.body, /unmodelled: the type is inferred/);
});

test("hovers an enum value with the value and its key's documentation", () => {
  const info = hoverAt(["[package]", "standard = c++23"], 1, 12);
  assert.ok(info);
  assert.equal(info.title, "c++23");
  assert.match(info.body, /enum value of `standard`/);
  assert.match(info.documentation ?? "", /04-mcpp-toml\.md#21/);
});

test("offers nothing outside a section, a known key or an enum value", () => {
  // 段在快照里没有键表：依赖名不是 schema 键。
  assert.equal(hoverAt(["[dependencies]", 'zlib = "1.0"'], 1, 10), undefined);
  // 未知段：不猜。
  assert.equal(hoverAt(["[mytool]", "x = 1"], 1, 1), undefined);
  // 非枚举键的值。
  assert.equal(hoverAt(["[package]", 'name = "x"'], 1, 10), undefined);
  // 空文档与越界光标。
  assert.equal(hoverAt([], 5, 5), undefined);
});

test("never throws on malformed input", () => {
  const inputs: string[][] = [
    [""],
    ["["],
    ["[", "]]", "= = ="],
    ["[package", "name"],
    ["[[x]]", "{"],
    ["[package]", 'name = "unterminated'],
  ];
  for (const lines of inputs) {
    assert.doesNotThrow(() => hoverAt(lines, 0, 99));
    assert.doesNotThrow(() => hoverAt(lines, 99, 99));
  }
});
