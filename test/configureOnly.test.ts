import assert from "node:assert/strict";
import test from "node:test";

import { configureOnlyArguments, runConfigureOnly } from "../src/configureOnly";

test("runs mcpp build --configure-only with the configured executable and cwd", async () => {
  const calls: Array<{
    executable: string;
    args: string[];
    cwd?: string;
    timeoutMs?: number;
  }> = [];
  const result = await runConfigureOnly(
    "/work/app",
    "/tools/mcpp",
    async (executable, args, cwd, options) => {
      calls.push({ executable, args, cwd, timeoutMs: options?.timeoutMs });
      return { exitCode: 0, stdout: "Configured 2 compile commands", stderr: "" };
    },
  );

  assert.deepEqual(calls, [{
    executable: "/tools/mcpp",
    args: [...configureOnlyArguments],
    cwd: "/work/app",
    timeoutMs: 5 * 60_000,
  }]);
  assert.equal(result.exitCode, 0);
});

test("does not interpret human-readable configure output", async () => {
  const result = await runConfigureOnly(
    "/work/app",
    "/tools/mcpp",
    async () => ({
      exitCode: 0,
      stdout: "Configured 2 compile commands\nFinished dev in 0.02s",
      stderr: "",
    }),
  );

  assert.equal(result.stdout, "Configured 2 compile commands\nFinished dev in 0.02s");
});

test("returns a non-zero configure-only exit code without parsing stdout", async () => {
  const result = await runConfigureOnly(
    "/work/app",
    "/tools/mcpp",
    async () => ({
      exitCode: 2,
      stdout: "error: unknown option '--configure-only'",
      stderr: "",
    }),
  );

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "error: unknown option '--configure-only'");
});
