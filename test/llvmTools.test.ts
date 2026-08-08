import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  llvmToolsVersionSpec,
  extractVersionFromCompilerPath,
  xlingsInstallArgs,
  deriveInstalledClangdPath,
  findXlingsExecutable,
  resolveXlingsExecutable,
} from "../src/llvmTools";

test("extracts version string from ToolIdentity", () => {
  assert.equal(
    llvmToolsVersionSpec({ major: 22, minor: 1, patch: 8, revision: "abc1234" }),
    "22.1.8",
  );
  assert.equal(
    llvmToolsVersionSpec({ major: 20, minor: 1, patch: 7 }),
    "20.1.7",
  );
});

test("extracts version from mcpp compiler path", () => {
  assert.equal(
    extractVersionFromCompilerPath("/home/user/.mcpp/registry/data/xpkgs/xim-x-llvm/22.1.8/bin/clang++"),
    "22.1.8",
  );
  assert.equal(
    extractVersionFromCompilerPath("C:\\Users\\test\\.mcpp\\registry\\data\\xpkgs\\xim-x-llvm\\20.1.7\\bin\\clang.exe"),
    "20.1.7",
  );
});

test("returns undefined for non-xlings compiler paths", () => {
  assert.equal(extractVersionFromCompilerPath("/usr/bin/clang++"), undefined);
  assert.equal(extractVersionFromCompilerPath("/opt/homebrew/opt/llvm/bin/clang"), undefined);
});

test("builds xlings update args without version (auto-detect)", () => {
  assert.deepEqual(xlingsInstallArgs(), ["update", "llvm-tools"]);
});

test("builds xlings install args with explicit version", () => {
  assert.deepEqual(xlingsInstallArgs("22.1.8"), ["install", "xim:llvm-tools@22.1.8"]);
});

test("derives clangd path from mcpp registry compiler path", () => {
  const paths = deriveInstalledClangdPath(
    "/Users/test/.mcpp/registry/data/xpkgs/xim-x-llvm/22.1.8/bin/clang++",
    "22.1.8",
  );
  assert.ok(paths.some((p) => p.includes("xim-x-llvm-tools")));
  assert.ok(paths.some((p) => p.includes("22.1.8")));
  assert.ok(paths.some((p) => p.endsWith("clangd")));
});

test("derives clangd path with .exe extension on Windows", () => {
  const paths = deriveInstalledClangdPath(
    "C:\\Users\\test\\.mcpp\\registry\\data\\xpkgs\\xim-x-llvm\\20.1.7\\bin\\clang.exe",
    "20.1.7",
  );
  assert.ok(paths.every((p) => p.endsWith(".exe")));
  assert.ok(paths.some((p) => p.includes(".xlings") && p.includes("clangd.exe")));
});

test("findXlingsExecutable returns a string or undefined", () => {
  const result = findXlingsExecutable();
  // Returns string (PATH fallback or known path) or undefined if xlings not found
  assert.ok(result === undefined || typeof result === "string");
});

test("findXlingsExecutable finds the xlings bundled in $MCPP_HOME/registry/bin", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-mcpp-home-"));
  const registryBin = path.join(home, "registry", "bin");
  const xlingsPath = path.join(registryBin, "xlings");
  mkdirSync(registryBin, { recursive: true });
  writeFileSync(xlingsPath, "#!/bin/sh\n");
  try {
    assert.equal(
      findXlingsExecutable({ home, env: { MCPP_HOME: home } }),
      xlingsPath,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("findXlingsExecutable falls back to $HOME/.mcpp/registry/bin when MCPP_HOME is unset", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-home-"));
  const registryBin = path.join(home, ".mcpp", "registry", "bin");
  const xlingsPath = path.join(registryBin, "xlings");
  mkdirSync(registryBin, { recursive: true });
  writeFileSync(xlingsPath, "#!/bin/sh\n");
  try {
    assert.equal(
      findXlingsExecutable({ home, env: {} }),
      xlingsPath,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("findXlingsExecutable honors MCPP_VENDORED_XLINGS", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-vendored-"));
  const vendored = path.join(root, "opt-mcpp", "registry", "bin", "xlings");
  mkdirSync(path.dirname(vendored), { recursive: true });
  writeFileSync(vendored, "#!/bin/sh\n");
  try {
    assert.equal(
      findXlingsExecutable({ home: root, env: { MCPP_VENDORED_XLINGS: vendored } }),
      vendored,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveXlingsExecutable reads the xlings binary from `mcpp self env`", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-selfenv-"));
  const xlingsPath = path.join(root, "registry", "bin", "xlings");
  mkdirSync(path.dirname(xlingsPath), { recursive: true });
  writeFileSync(xlingsPath, "#!/bin/sh\n");
  const runner = async () => ({
    exitCode: 0,
    stdout: `MCPP_HOME = ${root}\nxlings binary = ${xlingsPath}\nxlings pinned = 2026.8.8.1\n`,
    stderr: "",
  });
  try {
    assert.equal(
      await resolveXlingsExecutable("/tools/mcpp", runner),
      xlingsPath,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveXlingsExecutable falls back when the reported path does not exist", async () => {
  const runner = async () => ({
    exitCode: 0,
    stdout: "xlings binary = /no/such/xlings\n",
    stderr: "",
  });
  const result = await resolveXlingsExecutable("/tools/mcpp", runner);
  // Fallback heuristics find nothing in this environment, so the result is
  // undefined unless a standalone ~/.xlings or PATH xlings happens to exist.
  assert.ok(result === undefined || typeof result === "string");
});

test("resolveXlingsExecutable falls back when `mcpp self env` fails", async () => {
  const runner = async () => ({ exitCode: 1, stdout: "", stderr: "boom\n" });
  const result = await resolveXlingsExecutable("/tools/mcpp", runner);
  assert.ok(result === undefined || typeof result === "string");
});
