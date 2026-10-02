#!/usr/bin/env node
/**
 * `src/commands/menu.ts` + `@vscode/codicons` -> `media/quick-menu/*.svg`.
 *
 * **Why this file exists.** A quick pick row paints its `iconPath` as a
 * `background-image`; only a `ThemeIcon` becomes a font glyph, and VS Code drops
 * that icon's colour (see the note at the top of `src/commands/menu.ts`). So the
 * only way to give a quick pick row a coloured icon is to hand it a coloured
 * image, and the only honest way to produce twenty of those is to generate them
 * from the same table that defines the menu.
 *
 * Each glyph comes from `@vscode/codicons` — the artwork VS Code's own codicon
 * font is built from, pinned in `devDependencies` — and each colour is the
 * **default** light or dark value of the matching `charts.*` theme token, read
 * out of VS Code 1.132's colour registry. That is what makes the menu and the
 * project tree agree: the tree hands `charts.blue` to a `ThemeIcon` and the theme
 * paints it, here the same default value is baked in. A custom theme that
 * redefines `charts.*` therefore moves the tree icons and not these — the
 * documented cost of an image, and the reason `neutral` uses `foreground`.
 *
 * Two files per row, one per theme, because `iconPath` takes a `{ light, dark }`
 * pair and VS Code picks by the active theme. A single mid-tone would be a
 * compromise in both themes.
 *
 * `--check` re-derives everything in memory and fails on any difference —
 * including a file in `media/quick-menu/` that nothing asks for — so
 * `npm run check:icons` and `test/commands/menu.test.ts` keep the committed
 * assets exactly equal to the table.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MENU = path.join(root, "src", "commands", "menu.ts");
const GLYPHS = path.join(root, "node_modules", "@vscode", "codicons", "src", "icons");
const OUTPUT = path.join(root, "media", "quick-menu");

const THEMES = ["dark", "light"];

/**
 * The palette, as the default values of the theme tokens the project tree names.
 *
 * Verified against VS Code 1.132's colour registry:
 *
 * - `charts.blue`   = `editorInfo.foreground`      -> #59a4f9 / #0063d3
 * - `charts.green`                                -> #89d185 / #388a34
 * - `charts.purple`                               -> #b180d7 / #652d90
 * - `charts.yellow` = `editorWarning.foreground`   -> #cca700 / #bf8803
 * - `charts.red`    = `editorError.foreground`     -> #f14c4c / #e51400
 * - `neutral`       = `foreground`                 -> #cccccc / #616161
 *
 * `charts.orange` is deliberately absent: it resolves to
 * `minimap.findMatchHighlight` -> `editor.findMatchHighlightBackground`, which is
 * `#EA5C00` at 33% alpha. As a glyph colour that is a washed-out smear in both
 * themes, which is why destructive rows use `red` instead.
 */
const PALETTE = {
  blue: { dark: "#59a4f9", light: "#0063d3" },
  green: { dark: "#89d185", light: "#388a34" },
  purple: { dark: "#b180d7", light: "#652d90" },
  yellow: { dark: "#cca700", light: "#bf8803" },
  red: { dark: "#f14c4c", light: "#e51400" },
  neutral: { dark: "#cccccc", light: "#616161" },
};

/**
 * The `(icon, colour)` pairs the menu table asks for.
 *
 * The table is read as text rather than imported: it is TypeScript, and the row
 * shape is fixed and machine-checked (`test/commands/menu.test.ts` walks the
 * same table and stats the files, so a row this parser misses fails the suite
 * rather than the build). The two counts below are what stops a reformat from
 * quietly dropping a row.
 */
function menuRows() {
  const text = fs.readFileSync(MENU, "utf8");
  const rows = [...text.matchAll(/\{\s*labelKey: "(?:[^"\\]|\\.)*"[^}]*?icon: "([a-z0-9-]+)",\s*iconColor: "([a-z]+)"/g)].map(
    (match) => ({ icon: match[1], colour: match[2] }),
  );
  // A row starts with a quoted `labelKey`; the interface's `labelKey: string;`
  // and the group table's `{ id: …, labelKey: … }` do not.
  const declared = [...text.matchAll(/\{\s*labelKey: "/g)].length;
  if (rows.length !== declared) {
    throw new Error(`${MENU}: parsed ${rows.length} of ${declared} rows; the table's shape changed`);
  }
  for (const row of rows) {
    if (PALETTE[row.colour] === undefined) {
      throw new Error(`${MENU}: ${row.icon} asks for the colour "${row.colour}", which is not in the palette`);
    }
  }
  return rows;
}

/** One glyph, recoloured. The `currentColor` in the source is the theme's job. */
function glyph(name, hex) {
  const file = path.join(GLYPHS, `${name}.svg`);
  if (!fs.existsSync(file)) {
    throw new Error(`${file}: no such codicon (is @vscode/codicons installed and current?)`);
  }
  const svg = fs.readFileSync(file, "utf8");
  if (!svg.includes("currentColor")) {
    throw new Error(`${file}: no currentColor to replace`);
  }
  return svg.replaceAll("currentColor", hex);
}

/** Every file this generator owns, as `name -> contents`. */
function assets() {
  const files = new Map();
  for (const { icon, colour } of menuRows()) {
    for (const theme of THEMES) {
      files.set(`${icon}--${colour}--${theme}.svg`, glyph(icon, PALETTE[colour][theme]));
    }
  }
  return files;
}

function existing() {
  if (!fs.existsSync(OUTPUT)) {
    return [];
  }
  return fs.readdirSync(OUTPUT).sort();
}

const files = assets();
const relative = (name) => path.relative(root, path.join(OUTPUT, name));

if (process.argv.includes("--check")) {
  const problems = [];
  for (const [name, expected] of files) {
    const file = path.join(OUTPUT, name);
    if (!fs.existsSync(file)) {
      problems.push(`${relative(name)} is missing`);
    } else if (fs.readFileSync(file, "utf8") !== expected) {
      problems.push(`${relative(name)} is out of date`);
    }
  }
  for (const name of existing()) {
    if (!files.has(name)) {
      problems.push(`${relative(name)} is not asked for by ${path.relative(root, MENU)}`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`error: ${problem}`);
    }
    console.error(`error: run \`npm run gen:menuicons\` and commit the result`);
    process.exit(1);
  }
  console.log(`check-generators: ${files.size} quick menu icon(s) match ${path.relative(root, MENU)}`);
} else {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const wanted = new Set(files.keys());
  let removed = 0;
  for (const name of existing()) {
    if (!wanted.has(name)) {
      fs.rmSync(path.join(OUTPUT, name));
      removed += 1;
    }
  }
  let written = 0;
  for (const [name, contents] of files) {
    const file = path.join(OUTPUT, name);
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== contents) {
      fs.writeFileSync(file, contents);
      written += 1;
    }
  }
  console.log(`generate-quick-menu-icons: wrote ${written}, removed ${removed}, total ${files.size}`);
}
