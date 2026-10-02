import assert from "node:assert/strict";
import test from "node:test";

import { defaultValue, expectation, validateValue } from "../../src/config/validate";
import type { SettingEntry } from "../../src/config/registry";

function entry(overrides: Partial<SettingEntry>): SettingEntry {
  return {
    key: "mcpp.test.value",
    type: "boolean",
    default: true,
    scope: "resource",
    group: "advanced",
    order: 1,
    tier: "advanced",
    applies: "immediate",
    since: "0.5.0",
    title: "Test",
    description: "Test setting.",
    ...overrides,
  } as SettingEntry;
}

test("boolean accepts only booleans", () => {
  const current = entry({ type: "boolean", default: true });
  assert.deepEqual(validateValue(current, true), { ok: true, value: true });
  assert.deepEqual(validateValue(current, "true"), { ok: false, reason: "type" });
  assert.deepEqual(validateValue(current, undefined), { ok: false, reason: "type" });
  assert.deepEqual(validateValue(current, null), { ok: false, reason: "type" });
});

test("number enforces the declared bounds", () => {
  const current = entry({ type: "number", default: 3, minimum: 0, maximum: 365 });
  assert.deepEqual(validateValue(current, 3), { ok: true, value: 3 });
  assert.deepEqual(validateValue(current, 0), { ok: true, value: 0 });
  assert.deepEqual(validateValue(current, -1), { ok: false, reason: "minimum" });
  assert.deepEqual(validateValue(current, 366), { ok: false, reason: "maximum" });
  assert.deepEqual(validateValue(current, Number.NaN), { ok: false, reason: "type" });
  assert.deepEqual(validateValue(current, "3"), { ok: false, reason: "type" });
});

test("string enforces the enum when one is declared", () => {
  const current = entry({ type: "string", default: "auto", enum: ["auto", "en", "zh-cn"] });
  assert.deepEqual(validateValue(current, "en"), { ok: true, value: "en" });
  assert.deepEqual(validateValue(current, "fr"), { ok: false, reason: "enum" });
});

test("a free-form string accepts anything textual", () => {
  const current = entry({ type: "string", default: "" });
  assert.deepEqual(validateValue(current, "/usr/bin/mcpp"), { ok: true, value: "/usr/bin/mcpp" });
  assert.deepEqual(validateValue(current, 7), { ok: false, reason: "type" });
});

test("array accepts only arrays of strings", () => {
  const current = entry({ type: "array", default: ["-j", "4"] });
  assert.deepEqual(validateValue(current, ["-q"]), { ok: true, value: ["-q"] });
  assert.deepEqual(validateValue(current, []), { ok: true, value: [] });
  assert.deepEqual(validateValue(current, ["ok", 1]), { ok: false, reason: "items" });
  assert.deepEqual(validateValue(current, "-q"), { ok: false, reason: "type" });
});

test("validateValue copies arrays so callers cannot mutate the registry", () => {
  const current = entry({ type: "array", default: ["a"] });
  const result = validateValue(current, ["b"]);
  assert.equal(result.ok, true);
  (result.value as string[]).push("c");
  assert.deepEqual(current.default, ["a"]);
});

test("defaultValue also hands out a fresh array", () => {
  const current = entry({ type: "array", default: ["a"] });
  const first = defaultValue<string[]>(current);
  first.push("b");
  assert.deepEqual(defaultValue<string[]>(current), ["a"]);
});

test("expectation describes what a value should look like", () => {
  assert.equal(expectation(entry({ type: "string", default: "a", enum: ["a", "b"] })), "a | b");
  assert.equal(expectation(entry({ type: "number", default: 1, minimum: 0, maximum: 10 })), "0 … 10");
  assert.equal(expectation(entry({ type: "boolean", default: true })), "boolean");
  assert.equal(expectation(entry({ type: "array", default: [] })), "array of strings");
});
