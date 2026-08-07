import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMcppTomlCompletions,
  normalizeSectionGroup,
  type McppTomlSuggestion,
} from "../src/mcppTomlCompletion";

function labels(suggestions: McppTomlSuggestion[]): string[] {
  return suggestions.map((suggestion) => suggestion.label);
}

test("normalizes plain section headers", () => {
  assert.equal(normalizeSectionGroup("package"), "package");
  assert.equal(normalizeSectionGroup("build"), "build");
  assert.equal(normalizeSectionGroup("dependencies"), "dependencies");
});

test("normalizes parameterized section headers", () => {
  assert.equal(normalizeSectionGroup("targets.myapp"), "targets");
  assert.equal(normalizeSectionGroup("profile.dist"), "profile");
  assert.equal(normalizeSectionGroup("feature-deps.backend-openblas"), "feature-deps");
  assert.equal(normalizeSectionGroup("dependencies.mcpplibs"), "dependencies");
});

test("normalizes target-triple sections with and without subtables", () => {
  assert.equal(normalizeSectionGroup("target.x86_64-linux-musl"), "target");
  assert.equal(normalizeSectionGroup("target.'cfg(windows)'.build"), "build");
  assert.equal(normalizeSectionGroup("target.x86_64-linux-gnu.feature-deps.codegen"), "feature-deps");
});

test("rejects unknown headers", () => {
  assert.equal(normalizeSectionGroup("bogus"), undefined);
  assert.equal(normalizeSectionGroup(""), undefined);
});

test("suggests section headers on a partial bracket line", () => {
  const suggestions = computeMcppTomlCompletions(["[dep"], 0, 4);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "section"));
  assert.ok(labels(suggestions).includes("[dependencies]"));
  assert.ok(labels(suggestions).includes("[package]"));
  // 参数化段用占位符显示，插入时是可跳转的 snippet。
  const targets = suggestions.find((suggestion) => suggestion.label === "[targets.<name>]");
  assert.equal(targets?.insertSnippet, "[targets.${1:name}]");
});

test("suggests section headers at the top of the document", () => {
  const suggestions = computeMcppTomlCompletions([""], 0, 0);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "section"));
});

