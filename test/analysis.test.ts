import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeCompilationDatabase,
  buildClangdArguments,
  classifyCheckResult,
  compareToolIdentities,
  parseToolIdentity,
} from "../src/analysis";
import * as analysisModule from "../src/analysis";

function cdb(compiler: string, flags: string[]): string {
  return JSON.stringify([
    {
      directory: "/work/app",
      file: "/work/app/src/main.cpp",
      arguments: [compiler, "-std=c++23", ...flags, "-c", "/work/app/src/main.cpp"],
    },
  ]);
}

test("classifies an mcpp LLVM CDB as full module support", () => {
  const result = analyzeCompilationDatabase(cdb("/tools/xim-x-llvm/22.1.8/bin/clang++", [
    "-fmodule-file=std=/work/app/target/pcm.cache/std.pcm",
    "-fprebuilt-module-path=/work/app/target/pcm.cache",
  ]));

  assert.equal(result.kind, "llvm");
  assert.equal(result.capability, "full");
  assert.equal(result.compilerPath, "/tools/xim-x-llvm/22.1.8/bin/clang++");
  assert.equal(result.sourceFile, "/work/app/src/main.cpp");
  assert.equal(result.hasPrebuiltModules, true);
});

test("prefers a project module interface over an earlier external command", () => {
  const result = analyzeCompilationDatabase(JSON.stringify([
    {
      directory: "/work/app",
      file: "/deps/gtest.cc",
      arguments: ["/tools/clang++", "-std=c++23", "-c", "/deps/gtest.cc"],
    },
    {
      directory: "/work/app",
      file: "/work/app/src/demo.cppm",
      arguments: [
        "/tools/clang++",
        "-std=c++23",
        "-fmodule-file=std=/work/app/target/pcm.cache/std.pcm",
        "-c",
        "/work/app/src/demo.cppm",
      ],
    },
  ]));

  assert.equal(result.sourceFile, "/work/app/src/demo.cppm");
  assert.equal(result.hasPrebuiltModules, true);
});

test("prefers a project source over an external module interface", () => {
  const result = analyzeCompilationDatabase(JSON.stringify([
    {
      directory: "/work/app",
      file: "/deps/fmt_module.cppm",
      arguments: [
        "/tools/clang++",
        "-std=c++23",
        "-fmodule-file=std=/work/app/target/pcm.cache/std.pcm",
        "-c",
        "/deps/fmt_module.cppm",
      ],
    },
    {
      directory: "/work/app",
      file: "/work/app/src/main.cpp",
      arguments: [
        "/tools/clang++",
        "-std=c++23",
        "-fmodule-file=std=/work/app/target/pcm.cache/std.pcm",
        "-c",
        "/work/app/src/main.cpp",
      ],
    },
  ]));

  assert.equal(result.sourceFile, "/work/app/src/main.cpp");
});

test("keeps Windows separators when reading a command-form CDB entry", () => {
  const result = analyzeCompilationDatabase(JSON.stringify([
    {
      directory: "C:\\work\\app",
      file: "C:\\work\\app\\main.cpp",
      command: "C:\\LLVM\\bin\\clang++.exe -std=c++23 -c C:\\work\\app\\main.cpp",
    },
  ]));

  assert.equal(result.kind, "llvm");
  assert.equal(result.compilerPath, "C:\\LLVM\\bin\\clang++.exe");
});

test("degrades GCC module databases to syntax-only", () => {
  const result = analyzeCompilationDatabase(cdb("/tools/g++", ["-fmodules"]));

  assert.equal(result.kind, "gcc");
  assert.equal(result.capability, "syntax-only");
});

test("degrades MSVC module databases to syntax-only", () => {
  const result = analyzeCompilationDatabase(cdb("C:\\LLVM\\cl.exe", [
    "/reference",
    "std=C:\\work\\ifc.cache\\std.ifc",
  ]));

  assert.equal(result.kind, "msvc");
  assert.equal(result.capability, "syntax-only");
});

test("reports malformed compilation databases without throwing", () => {
  const result = analyzeCompilationDatabase("not-json");

  assert.equal(result.kind, "unknown");
  assert.equal(result.capability, "unavailable");
  assert.match(result.reason, /JSON/i);
});

test("auto module arguments enable experimental support for clangd 22", () => {
  const args = buildClangdArguments(
    ["--background-index", "--query-driver=/old/compiler"],
    {
      compilerPath: "/tools/clang++",
      modulesSupport: "auto",
      clangdIdentity: { major: 22, minor: 1, patch: 8 },
      platform: "darwin",
    },
  );

  assert.deepEqual(args, [
    "--background-index",
    "--query-driver=/tools/clang++",
    "--experimental-modules-support",
  ]);
});

test("auto module arguments avoid the known Windows clangd 20 crash", () => {
  const args = buildClangdArguments([], {
    compilerPath: "C:\\tools\\clang++.exe",
    modulesSupport: "auto",
    clangdIdentity: { major: 20, minor: 1, patch: 7 },
    platform: "win32",
  });

  assert.deepEqual(args, ["--query-driver=C:\\tools\\clang++.exe"]);
});

