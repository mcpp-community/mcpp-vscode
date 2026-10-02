import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { STATUS_BAR_BACKGROUNDS, statusBarBackgroundColour } from "../../src/cli/statusBar";

/**
 * "Can the mcpp status bar item have a background colour?" — the answer is two
 * colours, chosen by the extension host's whitelist, and this is where the
 * mapping is held to it.
 */

const registry = JSON.parse(readFileSync(path.join(process.cwd(), "data", "config-registry.json"), "utf8")) as {
  settings: Array<{ key: string; enum?: string[]; default?: unknown }>;
};

test("only the two backgrounds VS Code accepts are ever named", () => {
  assert.equal(statusBarBackgroundColour("warning"), "statusBarItem.warningBackground");
  assert.equal(statusBarBackgroundColour("error"), "statusBarItem.errorBackground");
  // Anything else must mean "no background": a custom colour is silently dropped
  // by the extension host, and a stale settings value must not throw.
  for (const value of ["none", "", "secondary", undefined, null, 7, {}]) {
    assert.equal(statusBarBackgroundColour(value), undefined, `${JSON.stringify(value)} painted something`);
  }
});

test("the setting offers exactly the values this function understands", () => {
  const entry = registry.settings.find((setting) => setting.key === "mcpp.ui.statusBar.background");
  assert.ok(entry !== undefined, "mcpp.ui.statusBar.background is not in the registry");
  assert.deepEqual([...(entry.enum ?? [])].sort(), [...STATUS_BAR_BACKGROUNDS].sort());
  assert.ok(entry.enum?.includes(String(entry.default)), "the default must be one of the values");
});
