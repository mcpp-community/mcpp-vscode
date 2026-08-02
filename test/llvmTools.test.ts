import assert from "node:assert/strict";
import test from "node:test";

import {
  llvmToolsVersionSpec,
  extractVersionFromCompilerPath,
  xlingsInstallArgs,
  deriveInstalledClangdPath,
  findXlingsExecutable,
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
