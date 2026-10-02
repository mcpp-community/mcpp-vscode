import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { runProcess } from "../../src/cli/process";

test("captures output and exit status from a real child process", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "");
});
