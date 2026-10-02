import assert from "node:assert/strict";
import test from "node:test";

import { CLI_COMMANDS, DEPRECATED_COMMANDS } from "../../src/commands/ids";
import {
  CAPABILITIES,
  MCPPLS_EXTENSION_ID,
  VERIFIED_MCPPLS_RANGE,
  capability,
  capabilityProblems,
  commandsOf,
} from "../../src/mcppls/contract";

test("the capability table satisfies its own rules", () => {
  assert.deepEqual(capabilityProblems(), []);
});

test("the dependency id is the published one", () => {
  assert.equal(MCPPLS_EXTENSION_ID, "sunrisepeak.mcpp-language-server");
  assert.equal(VERIFIED_MCPPLS_RANGE, ">=0.0.4");
});

test("no capability is required: losing mcppls must not disable mcpp's own features", () => {
  assert.ok(CAPABILITIES.every((entry) => entry.required === false));
});

test("the refresh chain prefers the cheap reload and falls back to a restart", () => {
  assert.deepEqual(commandsOf("refresh"), ["mcppls.reloadBuildDescription", "mcppls.restartServer"]);
});

test("every forwarded command is an mcppls command", () => {
  for (const entry of CAPABILITIES) {
    for (const command of entry.commands) {
      assert.ok(command.startsWith("mcppls."), `${entry.key} forwards ${command}`);
    }
  }
});

test("destructive capabilities spell out what they do not touch", () => {
  const reset = capability("resetCache");
  assert.ok(reset);
  assert.equal(reset.danger, "destructive");
  assert.match(reset.confirmHint ?? "", /not touched/);
});

test("our own commands never use the mcppls prefix", () => {
  for (const id of [...Object.values(CLI_COMMANDS), ...Object.values(DEPRECATED_COMMANDS)]) {
    assert.ok(!id.startsWith("mcppls."), `${id} would collide with a server-advertised command`);
  }
});

test("capability keys are unique and unknown keys resolve to undefined", () => {
  const keys = CAPABILITIES.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(capability("nope"), undefined);
  assert.deepEqual(commandsOf("nope"), []);
});
