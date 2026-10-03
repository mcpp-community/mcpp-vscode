import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { runProcess, spawnNeedsShell } from "../../src/cli/process";

test("captures output and exit status from a real child process", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "");
});

test("only Windows .cmd/.bat shims need the shell, and nothing else does", () => {
  assert.equal(spawnNeedsShell("C:\\tools\\mcpp.cmd", "win32"), true);
  assert.equal(spawnNeedsShell("C:\\tools\\MCPP.BAT", "win32"), true);
  assert.equal(spawnNeedsShell("C:\\tools\\mcpp.exe", "win32"), false);
  assert.equal(spawnNeedsShell("C:\\tools\\mcpp.js", "win32"), false);
  assert.equal(spawnNeedsShell("/usr/local/bin/mcpp", "linux"), false);
  assert.equal(spawnNeedsShell("/opt/mcpp/mcpp.cmd", "darwin"), false);
});
