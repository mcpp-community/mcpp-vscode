import assert from "node:assert/strict";
import test from "node:test";

import { format, localeFromEditorLanguage, missingTranslations, translate } from "../../src/i18n/translate";

const BUNDLE = { "Build failed ({0}).": "构建失败（{0}）。" } as const;

test("format substitutes positional placeholders", () => {
  assert.equal(format("a {0} b {1}", ["x", 2]), "a x b 2");
  assert.equal(format("no placeholders", []), "no placeholders");
  // An out-of-range placeholder is left alone rather than becoming "undefined".
  assert.equal(format("{0} {5}", ["x"]), "x {5}");
});

test("translate falls back to English for a missing entry", () => {
  assert.equal(translate("zh-cn", "Never translated", [], BUNDLE), "Never translated");
  assert.equal(translate("zh-cn", "Build failed ({0}).", ["gcc"], BUNDLE), "构建失败（gcc）。");
});

test("translate in English mode ignores the bundle", () => {
  assert.equal(translate("en", "Build failed ({0}).", ["gcc"], BUNDLE), "Build failed (gcc).");
});

test("an empty translation is treated as missing", () => {
  assert.equal(translate("zh-cn", "Empty", [], { Empty: "" }), "Empty");
});

test("localeFromEditorLanguage maps Chinese locales and everything else to English", () => {
  assert.equal(localeFromEditorLanguage("zh-cn"), "zh-cn");
  assert.equal(localeFromEditorLanguage("zh-TW"), "zh-cn");
  assert.equal(localeFromEditorLanguage("en"), "en");
  assert.equal(localeFromEditorLanguage("de"), "en");
  assert.equal(localeFromEditorLanguage(undefined), undefined);
});

test("missingTranslations reports only the gaps", () => {
  assert.deepEqual(missingTranslations(["a", "b"], { a: "A" }), ["b"]);
  assert.deepEqual(missingTranslations(["a"], { a: "A" }), []);
  assert.deepEqual(missingTranslations(["a"], { a: "" }), ["a"]);
});
