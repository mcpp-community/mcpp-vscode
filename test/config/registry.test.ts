import assert from "node:assert/strict";
import test from "node:test";

import {
  GROUPS,
  SETTINGS,
  aliasedKey,
  groupOf,
  groupedKeys,
  manifestKeys,
  registryShapeProblems,
  renamedKeys,
  setting,
  settingsByTier,
  settingsInGroup,
  subKey,
} from "../../src/config/registry";

test("the registry declares 10 groups and 69 settings", () => {
  assert.equal(GROUPS.length, 10);
  assert.equal(SETTINGS.length, 69);
});

test("the registry's own shape rules hold", () => {
  assert.deepEqual(registryShapeProblems(), []);
});

test("32 settings are public and the rest are advanced", () => {
  assert.equal(settingsByTier("public").length, 32);
  // 33 advanced + the 4 deprecated keys the Settings UI keeps out of the way.
  assert.equal(settingsByTier("advanced").length, 37);
  // The four deprecated keys live in `advanced` so the Settings UI keeps them out of the way.
  assert.equal(settingsByTier("advanced").filter((entry) => entry.deprecated === true).length, 4);
});

test("every key resolves, and subKey strips the section", () => {
  for (const key of manifestKeys()) {
    assert.ok(setting(key), `missing ${key}`);
    assert.ok(groupOf(key), `no group for ${key}`);
  }
  assert.equal(setting("mcpp.nope"), undefined);
  assert.equal(subKey("mcpp.cache.staleDays"), "cache.staleDays");
  assert.equal(subKey("cache.staleDays"), "cache.staleDays");
});

test("settingsInGroup returns the declared order", () => {
  const cache = settingsInGroup("cache");
  assert.ok(cache.length > 0);
  const orders = cache.map((entry) => entry.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.ok(cache.every((entry) => entry.group === "cache"));
});

test("the plan's defaults survive in the registry", () => {
  assert.equal(setting("mcpp.cache.staleDays")?.default, 3);
  assert.equal(setting("mcpp.toml.diagnostics.unknownSection")?.default, "warning");
  assert.equal(setting("mcpp.toml.diagnostics.unknownKey")?.default, "warning");
  assert.equal(setting("mcpp.toml.indexCompletion")?.default, false);
  assert.equal(setting("mcpp.languageService.readState")?.default, true);
  assert.equal(setting("mcpp.views.languageServer.show")?.default, true);
  assert.equal(setting("mcpp.ui.statusBar.showLanguageServer")?.default, false);
  assert.equal(setting("mcpp.runtime.timeoutSeconds")?.default, 30);
  assert.deepEqual(setting("mcpp.views.cache.ageBuckets")?.default, ["1d", "7d", "30d"]);
});

test("the four deprecated settings are declared and not public", () => {
  for (const key of ["mcpp.clangd.path", "mcpp.modulesSupport", "mcpp.configureCppTools", "mcpp.tomlCompletion"]) {
    const current = setting(key);
    assert.ok(current, `missing deprecated ${key}`);
    assert.equal(current.deprecated, true);
    assert.equal(current.tier, "advanced");
    assert.equal(typeof current.deprecationMessage, "string");
  }
});

test("renamed settings point forward, and the alias resolves", () => {
  assert.deepEqual(renamedKeys(), [{ from: "mcpp.tomlCompletion", to: "mcpp.toml.completion" }]);
  assert.equal(aliasedKey("mcpp.tomlCompletion"), "mcpp.toml.completion");
  assert.equal(aliasedKey("mcpp.path"), undefined);
});

test("groupedKeys covers every setting exactly once", () => {
  const grouped = groupedKeys();
  assert.equal(grouped.length, SETTINGS.length);
  assert.equal(new Set(grouped).size, SETTINGS.length);
});