test("suggests package keys inside [package]", () => {
  const suggestions = computeMcppTomlCompletions(["[package]", ""], 1, 0);
  const names = labels(suggestions);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "key"));
  for (const expected of ["name", "version", "standard", "description", "license", "authors", "repo", "platforms", "provides"]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test("suggests target keys inside [targets.<name>]", () => {
  const suggestions = computeMcppTomlCompletions(["[targets.myapp]", ""], 1, 0);
  const names = labels(suggestions);
  for (const expected of ["kind", "main", "soname", "defines", "cxxflags", "cflags", "required_features"]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test("suggests enum values for package.standard", () => {
  const suggestions = computeMcppTomlCompletions(["[package]", "standard = "], 1, 11);
  const values = labels(suggestions);
  assert.ok(suggestions.every((suggestion) => suggestion.kind === "value"));
  for (const expected of ["c++20", "c++23", "c++26", "c++latest", "c++fly"]) {
    assert.ok(values.includes(expected), `missing ${expected}`);
  }
  // 光标不在字符串内：字符串枚举带引号插入。
  const cpp23 = suggestions.find((suggestion) => suggestion.label === "c++23");
  assert.equal(cpp23?.insertSnippet, '"c++23"');
});

test("does not double-quote values when already inside a string", () => {
  const suggestions = computeMcppTomlCompletions(["[package]", 'standard = "c++2'], 1, 15);
  const cpp23 = suggestions.find((suggestion) => suggestion.label === "c++23");
  assert.equal(cpp23?.insertSnippet, "c++23");
});

test("suggests target kind values", () => {
  const suggestions = computeMcppTomlCompletions(["[targets.myapp]", "kind = "], 1, 7);
  assert.deepEqual(labels(suggestions), ["bin", "lib", "shared"]);
});

test("suggests cxx_runtime and cache values inside [build]", () => {
  const runtime = computeMcppTomlCompletions(["[build]", "cxx_runtime = "], 1, 14);
  assert.deepEqual(labels(runtime), ["self-contained", "toolchain-coupled", "host-coupled"]);

  const cache = computeMcppTomlCompletions(["[build]", "cache = "], 1, 8);
  assert.deepEqual(labels(cache), ["global", "local", "off"]);
});

test("suggests boolean values for boolean keys", () => {
  const suggestions = computeMcppTomlCompletions(["[profile.dist]", "lto = "], 1, 6);
  assert.deepEqual(labels(suggestions), ["true", "false"]);
});

test("suggests dependency spec keys inside an inline table", () => {
  const suggestions = computeMcppTomlCompletions(["[dependencies]", "mylib = { "], 1, 10);
  const names = labels(suggestions);
  for (const expected of ["version", "path", "git", "tag", "branch", "rev", "features", "backend", "tools", "host-module", "reexport"]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test("suggests feature spec keys inside a feature inline table", () => {
  const suggestions = computeMcppTomlCompletions(["[features]", "fast_math = { "], 1, 14);
  const names = labels(suggestions);
  for (const expected of ["defines", "implies", "sources", "requires", "provides", "flags"]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test("suggests writing templates in free-key sections", () => {
  // [dependencies] 的键是包名，属于开放词汇，改为提供常用写法模板。
  const dependencies = computeMcppTomlCompletions(["[dependencies]", ""], 1, 0);
  assert.ok(dependencies.length > 0);
  assert.ok(dependencies.every((suggestion) => suggestion.kind === "template"));
  const dependencyLabels = labels(dependencies);
  assert.ok(dependencyLabels.includes('name = "version"'));
  assert.ok(dependencyLabels.includes("name = { path = ... }"));
  assert.ok(dependencyLabels.includes("name = { git = ..., tag = ... }"));
  const version = dependencies.find((suggestion) => suggestion.label === 'name = "version"');
  assert.equal(version?.insertSnippet, '${1:name} = "${2:1.0.0}"');

  const features = computeMcppTomlCompletions(["[features]", ""], 1, 0);
  assert.ok(features.every((suggestion) => suggestion.kind === "template"));
  assert.ok(labels(features).includes("name = { defines = [...] }"));

  const generated = computeMcppTomlCompletions(["[generated_files]", ""], 1, 0);
  assert.ok(generated.every((suggestion) => suggestion.kind === "template"));

  const capabilities = computeMcppTomlCompletions(["[capabilities]", ""], 1, 0);
  assert.ok(labels(capabilities).includes('capability = "provider"'));
});

test("offers no value completions for free-form values", () => {
  assert.deepEqual(computeMcppTomlCompletions(["[package]", 'name = "'], 1, 7), []);
  assert.deepEqual(computeMcppTomlCompletions(["[dependencies]", 'gtest = "'], 1, 8), []);
});

test("recognizes dotted dependency keys in value position", () => {
  // 点式选择器裸键的值位置不弹模板（docs/zh/05-mcpp-toml.md §2.5）。
  assert.deepEqual(computeMcppTomlCompletions(["[dependencies]", 'capi.lua = "'], 1, 11), []);
  assert.deepEqual(computeMcppTomlCompletions(["[dependencies]", 'imgui.backend.glfw_opengl3 = "'], 1, 29), []);
  assert.deepEqual(computeMcppTomlCompletions(["[dependencies]", '"chriskohlhoff.asio" = "'], 1, 23), []);
  // 点式键的长式 spec 仍然补全内联表键。
  const spec = computeMcppTomlCompletions(["[dependencies]", "imgui.core = { "], 1, 15);
  assert.ok(labels(spec).includes("version"));
});

test("ignores unknown and dot-prefixed custom sections", () => {
  // 附录 A：不支持包自定义 toml 键；未知段不提供任何建议。
  assert.deepEqual(computeMcppTomlCompletions(["[mytool]", ""], 1, 0), []);
  assert.deepEqual(computeMcppTomlCompletions(["[mytool]", "key = "], 1, 6), []);
  assert.deepEqual(normalizeSectionGroup(".foo"), undefined);
  assert.deepEqual(normalizeSectionGroup("mytool.settings"), undefined);
});

test("resolves the section from earlier lines", () => {
  const lines = ["[package]", 'name = "demo"', "", "[build]", ""];
  const suggestions = computeMcppTomlCompletions(lines, 4, 0);
  const names = labels(suggestions);
  assert.ok(names.includes("sources"));
  assert.ok(names.includes("include_dirs"));
  assert.ok(!names.includes("version"));
});

test("handles conditional target build sections", () => {
  const lines = ["[target.'cfg(windows)'.build]", ""];
  const suggestions = computeMcppTomlCompletions(lines, 1, 0);
  assert.ok(labels(suggestions).includes("defines"));
});

test("suggests keys in documented subtables", () => {
  const cxxRuntime = computeMcppTomlCompletions(["[build.cxx_runtime]", ""], 1, 0);
  assert.deepEqual(labels(cxxRuntime), ["default", "tests"]);
  const tests = computeMcppTomlCompletions(["[build.cxx_runtime]", "tests = "], 1, 8);
  assert.deepEqual(labels(tests), ["self-contained", "toolchain-coupled", "host-coupled"]);

  const versionInfo = computeMcppTomlCompletions(["[resources.version-info]", ""], 1, 0);
  const versionInfoKeys = labels(versionInfo);
  for (const expected of ["company", "product", "description", "copyright", "original-filename", "internal-name"]) {
    assert.ok(versionInfoKeys.includes(expected), `missing ${expected}`);
  }

  const provider = computeMcppTomlCompletions(['[runtime."opengl.glx.driver"]', ""], 1, 0);
  assert.deepEqual(labels(provider), ["provider"]);
});

test("suggests profile alias key in [build]", () => {
  const suggestions = computeMcppTomlCompletions(["[build]", ""], 1, 0);
  assert.ok(labels(suggestions).includes("default-profile"));
  assert.ok(labels(suggestions).includes("profile"));
  const values = computeMcppTomlCompletions(["[build]", "profile = "], 1, 10);
  assert.deepEqual(labels(values), ["dev", "release", "debug", "dist"]);
});

test("covers fields from 03-toolchains.md and 06-workspace.md", () => {
  // [package].namespace（06 §2.3）
  const packageKeys = labels(computeMcppTomlCompletions(["[package]", ""], 1, 0));
  assert.ok(packageKeys.includes("namespace"));

  // [workspace] members / exclude（06 §2.1）
  const workspaceKeys = labels(computeMcppTomlCompletions(["[workspace]", ""], 1, 0));
  assert.deepEqual(workspaceKeys, ["members", "exclude"]);

  // [workspace.dependencies] 与其命名空间子表（06 §3）
  const workspaceDeps = computeMcppTomlCompletions(["[workspace.dependencies]", ""], 1, 0);
  assert.ok(workspaceDeps.every((suggestion) => suggestion.kind === "template"));
  const workspaceDepsNs = computeMcppTomlCompletions(["[workspace.dependencies.compat]", ""], 1, 0);
  assert.ok(workspaceDepsNs.every((suggestion) => suggestion.kind === "template"));

  // 依赖 spec 的 workspace 继承键（06 §3）
  const spec = computeMcppTomlCompletions(["[dependencies]", "mbedtls = { "], 1, 12);
  assert.ok(labels(spec).includes("workspace"));

  // [toolchain] 平台 pin（03 项目级版本锁定）
  const toolchainKeys = labels(computeMcppTomlCompletions(["[toolchain]", ""], 1, 0));
  assert.deepEqual(toolchainKeys, ["default", "linux", "macos", "windows"]);

  // [build].target（03 Target 与交叉构建）
  const buildKeys = labels(computeMcppTomlCompletions(["[build]", ""], 1, 0));
  assert.ok(buildKeys.includes("target"));
  const targetValues = labels(computeMcppTomlCompletions(["[build]", "target = "], 1, 9));
  assert.ok(targetValues.includes("x86_64-linux-musl"));
  assert.ok(targetValues.includes("x86_64-windows-gnu"));

  // linkage 的 dynamic 取值（03 MinGW 一节）
  const linkageValues = labels(computeMcppTomlCompletions(["[target.x86_64-windows-gnu]", "linkage = "], 1, 10));
  assert.deepEqual(linkageValues, ["static", "dynamic"]);
});

test("covers [pack] fields from 02-pack-and-release.md", () => {
  const packKeys = labels(computeMcppTomlCompletions(["[pack]", ""], 1, 0));
  assert.deepEqual(packKeys, ["default_mode", "include", "exclude"]);

  const modes = labels(computeMcppTomlCompletions(["[pack]", "default_mode = "], 1, 14));
  assert.deepEqual(modes, ["static", "bundle-project", "bundle-all"]);

  const bundleKeys = labels(computeMcppTomlCompletions(["[pack.bundle-project]", ""], 1, 0));
  assert.deepEqual(bundleKeys, ["also_skip", "force_bundle"]);
});

test("suggests per-glob keys inside [build].flags entries", () => {
  const suggestions = computeMcppTomlCompletions(["[build]", "flags = [ { "], 1, 12);
  assert.deepEqual(labels(suggestions), ["glob", "cflags", "cxxflags", "asmflags", "defines"]);
});

test("ignores out-of-range positions", () => {
  assert.deepEqual(computeMcppTomlCompletions(["[package]"], 5, 0), []);
});
