/**
 * The cache view's decisions, as **data**.
 *
 * Everything here is deliberately free of `vscode` and of the file system, so the
 * settings that shape the cache view can be tested directly:
 *
 * - whether the pre-v1 cache node is offered (`mcpp.cache.showLegacy`, §8 G6);
 * - what the panel is allowed to say about that cache;
 * - the warning node for `mcpp.cache.warnAboveGiB`;
 * - the extra confirmation `mcpp.cache.gc.confirmAboveGiB` adds;
 * - the snapshot the environment self-check reads (`showSelfCheck`, §8 G9).
 *
 * `src/cache/cacheView.ts` reads the settings and hands the values in; the
 * `vscode` layer therefore stays thin enough to read in one sitting.
 */

import { formatBytes } from "../util/format";

/** 1 GiB, binary — the unit both cache size settings are declared in. */
export const BYTES_PER_GIB = 1024 ** 3;

/**
 * A node built here rather than in `./models.ts`, so the tree model needs no
 * edit: the shape is structurally the tree's `TreeNode`. The cache view itself is
 * a sidebar `WebviewView` since §8.1 and no longer builds a tree, so this node is
 * kept as the policy (§8 G6) that the warning threshold is decided in one pure
 * place — the view states the same threshold in
 * `src/cache/cachePanelHtml.ts`'s warning banner.
 */
export interface CacheTreeNode {
  id: string;
  label: { key: string; args?: readonly (string | number)[] };
  description?: { key: string; args?: readonly (string | number)[] };
  tooltip?: { key: string; args?: readonly (string | number)[] };
  icon?: string;
  contextValue?: string;
  command?: { command: string; title: { key: string; args?: readonly (string | number)[] } };
  children?: readonly CacheTreeNode[];
}

/** `mcpp.cache.showLegacy`, as the view reads it. */
export interface LegacyGate {
  enabled: boolean;
  bytes?: number;
  files?: number;
  truncated?: boolean;
}

export type LegacyDisplay = "shown" | "off" | "empty" | "unknown";

/** Why the pre-v1 node is or is not in the tree. Pure, so the policy is testable. */
export function legacyDisplay(gate: LegacyGate): LegacyDisplay {
  if (!gate.enabled) {
    return "off";
  }
  if (gate.bytes === undefined) {
    return "unknown";
  }
  return gate.bytes > 0 ? "shown" : "empty";
}

/**
 * The figure the tree needs, or `undefined` when no node should exist. Kept next
 * to {@link legacyDisplay} so "the node renders only when the setting is on and
 * the directory is non-empty" is stated once.
 */
export function legacyBytesForTree(gate: LegacyGate): number | undefined {
  return legacyDisplay(gate) === "shown" ? gate.bytes : undefined;
}

/** What the panel may show: the same rule, plus the path it can offer to clean. */
export function legacyForPanel(
  gate: LegacyGate,
  path: string | undefined,
): { bytes: number; path?: string } | undefined {
  if (legacyDisplay(gate) !== "shown" || path === undefined) {
    return undefined;
  }
  return { bytes: gate.bytes ?? 0, path };
}

/**
 * The warning the tree shows when the shared cache reached `mcpp.cache.warnAboveGiB`.
 *
 * `0` — and a non-positive or unreadable threshold — disables the warning
 * entirely, which is what the registry's description promises. `bytes` must come
 * from the same read the rest of the view uses; a missing inventory is not a
 * warning (nothing was measured, so nothing is known to be large).
 */
export function buildCacheWarningNode(bytes: number, thresholdGiB: number): CacheTreeNode | undefined {
  if (!Number.isFinite(thresholdGiB) || thresholdGiB <= 0) {
    return undefined;
  }
  if (!Number.isFinite(bytes) || bytes < thresholdGiB * BYTES_PER_GIB) {
    return undefined;
  }
  const thresholdBytes = thresholdGiB * BYTES_PER_GIB;
  return {
    id: "cache.warning",
    label: { key: "Cache warning" },
    description: { key: "{0} · at or above {1}", args: [formatBytes(bytes), formatBytes(thresholdBytes)] },
    tooltip: {
      key: "The shared build cache is {0}. Raise or clear mcpp.cache.warnAboveGiB to change when this appears.",
      args: [formatBytes(bytes)],
    },
    icon: "warning",
    contextValue: "mcppCacheWarning",
    // The cache view is a sidebar `WebviewView` now, so the node points at the
    // view's own focus command (VS Code registers `<viewId>.focus` for every
    // contributed view) rather than at the removed `mcpp.showCachePanel`.
    command: { command: "mcpp.cache.focus", title: { key: "Cache statistics" } },
  };
}

/** `mcpp.cache.gc.confirmAboveGiB`: does this budget add a confirmation level? */
export function gcBudgetNeedsExtraConfirm(budgetGiB: number, confirmAboveGiB: number): boolean {
  if (!Number.isFinite(budgetGiB) || budgetGiB < 0) {
    return false;
  }
  if (!Number.isFinite(confirmAboveGiB) || confirmAboveGiB < 0) {
    return false;
  }
  // 0 means "confirm every cleanup", including the one with no budget at all.
  return confirmAboveGiB === 0 || budgetGiB >= confirmAboveGiB;
}

export interface GcBudgetDialog {
  /** Substituted into the caller's `detail` key: the budget in GiB. */
  args: readonly (string | number)[];
}

/**
 * The data the extra level's dialogue needs.
 *
 * It deliberately carries no sentences: the caller writes the translation
 * literals (as `src/cli/clean.ts` does with its `titleKey`/`detailKey`), which is
 * what makes `tools/l10n-check.mjs` see them. This module only decides *when* the
 * dialogue happens and what number it names.
 */
export function gcBudgetDialog(budgetGiB: number, confirmAboveGiB: number): GcBudgetDialog {
  // A budget of 0 means "no budget given": the threshold is the figure worth
  // naming in that case.
  const named = budgetGiB > 0 ? budgetGiB : confirmAboveGiB;
  return { args: named > 0 ? [named] : [] };
}

/** What the environment self-check puts under `Cache` (`cli/selfCheck.ts` §8 G9). */
export interface CacheSnapshot {
  totalBytes: number;
  entries: number;
  incomplete: number;
}

/**
 * The snapshot from an inventory the caller already read. No query is repeated
 * here; `readCacheSnapshot()` in `src/cache/cacheView.ts` is the one that runs
 * them, and it reuses the cache view's own read path.
 */
export function cacheSnapshotFrom(
  inventory: { totalBytes: number; totalEntries: number; incomplete: number } | undefined,
): CacheSnapshot | undefined {
  if (inventory === undefined) {
    return undefined;
  }
  return {
    totalBytes: Number.isFinite(inventory.totalBytes) ? inventory.totalBytes : 0,
    entries: Number.isFinite(inventory.totalEntries) ? inventory.totalEntries : 0,
    incomplete: Number.isFinite(inventory.incomplete) ? inventory.incomplete : 0,
  };
}

export interface TimerDecision {
  active: boolean;
  seconds: number;
}

/**
 * Whether one of the two view timers should be running.
 *
 * Every condition that turns a timer off is stated once, in one place:
 * `0` (or anything that is not a positive finite number) disables it, and so does
 * a view that is not visible. The two settings differ only in what feeds
 * `viewVisible`.
 */
export function refreshTimerDecision(seconds: number, viewVisible: boolean): TimerDecision {
  const usable = Number.isFinite(seconds) && seconds > 0;
  return { active: usable && viewVisible, seconds: usable ? seconds : 0 };
}