test("auto consumes explicit mcpp PCMs without invoking clangd's module builder", () => {
  const args = buildClangdArguments([], {
    compilerPath: "/tools/clang++",
    modulesSupport: "auto",
    clangdIdentity: { major: 22, minor: 1, patch: 8 },
    platform: "darwin",
    hasPrebuiltModules: true,
  });

  assert.deepEqual(args, ["--query-driver=/tools/clang++"]);
});

test("expands workspace folder variables before invoking clangd", () => {
  const options = {
    compilerPath: "/tools/clang++",
    modulesSupport: "off" as const,
    platform: "darwin" as const,
    workspaceFolder: "/work/app",
  };
  const args = buildClangdArguments([
    "--compile-commands-dir=${workspaceFolder}",
    "--background-index",
  ], options);

  assert.deepEqual(args, [
    "--compile-commands-dir=/work/app",
    "--background-index",
    "--query-driver=/tools/clang++",
  ]);
});

test("off removes an existing experimental module flag", () => {
  const args = buildClangdArguments(["--experimental-modules-support"], {
    compilerPath: "/tools/clang++",
    modulesSupport: "off",
    clangdIdentity: { major: 22, minor: 1, patch: 8 },
    platform: "linux",
  });

  assert.deepEqual(args, ["--query-driver=/tools/clang++"]);
});

test("plans replacing the default clangd shim with the matched executable", () => {
  const planner = (analysisModule as typeof analysisModule & {
    buildClangdConfigurationPlan?: (
      currentPath: string,
      currentArguments: string[],
      resolvedPath: string,
      options: {
        compilerPath: string;
        modulesSupport: "auto";
        clangdIdentity: { major: number; minor: number; patch: number };
        platform: NodeJS.Platform;
        hasPrebuiltModules: boolean;
        workspaceFolder: string;
      },
    ) => { path: string; arguments: string[]; changed: boolean };
  }).buildClangdConfigurationPlan;

  assert.equal(typeof planner, "function");
  const plan = planner?.(
    "clangd",
    ["--compile-commands-dir=${workspaceFolder}", "--background-index"],
    "/tools/xim-x-llvm-tools/22.1.8/bin/clangd",
    {
      compilerPath: "/tools/xim-x-llvm/22.1.8/bin/clang++",
      modulesSupport: "auto",
      clangdIdentity: { major: 22, minor: 1, patch: 8 },
      platform: "darwin",
      hasPrebuiltModules: true,
      workspaceFolder: "/work/app",
    },
  );

  assert.deepEqual(plan, {
    path: "/tools/xim-x-llvm-tools/22.1.8/bin/clangd",
    arguments: [
      "--compile-commands-dir=/work/app",
      "--background-index",
      "--query-driver=/tools/xim-x-llvm/22.1.8/bin/clang++",
    ],
    changed: true,
  });
});

test("parses LLVM version and revision identities", () => {
  const identity = parseToolIdentity(
    "clangd version 22.1.8 (https://github.com/llvm/llvm-project ca7933e47d3a3451d81e72ac174dcb5aa28b59d1)",
  );

  assert.deepEqual(identity, {
    major: 22,
    minor: 1,
    patch: 8,
    revision: "ca7933e47d3a3451d81e72ac174dcb5aa28b59d1",
  });
});

test("rejects matching semantic versions from different LLVM revisions", () => {
  const result = compareToolIdentities(
    { major: 22, minor: 1, patch: 8, revision: "aaaa" },
    { major: 22, minor: 1, patch: 8, revision: "bbbb" },
  );

  assert.equal(result.compatible, false);
  assert.match(result.reason, /revision/i);
});

test("does not claim exact identity when an LLVM revision is unavailable", () => {
  const result = compareToolIdentities(
    { major: 22, minor: 1, patch: 8 },
    { major: 22, minor: 1, patch: 8 },
  );

  assert.equal(result.compatible, false);
  assert.match(result.reason, /revision/i);
});

test("classifies clangd check failures into actionable states", () => {
  assert.equal(
    classifyCheckResult(1, "error: ast_file_different_branch"),
    "pcm-mismatch",
  );
  assert.equal(
    classifyCheckResult(1, "Failed to build module std; Don't get the module unit"),
    "module-unavailable",
  );
  assert.equal(
    classifyCheckResult(3, "unknown type name 'import'"),
    "wrong-language-mode",
  );
  assert.equal(
    classifyCheckResult(0, "All checks completed, 0 errors"),
    "ready",
  );
  assert.equal(
    classifyCheckResult(3, "tweak: ExtractFunction ==> FAIL\nAll checks completed, 4 errors"),
    "ready",
  );
  assert.equal(
    classifyCheckResult(
      3,
      "E[12:00:00] [undeclared_var_use] Line 4: use of undeclared identifier 'missing'\nAll checks completed, 1 errors",
    ),
    "check-failed",
  );
});
