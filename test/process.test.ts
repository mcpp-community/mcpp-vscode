import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  runClangdCheck,
  runMcppBuild,
  runProcess,
  runToolVersion,
} from "../src/process";

test("captures output and exit status from a real child process", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "");
});

test("parses a tool identity from the version command", async () => {
  const result = await runToolVersion(process.execPath, [
    "-e",
    "process.stdout.write('clangd version 22.1.8 (git ca7933e47d3a3451d81e72ac174dcb5aa28b59d1)')",
  ]);

  assert.deepEqual(result.identity, {
    major: 22,
    minor: 1,
    patch: 8,
    revision: "ca7933e47d3a3451d81e72ac174dcb5aa28b59d1",
  });
});

test("classifies clangd check output at the process boundary", async () => {
  const calls: Array<{ executable: string; arguments: string[]; cwd?: string }> = [];
  const timeouts: Array<number | undefined> = [];
  const result = await runClangdCheck(
    "/tools/clangd",
    "/work/app/src/main.cpp",
    "/work/app",
    ["--background-index"],
    async (
      executable: string,
      args: string[],
      cwd: string | undefined,
      options?: { timeoutMs?: number },
    ) => {
      calls.push({ executable, arguments: args, cwd });
      timeouts.push(options?.timeoutMs);
      return {
        exitCode: 1,
        stdout: "",
        stderr: "error: ast_file_different_branch",
      };
    },
  );

  assert.deepEqual(calls, [{
    executable: "/tools/clangd",
    arguments: ["--check=/work/app/src/main.cpp", "--background-index"],
    cwd: "/work/app",
  }]);
  assert.deepEqual(timeouts, [60_000]);
  assert.equal(result.classification, "pcm-mismatch");
});

test("uses the configured mcpp executable for builds", async () => {
  const calls: Array<{ executable: string; arguments: string[]; cwd?: string }> = [];
  const runner = async (executable: string, args: string[], cwd?: string) => {
    calls.push({ executable, arguments: args, cwd });
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await Reflect.apply(runMcppBuild, undefined, ["/work/app", "/tools/mcpp", runner]);

  assert.deepEqual(calls, [{
    executable: "/tools/mcpp",
    arguments: ["build"],
    cwd: "/work/app",
  }]);
});
