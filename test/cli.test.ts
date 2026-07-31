import assert from "node:assert/strict";
import test from "node:test";

import {
  mcppCommandArguments,
  normalizeToolchainSpec,
  parseToolchainList,
} from "../src/cli";

const plainOutput = [
  "Toolchains:",
  "  *  llvm 22.1.8             (default)",
  "     gcc 16.1.0",
  "",
  "Targets:",
  "  *  aarch64-macos           host                  llvm 22.1.8       installed",
  "",
  "Available toolchains:",
  "     llvm 20.1.7",
  "",
].join("\n");

test("解析已安装、默认和可安装项", () => {
  const inventory = parseToolchainList(plainOutput);
  assert.equal(inventory.recognized, true);
  assert.equal(inventory.projectOverridesGlobal, false);
  assert.equal(inventory.globalDefaultSpec, "llvm@22.1.8");
  assert.equal(inventory.effective?.spec, "llvm@22.1.8");
  assert.deepEqual(
    inventory.installed.map((item) => item.spec),
    ["llvm@22.1.8", "gcc@16.1.0"],
  );
  assert.deepEqual(
    inventory.available.map((item) => item.spec),
    ["llvm@20.1.7"],
  );
});

test("项目覆盖时分开记录有效项和全局默认", () => {
  const output = [
    "Toolchains:",
    "  *  llvm 22.1.8             (default)",
    "     gcc 16.1.0",
    "  (* = effective toolchain from project mcpp.toml [toolchain]; global default is 'gcc@16.1.0')",
  ].join("\n");
  const inventory = parseToolchainList(output);
  assert.equal(inventory.projectOverridesGlobal, true);
  assert.equal(inventory.effective?.spec, "llvm@22.1.8");
  assert.equal(inventory.globalDefaultSpec, "gcc@16.1.0");
});

test("支持系统 MSVC 和合法的空安装状态", () => {
  const system = parseToolchainList([
    "System:",
    "  *  msvc 17.10             C:\\\\Program Files\\\\MSVC\\\\cl.exe",
  ].join("\n"));
  assert.equal(system.effective?.spec, "msvc");
  assert.equal(system.installed[0]?.source, "system");

  const empty = parseToolchainList(
    "(no toolchains installed - run mcpp build to auto-install the default)\n",
  );
  assert.equal(empty.recognized, true);
  assert.deepEqual(empty.installed, []);
});

test("未知输出不伪造工具链", () => {
  const inventory = parseToolchainList("unexpected output\n");
  assert.equal(inventory.recognized, false);
  assert.deepEqual(inventory.installed, []);
  assert.equal(inventory.rawOutput, "unexpected output\n");

  const unknownSection = parseToolchainList([
    "Metadata:",
    "  global default is 'gcc@16.1.0'",
  ].join("\n"));
  assert.equal(unknownSection.recognized, false);
  assert.equal(unknownSection.globalDefaultSpec, undefined);
});

test("规范化输入并构造参数数组", () => {
  assert.equal(normalizeToolchainSpec(" llvm@20 "), "llvm@20");
  assert.equal(normalizeToolchainSpec("gcc 16.1.0"), "gcc@16.1.0");
  assert.equal(normalizeToolchainSpec("MSVC 17.10"), "msvc");
  assert.equal(normalizeToolchainSpec("gcc; rm -rf /"), undefined);
  assert.deepEqual(
    mcppCommandArguments("toolchain", "default", "llvm@22.1.8"),
    ["toolchain", "default", "llvm@22.1.8"],
  );
  assert.deepEqual(mcppCommandArguments("build"), ["build"]);
});
