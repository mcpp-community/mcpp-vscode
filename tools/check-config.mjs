#!/usr/bin/env node
/**
 * The registry is the single source of truth for settings; `package.json` is
 * hand-written but must agree with it. This is the gate.
 *
 * Checks:
 *   registry   – version present, groups unique, keys unique and prefixed,
 *                every `group` declared, `order` ascending within a group,
 *                enums non-empty and containing the default, numeric bounds
 *                consistent with the default, arrays hold strings;
 *   package    – exactly the registry's keys under `contributes.configuration`,
 *                each with the same type/default/enum/scope and the `%…%`
 *                title/description the registry names;
 *   nls        – `<key>.title` and `<key>.description` exist, and deprecated
 *                entries also carry `<key>.deprecationMessage`.
 *
 * Exit 1 lists every mismatch; there is no "fix it for me" mode on purpose –
 * rewriting package.json would produce an unreviewable diff.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const read = (relative) => {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    problems.push(`${relative}: missing`);
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${relative}: invalid JSON (${error.message})`);
    return undefined;
  }
};

const registry = read("data/config-registry.json");
const manifest = read("package.json");
const nlsEn = read("package.nls.json") ?? {};

if (registry === undefined || manifest === undefined) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}

const groups = registry.groups ?? [];
const settings = registry.settings ?? [];
const groupIds = new Set();
for (const group of groups) {
  if (typeof group.id !== "string" || group.id.length === 0) problems.push("registry: a group has no id");
  if (groupIds.has(group.id)) problems.push(`registry: duplicate group ${group.id}`);
  groupIds.add(group.id);
  if (typeof group.title !== "string" || group.title.length === 0) problems.push(`registry: group ${group.id} has no title`);
  if (typeof group.order !== "number") problems.push(`registry: group ${group.id} has no numeric order`);
}

const seen = new Map();
const orderInGroup = new Map();
for (const entry of settings) {
  const where = entry.key ?? "<entry without key>";
  if (typeof entry.key !== "string" || !entry.key.startsWith("mcpp.")) {
    problems.push(`registry: ${where} is not a mcpp.* key`);
    continue;
  }
  if (seen.has(entry.key)) problems.push(`registry: duplicate key ${entry.key}`);
  seen.set(entry.key, entry);
  if (!groupIds.has(entry.group)) problems.push(`registry: ${where} names undeclared group ${entry.group}`);
  const previous = orderInGroup.get(entry.group);
  if (previous !== undefined && !(entry.order > previous)) {
    problems.push(`registry: ${entry.group} order is not ascending at ${where} (${previous} -> ${entry.order})`);
  }
  orderInGroup.set(entry.group, entry.order);
  if (typeof entry.title !== "string" || entry.title.length === 0) problems.push(`registry: ${where} has no title`);
  if (typeof entry.description !== "string" || entry.description.length === 0) {
    problems.push(`registry: ${where} has no description`);
  }
  if (!["public", "advanced"].includes(entry.tier)) problems.push(`registry: ${where} has tier ${entry.tier}`);
  if (!["immediate", "next-build", "next-clean", "view-reload"].includes(entry.applies)) {
    problems.push(`registry: ${where} has applies ${entry.applies}`);
  }
  if (!["resource", "window"].includes(entry.scope)) problems.push(`registry: ${where} has scope ${entry.scope}`);
  if (entry.enum !== undefined) {
    if (!Array.isArray(entry.enum) || entry.enum.length === 0) problems.push(`registry: ${where} has an empty enum`);
    else if (!entry.enum.includes(entry.default)) problems.push(`registry: ${where} default is not in its enum`);
  }
  const declaredType = entry.type === "array" ? "array" : entry.type;
  const actualType = Array.isArray(entry.default) ? "array" : typeof entry.default;
  if (declaredType !== actualType) {
    problems.push(`registry: ${where} type ${entry.type} does not match default ${JSON.stringify(entry.default)}`);
  }
  if (entry.type === "number") {
    if (entry.minimum !== undefined && entry.default < entry.minimum) problems.push(`registry: ${where} default < minimum`);
    if (entry.maximum !== undefined && entry.default > entry.maximum) problems.push(`registry: ${where} default > maximum`);
  }
}

// ------------------------------------------------------------------ package
const properties = manifest.contributes?.configuration?.properties ?? {};
const packageKeys = Object.keys(properties).filter((key) => key.startsWith("mcpp."));
for (const key of packageKeys) {
  if (!seen.has(key)) problems.push(`package.json: ${key} is not in the registry`);
}
for (const [key, entry] of seen) {
  const property = properties[key];
  if (property === undefined) {
    problems.push(`package.json: ${key} is missing from contributes.configuration`);
    continue;
  }
  if (property.type !== entry.type) problems.push(`package.json: ${key} type ${property.type} != registry ${entry.type}`);
  if (JSON.stringify(property.default) !== JSON.stringify(entry.default)) {
    problems.push(`package.json: ${key} default ${JSON.stringify(property.default)} != registry ${JSON.stringify(entry.default)}`);
  }
  if (entry.enum !== undefined && JSON.stringify(property.enum) !== JSON.stringify(entry.enum)) {
    problems.push(`package.json: ${key} enum differs from the registry`);
  }
  if (property.scope !== undefined && property.scope !== entry.scope) {
    problems.push(`package.json: ${key} scope ${property.scope} != registry ${entry.scope}`);
  }
  if (property.minimum !== undefined && property.minimum !== entry.minimum) {
    problems.push(`package.json: ${key} minimum differs from the registry`);
  }
  if (property.maximum !== undefined && property.maximum !== entry.maximum) {
    problems.push(`package.json: ${key} maximum differs from the registry`);
  }
  if (property.description !== `%${key}.title%`) {
    problems.push(`package.json: ${key} description must be %${key}.title%`);
  }
  if (property.markdownDescription !== `%${key}.description%`) {
    problems.push(`package.json: ${key} markdownDescription must be %${key}.description%`);
  }
  if (entry.deprecated === true && property.deprecationMessage !== `%${key}.deprecationMessage%`) {
    problems.push(`package.json: ${key} is deprecated but has no deprecationMessage reference`);
  }
}

// ---------------------------------------------------------------------- nls
for (const [key, entry] of seen) {
  for (const suffix of ["title", "description"]) {
    if (typeof nlsEn[`${key}.${suffix}`] !== "string") problems.push(`package.nls.json: ${key}.${suffix} is missing`);
  }
  if (nlsEn[`${key}.title`] !== entry.title) problems.push(`package.nls.json: ${key}.title differs from the registry title`);
  if (nlsEn[`${key}.description`] !== entry.description) {
    problems.push(`package.nls.json: ${key}.description differs from the registry description`);
  }
  if (entry.deprecated === true && typeof nlsEn[`${key}.deprecationMessage`] !== "string") {
    problems.push(`package.nls.json: ${key}.deprecationMessage is missing`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  console.error(`check-config: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(
  `check-config: ok (${groups.length} groups, ${settings.length} settings, ` +
    `${settings.filter((entry) => entry.tier === "public").length} public)`,
);
