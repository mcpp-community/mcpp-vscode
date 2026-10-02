/**
 * `mcpp cache …` reading and aggregation (plan §3.4).
 *
 * Pure functions over captured stdout plus the view model the cache TreeView and
 * the statistics webview render. No `vscode` and no process spawning: the caller
 * runs `mcpp` (`src/cli/process.ts`) and hands the text in.
 *
 * Two documents are involved:
 *  - `mcpp cache list --format json` — a real envelope (`kind: "mcpp.cache"`),
 *    parsed strictly; a foreign or unknown document is rejected outright;
 *  - `mcpp cache dir` — human text, so it is parsed leniently and partially.
 *
 * Everything is defensive: a broken entry is dropped, never thrown. A cache view
 * that fails to render is worse than one that renders fewer rows.
 */

import { ageInDays, bucketIndex, fromUnixSeconds, parseAgeBuckets } from "../util/format";

/** Envelope `kind` of `mcpp cache list --format json`. */
const CACHE_LIST_KIND = "mcpp.cache";

/** Fallback `kind` for an entry whose own `kind` is missing or not a string. */
const UNKNOWN_KIND = "unknown";

/** Default number of labels reported by {@link summarizeCache}. */
const DEFAULT_TOP_N = 5;

export interface CacheEntry {
  accessed?: number;
  bytes: number;
  complete: boolean;
  dir: string;
  files?: number;
  key: string;
  kind: string;
  label: string;
}

export interface CacheInventory {
  root: string;
  entries: CacheEntry[];
  totalBytes: number;
  totalEntries: number;
  /** Per-kind totals, largest first. */
  byKind: Array<{ kind: string; entries: number; bytes: number }>;
  /** Per-label totals, largest first, capped by `topN`. */
  topLabels: Array<{ label: string; entries: number; bytes: number; oldestAccessed?: number }>;
  /** Entries whose `complete` is false. */
  incomplete: CacheEntry[];
  oldestAccessed?: number;
  newestAccessed?: number;
  /** Age histogram: index i is `[boundaries[i-1], boundaries[i])` days, last bucket is the overflow. */
  ageBuckets: Array<{ fromDays: number; toDays?: number; entries: number; bytes: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Deterministic, locale-independent string ordering. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCacheEntry(raw: unknown): CacheEntry | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const dir = nonEmptyString(raw.dir);
  const key = nonEmptyString(raw.key);
  const label = nonEmptyString(raw.label);
  const bytes = finiteNumber(raw.bytes);
  if (dir === undefined || key === undefined || label === undefined || bytes === undefined) {
    return undefined;
  }
  const entry: CacheEntry = {
    bytes: Math.max(0, bytes),
    // A missing `complete` counts as incomplete: mcpp always emits it, so an
    // absent field means a truncated record, which is exactly what
    // "incomplete" should surface to the user (`mcpp cache verify`).
    complete: raw.complete === true,
    dir,
    key,
    kind: typeof raw.kind === "string" ? raw.kind : UNKNOWN_KIND,
    label,
  };
  const accessed = finiteNumber(raw.accessed);
  if (accessed !== undefined) {
    entry.accessed = accessed;
  }
  const files = finiteNumber(raw.files);
  if (files !== undefined) {
    entry.files = files;
  }
  return entry;
}

/**
 * Parse `mcpp cache list --format json` stdout.
 * `undefined` when it is not that document (non-JSON, foreign `kind`, bad shape).
 */
export function parseCacheList(stdout: string): { root: string; entries: CacheEntry[] } | undefined {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(document) || document.kind !== CACHE_LIST_KIND) {
    return undefined;
  }
  const data = document.data;
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    return undefined;
  }
  const entries: CacheEntry[] = [];
  for (const raw of data.entries) {
    const entry = parseCacheEntry(raw);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return { root: typeof data.root === "string" ? data.root : "", entries };
}

/**
 * Parse `mcpp cache dir` stdout:
 *
 * ```
 * /home/u/.mcpp/build-cache/v1
 * legacy (unused, removable with `mcpp cache clean --legacy`): /home/u/.mcpp/bmi
 * ```
 *
 * The legacy line is absent when there is no pre-v1 cache. The legacy path is
 * whatever follows the **last** `": "` on that line — the backticked command name
 * in the parenthetical must never be mistaken for a path.
 */
export function parseCacheDir(stdout: string): { root?: string; legacyPath?: string } {
  let root: string | undefined;
  let legacyPath: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (/^legacy\b/i.test(trimmed)) {
      const separator = trimmed.lastIndexOf(": ");
      const candidate = separator >= 0 ? trimmed.slice(separator + 2).trim() : "";
      if (candidate.length > 0) {
        legacyPath = candidate;
      }
      continue;
    }
    if (root === undefined) {
      root = trimmed;
    }
  }
  const result: { root?: string; legacyPath?: string } = {};
  if (root !== undefined) {
    result.root = root;
  }
  if (legacyPath !== undefined) {
    result.legacyPath = legacyPath;
  }
  return result;
}

