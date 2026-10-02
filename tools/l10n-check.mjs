#!/usr/bin/env node
/**
 * Localization gates. Exits 1 on any of:
 *
 *  1. a runtime string used through `t("…")` in `src/**` has no entry in
 *     `data/i18n/zh-cn.json` (a new hardcoded string is also a new *missing*
 *     translation, which is what stops the drift);
 *  2. `package.nls.json` and `package.nls.zh-cn.json` do not have identical key
 *     sets (a translated key that no longer exists is dead weight, a missing one
 *     shows English to a Chinese user);
 *  3. a `%key%` reference in `package.json` is absent from `package.nls.json`.
 *
 * Unused translations are reported as warnings only: a string may legitimately
 * be waiting for the feature that uses it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const warnings = [];

function readJson(file) {
  if (!fs.existsSync(file)) {
    problems.push(`${path.relative(root, file)}: missing`);
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${path.relative(root, file)}: invalid JSON (${error.message})`);
    return undefined;
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- 1. runtime strings
// Two shapes count as "used": a literal `t("…")`, and a deferred label key
// `{ key: "…" }` — the tree models carry those and `treeProvider.resolveLabel`
// translates them at render time, which a scan for `t(` cannot see.
const USAGE = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
const LABEL_KEY = /\bkey:\s*"((?:[^"\\]|\\.)*)"/g;
// `{ key: "…" }` is only a translatable label in the tree models. Elsewhere —
// `mcppls/contract.ts` — the same shape holds capability identifiers, which are
// protocol names and must never be translated.
const LABEL_KEY_FILES = [path.join(root, "src", "views")];
const used = new Map();
for (const file of walk(path.join(root, "src"))) {
  const text = fs.readFileSync(file, "utf8");
  const patterns = [USAGE];
  if (LABEL_KEY_FILES.some((dir) => file.startsWith(dir))) {
    patterns.push(LABEL_KEY);
  }
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const key = match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
      if (!used.has(key)) used.set(key, path.relative(root, file));
    }
  }
}

const zhRuntime = readJson(path.join(root, "data", "i18n", "zh-cn.json")) ?? {};
for (const [key, where] of used) {
  if (!(key in zhRuntime)) {
    problems.push(`data/i18n/zh-cn.json: missing translation for ${JSON.stringify(key)} (used in ${where})`);
  }
}
for (const key of Object.keys(zhRuntime)) {
  if (!used.has(key)) warnings.push(`data/i18n/zh-cn.json: unused string ${JSON.stringify(key)}`);
}

// ------------------------------------------------- 2. package.nls key sets
const nlsEn = readJson(path.join(root, "package.nls.json")) ?? {};
const nlsZh = readJson(path.join(root, "package.nls.zh-cn.json")) ?? {};
const enKeys = new Set(Object.keys(nlsEn));
const zhKeys = new Set(Object.keys(nlsZh));
for (const key of enKeys) {
  if (!zhKeys.has(key)) problems.push(`package.nls.zh-cn.json: missing key ${JSON.stringify(key)}`);
}
for (const key of zhKeys) {
  if (!enKeys.has(key)) problems.push(`package.nls.zh-cn.json: key ${JSON.stringify(key)} is not in package.nls.json`);
}

// --------------------------------------------- 3. %key% references resolve
const manifest = readJson(path.join(root, "package.json")) ?? {};
const references = new Set();
(function scan(value) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/%([^%]+)%/g)) references.add(match[1]);
  } else if (Array.isArray(value)) {
    value.forEach(scan);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(scan);
  }
})(manifest);
for (const key of references) {
  if (!enKeys.has(key)) problems.push(`package.json: %${key}% has no entry in package.nls.json`);
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  console.error(`l10n-check: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`l10n-check: ok (${used.size} runtime string(s), ${enKeys.size} manifest key(s))`);
