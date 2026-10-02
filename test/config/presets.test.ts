import assert from "node:assert/strict";
import test from "node:test";

import { PRESETS, preset, presetProblems, presetValues } from "../../src/config/presets";
import { setting } from "../../src/config/registry";

test("every preset names only settings that exist", () => {
  assert.deepEqual(presetProblems(), []);
});

test("preset ids are unique and carry English copy", () => {
  const ids = PRESETS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of PRESETS) {
    assert.ok(entry.title.length > 0, entry.id);
    assert.ok(entry.description.length > 0, entry.id);
  }
});

test("the defaults preset writes nothing", () => {
  assert.deepEqual(presetValues("defaults"), []);
  assert.deepEqual(preset("defaults")?.values, {});
});

test("a preset value is valid for its setting", () => {
  for (const entry of PRESETS) {
    for (const [key, value] of Object.entries(entry.values)) {
      const declared = setting(key);
      assert.ok(declared, key);
      if (declared.enum !== undefined) {
        assert.ok(declared.enum.includes(String(value)), `${key}=${String(value)} is not in its enum`);
      }
      if (declared.type === "number" && typeof value === "number") {
        if (declared.minimum !== undefined) assert.ok(value >= declared.minimum, `${key} below minimum`);
        if (declared.maximum !== undefined) assert.ok(value <= declared.maximum, `${key} above maximum`);
      }
    }
  }
});

test("an unknown preset is empty rather than an error", () => {
  assert.equal(preset("nope"), undefined);
  assert.deepEqual(presetValues("nope"), []);
});

test("the quiet preset turns the noisy things off", () => {
  const values = new Map(presetValues("quiet").map((entry) => [entry.key, entry.value]));
  assert.equal(values.get("mcpp.cache.statusBar"), false);
  assert.equal(values.get("mcpp.cache.autoRefreshSeconds"), 0);
  assert.equal(values.get("mcpp.ui.notifications.success"), "silent");
});
