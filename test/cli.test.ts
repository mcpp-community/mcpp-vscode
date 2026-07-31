import assert from "node:assert/strict";
import test from "node:test";

import {
  isMsvcToolchainSpec,
  hostDefaultToolchains,
  mcppCommandArguments,
  normalizeToolchainSpec,
  parseToolchainList,
  toolchainInstallKind,
  toolchainSpecTargetHint,
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

test("解析 mcpp 实际的可安装标题、斜线版本和 msvc@system", () => {
  const inventory = parseToolchainList([
    "Toolchains:",
    "  *  msvc 17.10             (default)",
    "  (* = effective toolchain from project mcpp.toml [toolchain]; global default is 'msvc@system')",
    "",
    "Available toolchains (run `mcpp toolchain install <family> <version>`):",
    "     gcc 15.1.0 / 13.3.0 / 11.5.0 / 9.4.0",
  ].join("\n"));
  assert.equal(inventory.globalDefaultSpec, "msvc@system");
  assert.deepEqual(
    inventory.available.map((item) => item.spec),
    ["gcc@15.1.0", "gcc@13.3.0", "gcc@11.5.0", "gcc@9.4.0"],
  );
});

test("解析独立的 target 轴和默认 target", () => {
  const inventory = parseToolchainList([
    "Toolchains:",
    "  *  gcc 16.1.0             (default)",
    "",
    "Targets:",
    "     TARGET                  NOTE                  TOOLCHAIN         STATUS",
    "  *  x86_64-linux-musl       static                gcc 16.1.0        installed",
    "     aarch64-linux-musl      static, cross         gcc 16.1.0        available",
    "     riscv64-linux-musl      static, cross         —                 planned",
  ].join("\n"));
  assert.deepEqual(
    inventory.targets.map((target) => [
      target.target,
      target.toolchainSpec,
      target.status,
      target.effective,
    ]),
    [
      ["x86_64-linux-musl", "gcc@16.1.0", "installed", true],
      ["aarch64-linux-musl", "gcc@16.1.0", "available", false],
      ["riscv64-linux-musl", undefined, "planned", false],
    ],
  );
  assert.equal(inventory.effectiveTarget, "x86_64-linux-musl");
});

test("全局默认明确为 none 时不回退成有效工具链", () => {
  const inventory = parseToolchainList([
    "Toolchains:",
    "  *  llvm 22.1.8             (default)",
    "  (* = effective toolchain from project mcpp.toml [toolchain]; global default is '<none>')",
  ].join("\n"));
  assert.equal(inventory.globalDefaultSpec, undefined);
  assert.equal(inventory.projectOverridesGlobal, true);
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
  assert.equal(normalizeToolchainSpec("MSVC 17.10"), "msvc@17.10");
  assert.equal(normalizeToolchainSpec("gcc@16.1.0-musl"), "gcc@16.1.0-musl");
  assert.equal(normalizeToolchainSpec("musl-gcc 16"), "musl-gcc@16");
  assert.equal(normalizeToolchainSpec("mingw@16.1.0"), "mingw@16.1.0");
  assert.equal(normalizeToolchainSpec("clang@19"), "clang@19");
  assert.equal(normalizeToolchainSpec("gcc; rm -rf /"), undefined);
  assert.deepEqual(
    mcppCommandArguments("toolchain", "default", "llvm@22.1.8"),
    ["toolchain", "default", "llvm@22.1.8"],
  );
  assert.deepEqual(mcppCommandArguments("build"), ["build"]);
});

test("保留 mcpp 支持的省略版本和 namespace 输入", () => {
  const inputs = [
    "gcc",
    "llvm",
    "clang",
    "musl-gcc",
    "mingw",
    "xim:gcc@16",
  ];
  assert.deepEqual(inputs.map(normalizeToolchainSpec), inputs);
  assert.equal(normalizeToolchainSpec("xim:gcc 16"), "xim:gcc@16");
  assert.equal(normalizeToolchainSpec("xim:gcc@system"), "xim:gcc@system");
  assert.equal(normalizeToolchainSpec("future@preview"), "future@preview");
  assert.equal(isMsvcToolchainSpec("xim:msvc@system"), true);
});

test("识别系统项和隐含 target 别名", () => {
  assert.equal(isMsvcToolchainSpec("msvc"), true);
  assert.equal(isMsvcToolchainSpec("msvc@system"), true);
  assert.equal(isMsvcToolchainSpec("llvm@20"), false);
  assert.equal(toolchainSpecTargetHint("gcc@16-musl"), "musl");
  assert.equal(toolchainSpecTargetHint("musl-gcc@16"), "musl");
  assert.equal(toolchainSpecTargetHint("mingw@16"), "windows-gnu");
  assert.equal(toolchainSpecTargetHint("clang@19"), undefined);
});

test("安装流程区分 host、target 和系统检测但都交给 mcpp", () => {
  assert.equal(toolchainInstallKind("llvm@20"), "managed-host");
  assert.equal(toolchainInstallKind("clang@19"), "managed-host");
  assert.equal(toolchainInstallKind("mingw@16"), "managed-target");
  assert.equal(toolchainInstallKind("aarch64-linux-musl-gcc@16"), "managed-target");
  assert.equal(toolchainInstallKind("msvc"), "system-detect");
  assert.equal(toolchainInstallKind("msvc@19.44"), "system-detect");
});

test("覆盖 mcpp 兼容层的扩展 target 别名", () => {
  assert.equal(toolchainSpecTargetHint("mingw-gcc@16"), "windows-gnu");
  assert.equal(toolchainSpecTargetHint("mingw-cross-gcc@16"), "windows-gnu");
  assert.equal(toolchainSpecTargetHint("x86_64-w64-mingw32-gcc@16"), "windows-gnu");
  assert.equal(toolchainSpecTargetHint("aarch64-linux-musl-gcc@16"), "musl");
  assert.equal(toolchainSpecTargetHint("aarch64-linux-gnu-gcc@16"), "target");
});

test("全局默认选择只暴露 host target 的已安装 payload", () => {
  const targetOnly = parseToolchainList([
    "Toolchains:",
    "  *  gcc 16.1.0             (default)",
    "",
    "Targets:",
    "     TARGET                  NOTE                  TOOLCHAIN         STATUS",
    "  *  x86_64-linux-musl       static                gcc 16.1.0        installed",
  ].join("\n"));
  assert.deepEqual(hostDefaultToolchains(targetOnly), []);

  const hostAndTarget = parseToolchainList([
    "Toolchains:",
    "     gcc 16.1.0",
    "",
    "Targets:",
    "     TARGET                  NOTE                  TOOLCHAIN         STATUS",
    "     x86_64-linux-gnu        host                  gcc 16.1.0        installed",
    "     x86_64-linux-musl       static                gcc 16.1.0        installed",
  ].join("\n"));
  assert.deepEqual(hostDefaultToolchains(hostAndTarget).map((item) => item.spec), ["gcc@16.1.0"]);
});

test("Windows 上 GCC 的 host 默认使用已安装的 MinGW payload", () => {
  const windowsInventory = parseToolchainList([
    "Toolchains:",
    "     gcc 16.1.0",
    "",
    "Targets:",
    "     TARGET                  NOTE                  TOOLCHAIN         STATUS",
    "     x86_64-windows-gnu      PE, static            gcc 16.1.0        installed",
    "     x86_64-windows-msvc     host, PE              —                 available",
  ].join("\n"));

  assert.deepEqual(
    hostDefaultToolchains(windowsInventory).map((item) => item.spec),
    ["gcc@16.1.0"],
  );
});
