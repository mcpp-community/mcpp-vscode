import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { controllerLabels } from "../../src/cli/labels";

/**
 * A button label is *shown* **and** *compared*: `showWarningMessage` replies
 * with the label the user pressed, and the caller does
 * `choice !== labels.confirmInstall`. Two literals — or two buttons sharing one
 * label — would silently desynchronise display and comparison, and a translated
 * label would never match at all. These tests pin the identity rule.
 */

test("每个按钮标签非空且互不相同", () => {
  const values = Object.values(controllerLabels());
  assert.ok(values.length >= 8, `只找到 ${values.length} 个按钮标签`);
  for (const value of values) {
    assert.ok(value.trim().length > 0, "按钮标签不能为空");
  }
  assert.equal(new Set(values).size, values.length, "两个按钮不能显示同一个标签：回执将无法区分");
});

test("每次取用返回同一组标签", () => {
  // 控制器在不同的分支里各自调用 `controllerLabels()`；只要工厂是确定性的，
  // 显示用的值和判定用的值就总是同一个。
  assert.deepEqual(controllerLabels(), controllerLabels());
});

test("按钮标签在 src/cli/labels.ts 之外没有第二份字面量", () => {
  const root = process.cwd();
  const sources = ["src/cli/controller.ts", "src/extension.ts", "src/cli/newProject.ts"].map((file) =>
    readFileSync(path.join(root, file), "utf8"),
  );
  for (const value of Object.values(controllerLabels())) {
    const literal = JSON.stringify(value);
    const copies = sources.filter((source) => source.includes(literal)).length;
    assert.equal(copies, 0, `按钮标签 ${literal} 在 src/cli/labels.ts 之外又写了一份`);
  }
});

test("内联的确认按钮也只有一个字面量（显示与判定同源）", () => {
  const root = process.cwd();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["src/cli/controller.ts", 't("Create and open")'],
    ["src/extension.ts", 't("Confirm one-click setup")'],
  ];
  for (const [file, literal] of cases) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.equal(
      source.split(literal).length - 1,
      1,
      `${file}: ${literal} 必须只定义一次（否则显示与 === 判定会脱节）`,
    );
  }
});
