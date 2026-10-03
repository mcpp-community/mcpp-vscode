import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The cache view's stylesheet, checked as text.
 *
 * Geometry cannot be measured outside a browser, but the properties §8.1
 * actually asks for can be: theme tokens only, tabular figures, the 26 / 12 / 11
 * scale, one 6 px primary bar, a legend that flows as one line, and a narrow-width
 * answer. These assertions are what stops the next edit from quietly turning the
 * sidebar back into three 14 px bars and a card per kind.
 */

const css = readFileSync(path.join(process.cwd(), "media", "cache.css"), "utf8");

/** Every declaration that can carry a colour. */
const COLOUR_DECLARATION =
  /(?:^|[;{\s])(border-bottom|border-top|border-left|border-right|border-color|border|background-color|background|box-shadow|outline-color|outline|text-decoration-color|text-decoration|fill|stroke|color)\s*:\s*([^;}]+)/gi;

/** Values that are not a colour at all, so they cannot be a hard-coded one. */
const NOT_A_COLOUR = new Set([
  "transparent",
  "currentColor",
  "inherit",
  "initial",
  "unset",
  "none",
  "solid",
  "dashed",
  "dotted",
  "double",
  "underline",
  "line-through",
  "overline",
  "wavy",
  "0",
  "1px",
  "2px",
  "3px",
  "1",
]);

test("every colour comes from a --vscode-* token", () => {
  const offenders: string[] = [];
  for (const match of css.matchAll(COLOUR_DECLARATION)) {
    const property = match[1];
    const value = match[2].trim();
    // Strip the theme references: what is left must be geometry or a keyword.
    const rest = value.replace(/var\([^)]*\)/g, " ");
    for (const token of rest.split(/[\s,()]+/).filter((part) => part.length > 0)) {
      if (NOT_A_COLOUR.has(token)) continue;
      if (/^[\d.]+(px|em|rem|%|fr|deg)?$/.test(token)) continue;
      offenders.push(`${property}: ${value} (offending token "${token}")`);
    }
  }
  assert.deepEqual(offenders, [], `these declarations carry a literal colour:\n  ${offenders.join("\n  ")}`);
});

test("and no colour is hidden in a hex or function form either", () => {
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "a hex colour literal");
  assert.doesNotMatch(css, /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|light-dark)\(/i, "a functional colour");
});

test("the type scale is §8.1's 26 / 12 / 11 and the figures are tabular", () => {
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.metric-value\s*\{[^}]*font-size:\s*26px/);
  assert.match(css, /font-size:\s*12px/);
  assert.match(css, /font-size:\s*11px/);
});

test("one 14 px composition bar and 6 px everywhere else", () => {
  assert.match(css, /\.viz-bar\s*\{[^}]*height:\s*14px/);
  assert.match(css, /\.viz-bar-thin\s*\{[^}]*height:\s*6px/);
  // No third bar height sneaks in.
  const heights = [...css.matchAll(/height:\s*(\d+)px/g)].map((match) => Number(match[1]));
  assert.deepEqual([...new Set(heights)].sort((a, b) => a - b), [1, 6, 8, 14]);
});

test("the legend flows as one wrapped line separated by ·", () => {
  assert.match(css, /\.legend-inline\s*\{[^}]*display:\s*block/);
  assert.match(css, /\.legend-inline\s+\.legend-item\s*\{[^}]*display:\s*inline/);
  assert.match(css, /content:\s*" · "/);
  assert.doesNotMatch(css, /\.legend[^{]*\{[^}]*display:\s*grid/);
});

test("nothing in the stylesheet can force a 170 px sidebar to scroll sideways", () => {
  const minimums = [...css.matchAll(/min-width:\s*(\d+)px/g)].map((match) => Number(match[1]));
  for (const value of minimums) {
    assert.ok(value <= 170, `min-width: ${value}px is wider than the narrowest sidebar`);
  }
  assert.match(css, /\.actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /@media \(max-width: 260px\)/, "there is a rule for a narrow sidebar");
  // At 200 px the table stops being a table and each cell names its column.
  assert.match(css, /td\[data-head\]::before\s*\{[^}]*content:\s*attr\(data-head\)/);
});

test("the house rules survive: hidden, the focus ring and the dashed disabled state", () => {
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /button\[disabled\]/);
  assert.match(css, /button\[disabled\][^{]*\{[^}]*border-style:\s*dashed/);
});

test("the sections are separated by space, not by nested boxes", () => {
  // §8.1: "去掉多余色块边框，靠留白分节" — no block, card or viz draws a border.
  for (const selector of ["\\.block\\b", "\\.viz\\b", "\\.card\\b"]) {
    const rule = new RegExp(selector + "\\s*\\{[^}]*\\}", "g");
    for (const match of css.matchAll(rule)) {
      assert.doesNotMatch(match[0], /\bborder(-[a-z]+)?\s*:/, `${match[0]} draws a border`);
    }
  }
});
