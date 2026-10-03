import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { runMcpp, runProcess, spawnNeedsShell } from "../../src/cli/process";

test("captures output and exit status from a real child process", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "");
});

test("runMcpp refuses instead of spawning when the workspace is not trusted", async () => {
  // A refusal is `undefined`; a spawn — even of a program that does not exist —
  // always answers a result object, so this asserts the gate, not the spawn.
  const refused = await runMcpp(false, "definitely-not-an-executable", ["--version"]);
  assert.equal(refused, undefined);
});

test("runMcpp delegates to the real spawn when the workspace is trusted", async () => {
  const result = await runMcpp(true, process.execPath, ["-e", "process.stdout.write('ok')"], undefined, {});
  assert.equal(result?.exitCode, 0);
  assert.equal(result?.stdout, "ok");
});

test("only Windows .cmd/.bat shims need the shell, and nothing else does", () => {
  assert.equal(spawnNeedsShell("C:\\tools\\mcpp.cmd", "win32"), true);
  assert.equal(spawnNeedsShell("C:\\tools\\MCPP.BAT", "win32"), true);
  assert.equal(spawnNeedsShell("C:\\tools\\mcpp.exe", "win32"), false);
  assert.equal(spawnNeedsShell("C:\\tools\\mcpp.js", "win32"), false);
  assert.equal(spawnNeedsShell("/usr/local/bin/mcpp", "linux"), false);
  assert.equal(spawnNeedsShell("/opt/mcpp/mcpp.cmd", "darwin"), false);
});
