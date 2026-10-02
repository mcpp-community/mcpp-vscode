#!/usr/bin/env node
/**
 * `data/i18n/<locale>.json` -> `l10n/bundle.l10n.<locale>.json`.
 *
 * The runtime bundle is what `vscode.l10n` reads, so it must be generated rather
 * than hand-maintained: `data/i18n` is the single source of truth and
 * `tools/l10n-check.mjs` holds the source strings to it.
 *
 * The English bundle is intentionally empty: English is the key, so a missing
 * translation already degrades to English without a lookup table.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "data", "i18n");
const targetDir = path.join(root, "l10n");

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertStringMap(file, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file}: expected a JSON object of string -> string`);
  }
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(`${file}: key ${JSON.stringify(key)} does not map to a non-empty string`);
    }
    if (key.trim().length === 0) {
      throw new Error(`${file}: empty key`);
    }
  }
}

fs.mkdirSync(targetDir, { recursive: true });

const locales = fs.existsSync(sourceDir)
  ? fs.readdirSync(sourceDir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5))
  : [];

let written = 0;
for (const locale of locales) {
  const file = path.join(sourceDir, `${locale}.json`);
  const bundle = readJson(file, {});
  assertStringMap(file, bundle);
  const out = path.join(targetDir, `bundle.l10n.${locale}.json`);
  fs.writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
  written += 1;
}

// The default bundle carries no translations: English text is the key.
const defaultBundle = path.join(targetDir, "bundle.l10n.json");
fs.writeFileSync(defaultBundle, "{}\n");

console.log(`generate-l10n: wrote ${written} locale bundle(s) + the default bundle into l10n/`);
