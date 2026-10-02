import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMcppTomlCompletions,
  type McppTomlSuggestion,
} from "../../src/toml/completion";
import { SCHEMA } from "../../src/toml/schema";

function labels(suggestions: McppTomlSuggestion[]): string[] {
  return suggestions.map((suggestion) => suggestion.label);
}

test("suggests section headers on a partial bracket line", () => {
  const suggestions = computeMcppTomlCompletions(["[dep"], 0, 4);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "section"));
  assert.ok(labels(suggestions).includes("[dependencies]"));
  assert.ok(labels(suggestions).includes("[build-dependencies]"));
  assert.ok(labels(suggestions).includes("[workspace]"));
  assert.ok(labels(suggestions).includes("[indices]"));
  // 每条建议都带显式替换范围（覆盖已输入的 "[dep"）。
  for (const suggestion of suggestions) {
    assert.deepEqual(suggestion.range, { startCharacter: 0, endCharacter: 4 });
  }
  // 参数化段插入 snippet。
  const targets = suggestions.find((suggestion) => suggestion.label === "[targets.<name>]");
  assert.equal(targets?.insertSnippet, "[targets.${1:name}]");
});

test("a section mcpp removed is never suggested, but an unmodelled one still is", () => {
  // 快照描述 mcpp 真正校验的 schema，是段与键的主要来源；手写清单只用来补上
  // mcpp 接受、快照尚未建模的段（例如 [workspace.dependencies]），
  // 所以「已移除」必须消失，「未建模」必须保留。
  const suggestions = labels(computeMcppTomlCompletions(["[xl"], 0, 3));
  assert.ok(!suggestions.includes("[xlings.envs]"), "a removed section came back");
  assert.ok(suggestions.includes("[xlings]"));
  assert.ok(suggestions.includes("[xlings.workspace]"), "an unmodelled but accepted section disappeared");
});

test("the header list is the snapshot with the curated labels and snippets", () => {
  const suggestions = computeMcppTomlCompletions(["[hooks"], 0, 6);
  // 快照的段都在（参数化段用清单里的写法），加上手写清单里快照没有的段。
  const names = labels(suggestions);
  assert.ok(suggestions.length >= SCHEMA.sections.length);
  assert.ok(names.includes("[workspace.dependencies]"), "an unmodelled but accepted section is missing");
  // 快照新增、手写清单没有的段也要出现。
  assert.ok(names.includes("[hooks]"));
  assert.ok(names.includes("[modules]"));
  assert.ok(names.includes("[c-abi]"));
  // 参数化段保留手写 snippet。
  assert.equal(
    suggestions.find((suggestion) => suggestion.label === "[targets.<name>]")?.insertSnippet,
    "[targets.${1:name}]",
  );
  // 废弃段带一条 documentation 指向替代写法。
  const language = suggestions.find((suggestion) => suggestion.label === "[language]");
  assert.match(language?.documentation ?? "", /\[package\]\.standard/);
});

test("offers nothing inside [[...]] array-table headers", () => {
  // mcpp manifest 不使用 TOML 数组表（[[...]]）：[[ 内不出建议，
  // 避免把用户意图的数组表悄悄替换成普通段 [x]。
  assert.deepEqual(computeMcppTomlCompletions(["[[dep"], 0, 5), []);
  assert.deepEqual(computeMcppTomlCompletions(["[[dependencies]"], 0, 3), []);
});

test("suggests section headers at the top of the document", () => {
  const suggestions = computeMcppTomlCompletions([""], 0, 0);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "section"));
});

test("offers nothing in unknown sections", () => {
  // 附录 A：不支持包自定义 toml 键；未知段不提供任何建议。
  assert.deepEqual(computeMcppTomlCompletions(["[mytool]", ""], 1, 0), []);
  assert.deepEqual(computeMcppTomlCompletions(["[mytool]", "key = "], 1, 6), []);
});

test("suggests schema keys inside a known section, skipping those already used", () => {
  const suggestions = computeMcppTomlCompletions(["[package]", 'name = "x"', ""], 2, 0);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "template"));
  const names = labels(suggestions);
  assert.ok(!names.includes("name"), "an already-used key must not be offered again");
  assert.ok(names.includes("standard"));
  assert.ok(names.includes("version"));

  const standard = suggestions.find((suggestion) => suggestion.label === "standard");
  assert.ok(standard);
  assert.equal(standard.insertSnippet, 'standard = "c++20"');
  assert.match(standard.detail, /enum/);
  assert.match(standard.detail, /c\+\+20/);
  assert.match(standard.detail, /default/);
  assert.deepEqual(standard.range, { startCharacter: 0, endCharacter: 0 });

  // 已用键按段归属剔除：上一段的 name 不得影响 [build]。
  const build = computeMcppTomlCompletions(["[package]", 'name = "x"', "", "[build]", ""], 4, 0);
  const buildNames = labels(build);
  assert.ok(buildNames.includes("sources"));
  assert.ok(!buildNames.includes("name"));
});

