/**
 * The settings registry: **the single source of truth** for everything this
 * extension makes configurable.
 *
 * `data/config-registry.json` holds the declaration; `package.json`'s
 * `contributes.configuration` is hand-written but held to it by
 * `tools/check-config.mjs`, and `docs/settings.md` is generated from it. The
 * configuration panel (`src/config/panel.ts`) renders it, and
 * `mcpp: environment self-check` dumps the entries the user has changed.
 *
 * Shape rules are enforced by `tools/check-config.mjs` and by the unit tests:
 * unique keys, every `group` present in `groups`, ascending `order` within a
 * group, and a `default` that `validate.ts` accepts.
 */

import registryJson from "../../data/config-registry.json";

export type SettingType = "boolean" | "string" | "number" | "array";
export type SettingScope = "resource" | "window";
export type SettingTier = "public" | "advanced";
export type SettingApplies = "immediate" | "next-build" | "next-clean" | "view-reload";

export interface SettingEntry {
  key: string;
  type: SettingType;
  default: boolean | string | number | string[];
  enum?: string[];
  minimum?: number;
  maximum?: number;
  scope: SettingScope;
  group: string;
  order: number;
  tier: SettingTier;
  applies: SettingApplies;
  since: string;
  deprecated?: boolean;
  aliases?: string[];
  title: string;
  description: string;
  deprecationMessage?: string;
}

export interface SettingGroup {
  id: string;
  order: number;
  title: string;
}

interface RegistryFile {
  version: number;
  groups: SettingGroup[];
  settings: SettingEntry[];
}

const registry = registryJson as unknown as RegistryFile;

export const SETTINGS: readonly SettingEntry[] = registry.settings;
export const GROUPS: readonly SettingGroup[] = [...registry.groups].sort((a, b) => a.order - b.order);

const BY_KEY = new Map(SETTINGS.map((entry) => [entry.key, entry]));
const GROUP_BY_ID = new Map(GROUPS.map((group) => [group.id, group]));

/** The section every key lives under; VS Code's `getConfiguration` needs it. */
export const SECTION = "mcpp";

/** `"mcpp.cache.staleDays"` -> `"cache.staleDays"`. */
export function subKey(key: string): string {
  return key.startsWith(`${SECTION}.`) ? key.slice(SECTION.length + 1) : key;
}

export function setting(key: string): SettingEntry | undefined {
  return BY_KEY.get(key);
}

export function requireSetting(key: string): SettingEntry {
  const entry = BY_KEY.get(key);
  if (entry === undefined) {
    throw new Error(`unknown mcpp setting: ${key}`);
  }
  return entry;
}

export function groupOf(key: string): SettingGroup | undefined {
  const entry = BY_KEY.get(key);
  return entry === undefined ? undefined : GROUP_BY_ID.get(entry.group);
}

/** Entries of one group, in their declared order. */
export function settingsInGroup(groupId: string): SettingEntry[] {
  return SETTINGS.filter((entry) => entry.group === groupId)
    .slice()
    .sort((a, b) => a.order - b.order);
}

export function settingsByTier(tier: SettingTier): SettingEntry[] {
  return SETTINGS.filter((entry) => entry.tier === tier);
}

/** Keys this build mentions in the manifest, in registry order. */
export function manifestKeys(): string[] {
  return SETTINGS.map((entry) => entry.key);
}

/** The key an old name now resolves to, or `undefined` when it is unknown. */
export function aliasedKey(oldKey: string): string | undefined {
  for (const entry of SETTINGS) {
    if (entry.aliases?.includes(oldKey) === true) {
      return entry.key;
    }
  }
  return undefined;
}

/** Old name -> current name, for the one-time migration prompt. */
export function renamedKeys(): Array<{ from: string; to: string }> {
  const pairs: Array<{ from: string; to: string }> = [];
  for (const entry of SETTINGS) {
    for (const alias of entry.aliases ?? []) {
      pairs.push({ from: alias, to: entry.key });
    }
  }
  return pairs;
}

/**
 * The registry's own invariants. Returns a list of problems (empty when sound).
 *
 * The same rules live in `tools/check-config.mjs`, but having them here means a
 * malformed `data/config-registry.json` is caught by the unit tests as well —
 * and lets `activate()` log a single line instead of failing feature by feature.
 */
export function registryShapeProblems(): string[] {
  const problems: string[] = [];
  const groupIds = new Set<string>();
  for (const group of GROUPS) {
    if (groupIds.has(group.id)) {
      problems.push(`duplicate group ${group.id}`);
    }
    groupIds.add(group.id);
    if (typeof group.title !== "string" || group.title.length === 0) {
      problems.push(`group ${group.id} has no title`);
    }
  }
  const seen = new Set<string>();
  const lastOrder = new Map<string, number>();
  for (const entry of SETTINGS) {
    if (!entry.key.startsWith(`${SECTION}.`)) {
      problems.push(`${entry.key} is not a ${SECTION}.* key`);
    }
    if (seen.has(entry.key)) {
      problems.push(`duplicate key ${entry.key}`);
    }
    seen.add(entry.key);
    if (!groupIds.has(entry.group)) {
      problems.push(`${entry.key} names undeclared group ${entry.group}`);
    }
    const previous = lastOrder.get(entry.group);
    if (previous !== undefined && !(entry.order > previous)) {
      problems.push(`${entry.group} order is not ascending at ${entry.key}`);
    }
    lastOrder.set(entry.group, entry.order);
    if (entry.title.length === 0 || entry.description.length === 0) {
      problems.push(`${entry.key} has an empty title or description`);
    }
    if (entry.enum !== undefined && !entry.enum.includes(entry.default as string)) {
      problems.push(`${entry.key} default is not in its enum`);
    }
    if (entry.deprecated === true && entry.deprecationMessage === undefined) {
      problems.push(`${entry.key} is deprecated without a deprecationMessage`);
    }
  }
  return problems;
}

/** Every setting key, ordered by group then by the group's own order. */
export function groupedKeys(): string[] {
  const keys: string[] = [];
  for (const group of GROUPS) {
    for (const entry of settingsInGroup(group.id)) {
      keys.push(entry.key);
    }
  }
  return keys;
}
