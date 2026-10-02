import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { QUICK_MENU_GROUPS, quickMenuItems } from "../../src/commands/menu";

/**
 * The status-bar menu is data, so it can be checked as data.
 *
 * The quick pick renders its sections from `item.group`, which means two things
 * have to hold for the menu to look like a menu: the entries must be written in
 * the same order as `QUICK_MENU_GROUPS` (otherwise a section is emitted twice),
 * and every label — each row *and* each heading — must have a translation.
 * Neither is visible to `tools/l10n-check.mjs`, which only sees literal
 * `t("…")` calls, so both are gated here instead.
 */

const zh = JSON.parse(readFileSync(path.join(process.cwd(), "data", "i18n", "zh-cn.json"), "utf8")) as Record<
  string,
  string
>;

test("the entries are written in the declared group order", () => {
  const declared = QUICK_MENU_GROUPS.map((group) => group.id);
  const seen: string[] = [];
  for (const item of quickMenuItems) {
    if (seen[seen.length - 1] !== item.group) {
      seen.push(item.group);
    }
  }
  // No group may appear twice: a repeated section would print its heading again
  // in the middle of the list.
  assert.equal(new Set(seen).size, seen.length, `a group is used in two runs: ${seen.join(", ")}`);
  assert.deepEqual(seen, declared.filter((id) => seen.includes(id)));
});

test("every menu label has a translation, headings included", () => {
  for (const group of QUICK_MENU_GROUPS) {
    assert.ok(zh[group.labelKey] !== undefined, `no zh-cn translation for the heading ${JSON.stringify(group.labelKey)}`);
  }
  for (const item of quickMenuItems) {
    assert.ok(zh[item.labelKey] !== undefined, `no zh-cn translation for ${JSON.stringify(item.labelKey)}`);
  }
});

test("every entry carries a codicon id, not a rendered icon", () => {
  for (const item of quickMenuItems) {
    assert.match(item.icon, /^[a-z0-9-]+$/, `${item.command} has the icon ${JSON.stringify(item.icon)}`);
  }
});

test("no command is offered twice", () => {
  const commands = quickMenuItems.map((item) => item.command);
  assert.equal(new Set(commands).size, commands.length);
});
