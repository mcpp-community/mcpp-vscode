import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMcppTomlCompletions,
  type McppTomlSuggestion,
} from "../src/mcppTomlCompletion";

function labels(suggestions: McppTomlSuggestion[]): string[] {
  return suggestions.map((suggestion) => suggestion.label);
}

test("suggests section headers on a partial bracket line", () => {
  const suggestions = computeMcppTomlCompletions(["[dep"], 0, 4);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "section"));
  assert.ok(labels(suggestions).includes("[dependencies]"));
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

test("offers no static field keys (removed, waiting for upstream schema)", () => {
  // 静态字段键/枚举刻意不做：等上游版本化 manifest schema。
  assert.deepEqual(computeMcppTomlCompletions(["[package]", ""], 1, 0), []);
  assert.deepEqual(computeMcppTomlCompletions(["[package]", "standard = "], 1, 11), []);
  assert.deepEqual(computeMcppTomlCompletions(["[targets.app]", "kind = "], 1, 7), []);
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
