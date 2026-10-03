import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  QUICK_MENU_COLOURS,
  QUICK_MENU_GROUPS,
  quickMenuIconAsset,
  quickMenuItems,
} from "../../src/commands/menu";
import { LANGUAGE_SERVER_COMMANDS } from "../../src/commands/ids";
import { buildProjectTree } from "../../src/views/models";

/**
 * The status-bar menu is data, so it can be checked as data.
 *
 * The quick pick renders its sections from `item.group`, which means two things
 * have to hold for the menu to look like a menu: the entries must be written in
 * the same order as `QUICK_MENU_GROUPS` (otherwise a section is emitted twice),
 * and every label — each row *and* each heading — must have a translation.
 * Neither is visible to `tools/l10n-check.mjs`, which only sees literal
 * `t("…")` calls, so both are gated here instead.
 *
 * The coloured icons are files on disk, and this file is where the table and the
 * files are compared. That is the only thing keeping
 * `tools/generate-quick-menu-icons.mjs` honest: the generator writes what it
 * parsed, and this walk fails if a row has no asset for either theme.
 */

const zh = JSON.parse(readFileSync(path.join(process.cwd(), "data", "i18n", "zh-cn.json"), "utf8")) as Record<
  string,
  string
>;

const ICON_DIRECTORY = path.join(process.cwd(), "media", "quick-menu");

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

test("the C++ Modules section offers the log capture and where it lands", () => {
  // The section is the only place the whole language-service story is assembled,
  // so it has to carry both halves of a bug report: capture the logs, and get
  // back to what was captured. `exportDiagnosticBundle` is the capture (upstream
  // labels it 抓取日志（含报告）), and the two folders are the log directory the
  // server writes to and the zip the last capture wrote.
  const services = quickMenuItems.filter((item) => item.group === "languageServer").map((item) => item.command);
  for (const command of [
    LANGUAGE_SERVER_COMMANDS.exportDiagnosticBundle,
    LANGUAGE_SERVER_COMMANDS.collectReport,
    LANGUAGE_SERVER_COMMANDS.openLogFolder,
    LANGUAGE_SERVER_COMMANDS.revealBundle,
  ]) {
    assert.ok(services.includes(command), `the menu does not offer ${command}`);
  }
  // And every id the section names is registered by the view that owns it.
  const view = readFileSync(path.join(process.cwd(), "src", "views", "languageServerView.ts"), "utf8");
  for (const command of services) {
    const name = Object.entries(LANGUAGE_SERVER_COMMANDS).find(([, id]) => id === command)?.[0];
    assert.ok(
      name !== undefined && view.includes(`LANGUAGE_SERVER_COMMANDS.${name}`),
      `${command} is in the menu but nothing registers it`,
    );
  }
});

test("no command is offered twice", () => {
  const commands = quickMenuItems.map((item) => item.command);
  assert.equal(new Set(commands).size, commands.length);
});

test("every row has a generated coloured icon for both themes", () => {
  for (const item of quickMenuItems) {
    assert.ok(
      (QUICK_MENU_COLOURS as readonly string[]).includes(item.iconColor),
      `${item.command} asks for the colour ${JSON.stringify(item.iconColor)}`,
    );
    for (const theme of ["dark", "light"] as const) {
      const file = path.join(ICON_DIRECTORY, quickMenuIconAsset(item, theme));
      assert.ok(existsSync(file), `${item.command} has no ${theme} icon: ${path.relative(process.cwd(), file)}`);
      assert.ok(statSync(file).size > 0, `${file} is empty`);
      // A baked colour, not the codicon's `currentColor`: a quick pick draws this
      // as a background-image, where `currentColor` resolves to nothing.
      assert.doesNotMatch(readFileSync(file, "utf8"), /currentColor/, `${file} is still theme-coloured`);
    }
  }
});

test("a row and its project-view twin agree on icon and colour", () => {
  // The same command shown twice must look the same twice. The tree names a
  // theme token and the menu names a palette word, which is exactly the kind of
  // pair that drifts; `charts.<word>` is the join between them. Two facts keep
  // the scan honest: the walk is **recursive** (the language-service actions
  // sit two levels down inside 基本信息 — a one-level scan is how the
  // export-bundle row drifted to two different icons), and the icon is compared
  // for every twin while the colour is compared only where the tree row has
  // one (the language-service rows are deliberately mono).
  const flatten = (nodes: readonly unknown[]): Array<{ command?: { command?: string }; icon?: string; iconColor?: string }> => {
    const out: Array<{ command?: { command?: string }; icon?: string; iconColor?: string }> = [];
    for (const node of nodes as Array<{ command?: { command?: string }; icon?: string; iconColor?: string; children?: unknown[] }>) {
      out.push(node);
      if (Array.isArray(node.children)) {
        out.push(...flatten(node.children));
      }
    }
    return out;
  };
  const tree = buildProjectTree({ root: "/w", name: "greeter", version: "0.1.0" });
  const twins = new Map(
    flatten(tree)
      .filter((node) => node.command?.command !== undefined)
      .map((node) => [node.command?.command ?? "", node] as const),
  );
  let compared = 0;
  let coloured = 0;
  for (const item of quickMenuItems) {
    const twin = twins.get(item.command);
    if (twin === undefined || twin.icon === undefined) {
      continue;
    }
    assert.equal(item.icon, twin.icon, `${item.command} uses a different icon in the two places`);
    compared += 1;
    if (twin.iconColor === undefined) {
      continue;
    }
    assert.equal(`charts.${item.iconColor}`, twin.iconColor, `${item.command} uses a different colour`);
    coloured += 1;
  }
  assert.equal(coloured, 7, "the colour-compared commands must all be compared; did the tree or the menu change shape?");
  assert.ok(compared > coloured, "the mono language-service twins must be compared on their icons too");
});