/**
 * Aggregate a cache listing into what the views need.
 *
 * `ageBoundaries` come from `mcpp.views.cache.ageBuckets` as strings (`"1d"`,
 * `"7d"`, `"30d"`); see `parseAgeBuckets`. Entries without a usable `accessed`
 * timestamp are excluded from the histogram and from oldest/newest, because
 * their age is unknown — guessing would promise reclaimable space mcpp may keep.
 */
export function summarizeCache(
  root: string,
  entries: readonly CacheEntry[],
  options: { topN?: number; ageBoundaries?: readonly string[] } = {},
): CacheInventory {
  const topN = options.topN === undefined ? DEFAULT_TOP_N : Math.max(0, Math.floor(options.topN));
  const boundaries = parseAgeBuckets(options.ageBoundaries);
  const now = new Date();

  const byKindTotals = new Map<string, { entries: number; bytes: number }>();
  const labelTotals = new Map<
    string,
    { entries: number; bytes: number; oldestAccessed?: number }
  >();
  const incomplete: CacheEntry[] = [];

  const ageBuckets: CacheInventory["ageBuckets"] = [];
  for (let index = 0; index <= boundaries.length; index += 1) {
    const bucket: CacheInventory["ageBuckets"][number] = {
      fromDays: index === 0 ? 0 : boundaries[index - 1],
      entries: 0,
      bytes: 0,
    };
    if (index < boundaries.length) {
      bucket.toDays = boundaries[index];
    }
    ageBuckets.push(bucket);
  }

  let totalBytes = 0;
  let oldestAccessed: number | undefined;
  let newestAccessed: number | undefined;

  for (const entry of entries) {
    const bytes = Number.isFinite(entry.bytes) ? Math.max(0, entry.bytes) : 0;
    totalBytes += bytes;

    const kindTotals = byKindTotals.get(entry.kind) ?? { entries: 0, bytes: 0 };
    kindTotals.entries += 1;
    kindTotals.bytes += bytes;
    byKindTotals.set(entry.kind, kindTotals);

    const labelEntry = labelTotals.get(entry.label) ?? { entries: 0, bytes: 0 };
    labelEntry.entries += 1;
    labelEntry.bytes += bytes;
    if (entry.accessed !== undefined && Number.isFinite(entry.accessed)) {
      if (labelEntry.oldestAccessed === undefined || entry.accessed < labelEntry.oldestAccessed) {
        labelEntry.oldestAccessed = entry.accessed;
      }
      if (oldestAccessed === undefined || entry.accessed < oldestAccessed) {
        oldestAccessed = entry.accessed;
      }
      if (newestAccessed === undefined || entry.accessed > newestAccessed) {
        newestAccessed = entry.accessed;
      }
      const at = fromUnixSeconds(entry.accessed);
      if (at !== undefined) {
        const bucket = ageBuckets[bucketIndex(ageInDays(at, now), boundaries)];
        bucket.entries += 1;
        bucket.bytes += bytes;
      }
    }
    labelTotals.set(entry.label, labelEntry);

    if (!entry.complete) {
      incomplete.push(entry);
    }
  }

  const byKind = [...byKindTotals.entries()]
    .map(([kind, totals]) => ({ kind, entries: totals.entries, bytes: totals.bytes }))
    .sort(
      (left, right) =>
        right.bytes - left.bytes ||
        right.entries - left.entries ||
        compareStrings(left.kind, right.kind),
    );

  const rankedLabels = [...labelTotals.entries()]
    .map(([label, totals]) => ({
      label,
      entries: totals.entries,
      bytes: totals.bytes,
      ...(totals.oldestAccessed === undefined ? {} : { oldestAccessed: totals.oldestAccessed }),
    }))
    .sort(
      (left, right) =>
        right.bytes - left.bytes ||
        right.entries - left.entries ||
        compareStrings(left.label, right.label),
    );

  const inventory: CacheInventory = {
    root,
    entries: [...entries],
    totalBytes,
    totalEntries: entries.length,
    byKind,
    topLabels: rankedLabels.slice(0, topN),
    incomplete,
    ageBuckets,
  };
  if (oldestAccessed !== undefined) {
    inventory.oldestAccessed = oldestAccessed;
  }
  if (newestAccessed !== undefined) {
    inventory.newestAccessed = newestAccessed;
  }
  return inventory;
}
