import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMcppTomlCompletions,
  computeMcppTomlCompletionsWithIndex,
  dependencyVersionContextAt,
  indexVersionSuggestions,
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

// ── 依赖版本补全（mcpp.toml.indexCompletion，默认关）────────────────────────
// 纯文本层只回答两件事：光标是不是在依赖的「版本值」上，候选怎么变成建议。
// 执行 `mcpp search`、超时、信任与缓存都在 src/toml/providers.ts。

test("locates a dependency version value in both spellings", () => {
  assert.deepEqual(dependencyVersionContextAt(["[dependencies]", 'zlib = "'], 1, 8), {
    name: "zlib",
    insideString: true,
    range: { startCharacter: 8, endCharacter: 8 },
  });

  // 长式 dep spec 的 version 字段。
  const long = dependencyVersionContextAt(["[dependencies]", 'zlib = { version = "1.'], 1, 26);
  assert.equal(long?.name, "zlib");
  assert.equal(long?.insideString, true);

  // 值还没开始输入：不算字符串内，插入时要补引号。
  const bare = dependencyVersionContextAt(["[dependencies]", "zlib = "], 1, 7);
  assert.equal(bare?.name, "zlib");
  assert.equal(bare?.insideString, false);
  assert.deepEqual(bare?.range, { startCharacter: 7, endCharacter: 7 });

  // 每个依赖段都算。
  for (const header of ["[dev-dependencies]", "[build-dependencies]", "[workspace.dependencies]", "[feature-deps.foo]"]) {
    assert.equal(
      dependencyVersionContextAt([header, 'zlib = "'], 1, 8)?.name,
      "zlib",
      header,
    );
  }
});

test("a git/path value, a non-dependency key or a key position is never a version", () => {
  assert.equal(dependencyVersionContextAt(["[dependencies]", 'zlib = { git = "htt'], 1, 21), undefined);
  assert.equal(dependencyVersionContextAt(["[dependencies]", 'zlib = { path = "..'], 1, 20), undefined);
  assert.equal(dependencyVersionContextAt(["[package]", 'name = "'], 1, 7), undefined);
  assert.equal(dependencyVersionContextAt(["[dependencies]", "zl"], 1, 2), undefined);
  assert.equal(dependencyVersionContextAt(["[not-a-section]", 'zlib = "'], 1, 8), undefined);
  // 值本身是内联表（dep spec 的容器）：在容器里是键位置，不是版本位置；
  // 已经写死的布尔/整数也不是版本。
  assert.equal(dependencyVersionContextAt(["[dependencies]", "zlib = { "], 1, 9), undefined);
  assert.equal(dependencyVersionContextAt(["[dependencies]", "zlib = true"], 1, 11), undefined);
});

test("index suggestions replace the value, quoting it only outside a string", () => {
  const context = dependencyVersionContextAt(["[dependencies]", 'zlib = "'], 1, 8);
  assert.ok(context !== undefined);
  const suggestions = indexVersionSuggestions(context, [
    { version: "1.3.2", summary: "A compression library" },
    { version: "1.2.9" },
  ]);
  assert.deepEqual(labels(suggestions), ["1.3.2", "1.2.9"]);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "version"));
  assert.equal(suggestions[0].insertSnippet, "1.3.2");
  assert.deepEqual(suggestions[0].range, context.range);
  assert.match(suggestions[0].detail, /zlib: A compression library/);

  const bare = dependencyVersionContextAt(["[dependencies]", "zlib = "], 1, 7);
  assert.ok(bare !== undefined);
  assert.equal(indexVersionSuggestions(bare, [{ version: "1.3.2" }])[0].insertSnippet, '"1.3.2"');
});

test("the async layer asks the index exactly once, only in a version position", async () => {
  const asked: string[] = [];
  const resolve = async (name: string): Promise<Array<{ version: string }>> => {
    asked.push(name);
    return [{ version: "1.3.2" }];
  };

  const versions = await computeMcppTomlCompletionsWithIndex(
    ["[dependencies]", 'zlib = "'],
    1,
    8,
    resolve,
  );
  assert.deepEqual(asked, ["zlib"]);
  assert.deepEqual(labels(versions), ["1.3.2"]);

  asked.length = 0;
  assert.deepEqual(
    await computeMcppTomlCompletionsWithIndex(["[dependencies]", 'zlib = { git = "htt'], 1, 21, resolve),
    [],
  );
  assert.deepEqual(asked, [], "a git value must not reach the index");

  // 静态层有建议（枚举值）时索引不被询问。
  asked.length = 0;
  const enumValues = await computeMcppTomlCompletionsWithIndex(["[package]", "standard = "], 1, 11, resolve);
  assert.deepEqual(labels(enumValues).slice(0, 3), ["c++20", "c++23", "c++26"]);
  assert.deepEqual(asked, []);
});

test("no resolver (the setting off) means no version suggestions", async () => {
  assert.deepEqual(await computeMcppTomlCompletionsWithIndex(["[dependencies]", 'zlib = "'], 1, 8), []);
});

test("a failing resolver degrades to no suggestions, never an error", async () => {
  const versions = await computeMcppTomlCompletionsWithIndex(
    ["[dependencies]", 'zlib = "'],
    1,
    8,
    async () => {
      throw new Error("mcpp search blew up");
    },
  );
  assert.deepEqual(versions, []);
});

test("a resolver that returns nothing leaves the value position empty", async () => {
  const versions = await computeMcppTomlCompletionsWithIndex(
    ["[dependencies]", 'zlib = "'],
    1,
    8,
    async () => [],
  );
  assert.deepEqual(versions, []);
});
