import assert from "node:assert/strict";
import test from "node:test";

import { readProjectSummary } from "../../src/projects/summary";

const MANIFEST = [
  "[package]",
  'name    = "greeter"',
  'version = "0.1.0"',
  'standard = "c++23"',
  "# a comment with name = \"not-this\"",
  "",
  "[targets.greet]",
  'kind = "bin"',
  'main = "src/main.cpp"',
  "",
  "[targets.greet-lib]",
  'kind = "lib"',
  "",
  "[toolchain]",
  'spec = "llvm@22.1.8"',
  "",
  "[target.'cfg(os = \"linux\")']",
  'runner = "qemu"',
  "",
  "[test]",
  'discover = "tests/**/*.cpp"',
].join("\n")
  .split("\n");

test("reads the identity, the toolchain and the artifact targets", () => {
  const summary = readProjectSummary("/w", MANIFEST);
  assert.equal(summary.name, "greeter");
  assert.equal(summary.version, "0.1.0");
  assert.equal(summary.standard, "c++23");
  assert.equal(summary.toolchainSpec, "llvm@22.1.8");
  assert.deepEqual(summary.targets, [
    { name: "greet", kind: "bin" },
    { name: "greet-lib", kind: "lib" },
  ]);
  assert.equal(summary.hasTests, true);
  assert.equal(summary.root, "/w");
});

test("a commented-out assignment is not read", () => {
  const summary = readProjectSummary("/w", ['[package]', 'name = "real"', '# name = "fake"']);
  assert.equal(summary.name, "real");
});

test("nested target sections do not leak into [targets]", () => {
  const summary = readProjectSummary("/w", ["[targets.a]", 'kind = "bin"', "[target.'cfg(unix)']", 'runner = "x"']);
  assert.deepEqual(summary.targets, [{ name: "a", kind: "bin" }]);
});

test("a target with no kind is still listed", () => {
  const summary = readProjectSummary("/w", ["[targets.a]", 'main = "x.cpp"']);
  assert.deepEqual(summary.targets, [{ name: "a", kind: "target" }]);
});

test("an empty or unreadable manifest yields a root only", () => {
  const summary = readProjectSummary("/w", []);
  assert.deepEqual(summary, { root: "/w" });
});

test("single-quoted values are accepted", () => {
  const summary = readProjectSummary("/w", ["[package]", "name = 'single'"]);
  assert.equal(summary.name, "single");
});

test("a trailing comment after a value is stripped", () => {
  const summary = readProjectSummary("/w", ["[package]", 'name = "greeter" # the project']);
  assert.equal(summary.name, "greeter");
});

test("the default_profile and the build profile are both honoured", () => {
  assert.equal(readProjectSummary("/w", ["[package]", 'default_profile = "release"']).profile, "release");
  assert.equal(readProjectSummary("/w", ["[build]", 'profile = "dev"']).profile, "dev");
});