test("suggests enum values in the value position of a known enum key", () => {
  const bare = computeMcppTomlCompletions(["[package]", "standard = "], 1, 11);
  assert.deepEqual(labels(bare).slice(0, 3), ["c++20", "c++23", "c++26"]);
  assert.equal(bare[0].insertSnippet, '"c++20"');
  for (const suggestion of bare) {
    assert.deepEqual(suggestion.range, { startCharacter: 11, endCharacter: 11 });
  }

  // 光标已在字符串里：只替换内容，不再补引号。
  const inside = computeMcppTomlCompletions(["[package]", 'standard = "c++2'], 1, 17);
  assert.equal(inside[0].insertSnippet, "c++20");
  assert.deepEqual(inside[0].range, { startCharacter: 12, endCharacter: 16 });

  // [targets.<n>] 行表继承基段的枚举键。
  const targets = computeMcppTomlCompletions(["[targets.app]", "kind = "], 1, 7);
  assert.deepEqual(labels(targets), ["bin", "lib", "shared", "app"]);
});

test("offers no key suggestions in sections whose keys the user picks", () => {
  // [toolchain] 的 openKeys: true：平台名由用户自选，给出固定词表就是错的。
  assert.deepEqual(computeMcppTomlCompletions(["[toolchain]", ""], 1, 0), []);
  assert.deepEqual(computeMcppTomlCompletions(["[toolchain]", "gcc = "], 1, 6), []);
});

test("suggests dependency writing templates", () => {
  const suggestions = computeMcppTomlCompletions(["[dependencies]", ""], 1, 0);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "template"));
  const names = labels(suggestions);
  assert.ok(names.includes('name = "version"'));
  assert.ok(names.includes("name = { git = ..., tag = ... }"));
  assert.ok(names.includes("name = { version = ..., tools = [...] }"));
  assert.deepEqual(suggestions[0].range, { startCharacter: 0, endCharacter: 0 });
});

test("suggests dependency templates in conditional dependency sections", () => {
  const suggestions = computeMcppTomlCompletions(["[target.'cfg(windows)'.dependencies]", ""], 1, 0);
  assert.ok(labels(suggestions).includes('name = "version"'));
});

test("suggests dependency templates in build-dependencies", () => {
  const suggestions = computeMcppTomlCompletions(["[build-dependencies]", ""], 1, 0);
  assert.ok(labels(suggestions).includes('name = "version"'));
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "template"));
});

test("suggests templates in free-key sections", () => {
  const features = computeMcppTomlCompletions(["[features]", ""], 1, 0);
  assert.ok(features.every((suggestion) => suggestion.kind === "template"));
  assert.ok(labels(features).includes("name = { defines = [...] }"));

  const capabilities = computeMcppTomlCompletions(["[capabilities]", ""], 1, 0);
  assert.ok(labels(capabilities).includes('capability = "provider"'));

  const generated = computeMcppTomlCompletions(["[generated_files]", ""], 1, 0);
  assert.ok(labels(generated).includes('"path" = "content"'));
});

test("offers nothing at value positions", () => {
  // 版本候选等动态数据层落地前，值位置不出建议。
  assert.deepEqual(computeMcppTomlCompletions(["[dependencies]", 'zlib = "'], 1, 8), []);
  assert.deepEqual(computeMcppTomlCompletions(["[package]", 'name = "'], 1, 7), []);
});

test("offers nothing inside nested inline tables", () => {
  // containerPath 非空（内联表深处）不出建议。
  assert.deepEqual(computeMcppTomlCompletions(["[features]", "simd = { flags = [ { "], 1, 21), []);
});

test("replacement range covers a partially typed key", () => {
  const suggestions = computeMcppTomlCompletions(["[dependencies]", "na"], 1, 2);
  assert.ok(suggestions.length > 0);
  for (const suggestion of suggestions) {
    assert.deepEqual(suggestion.range, { startCharacter: 0, endCharacter: 2 });
  }
});
