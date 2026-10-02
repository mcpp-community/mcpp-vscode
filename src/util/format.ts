/**
 * Byte / count formatting for the cache views and the status bar.
 *
 * Pure: no `vscode`, no i18n. The unit suffixes (B/KiB/MiB/GiB/TiB) are the same
 * in every language this extension speaks, so they are not translated; the
 * surrounding sentence is (`src/i18n/t.ts`).
 */

export type NumberFormat = "binary" | "decimal";

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
const DECIMAL_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

function significant(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const abs = Math.abs(value);
  if (abs >= 100) {
    return value.toFixed(0);
  }
  if (abs >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

/**
 * `1500000` -> `"1.43 MiB"` (binary) / `"1.50 MB"` (decimal).
 *
 * Three significant digits, matching what the plan promises for the cache views:
 * big numbers stay readable and small ones keep two decimals.
 */
export function formatBytes(bytes: number, format: NumberFormat = "binary"): string {
  const units = format === "decimal" ? DECIMAL_UNITS : BINARY_UNITS;
  const step = format === "decimal" ? 1000 : 1024;
  let value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  let index = 0;
  while (value >= step && index < units.length - 1) {
    value /= step;
    index += 1;
  }
  return `${significant(value)} ${units[index]}`;
}

/** `12345` -> `"12,345"`. Grouping follows the host locale. */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "0";
}

/** Seconds since the Unix epoch -> `Date`, or `undefined` for a non-finite input. */
export function fromUnixSeconds(seconds: number | undefined): Date | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return new Date(seconds * 1000);
}

/**
 * Numbers of whole days between two instants, floored at 0.
 * Used by the cache age buckets: `<1d` / `1–7d` / `7–30d` / `>30d`.
 */
export function ageInDays(at: Date, now: Date): number {
  const delta = now.getTime() - at.getTime();
  return delta <= 0 ? 0 : Math.floor(delta / 86_400_000);
}

/**
 * Bucket boundaries in days, ascending, from settings such as
 * `["1d", "7d", "30d"]`. Unparsable entries are dropped; the result is sorted
 * and de-duplicated so a hand-edited setting cannot produce overlapping buckets.
 */
export function parseAgeBuckets(values: readonly string[] | undefined): number[] {
  const parsed = new Set<number>();
  for (const raw of values ?? []) {
    const match = /^\s*(\d+)\s*([dhwm]?)\s*$/.exec(raw);
    if (match === null) {
      continue;
    }
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2];
    const days = unit === "h" ? amount / 24 : unit === "w" ? amount * 7 : unit === "m" ? amount * 30 : amount;
    const rounded = Math.max(0, Math.round(days));
    parsed.add(rounded);
  }
  if (parsed.size === 0) {
    return [1, 7, 30];
  }
  return [...parsed].sort((a, b) => a - b);
}

/** Which bucket index `days` falls in; `boundaries.length` is the last (oldest) bucket. */
export function bucketIndex(days: number, boundaries: readonly number[]): number {
  for (let index = 0; index < boundaries.length; index += 1) {
    if (days < boundaries[index]) {
      return index;
    }
  }
  return boundaries.length;
}

export interface CacheEntrySize {
  bytes: number;
  accessed?: number;
  complete?: boolean;
}

export interface CacheProjection {
  /** Entries removed, in LRU order, to reach the budget. */
  removed: CacheEntrySize[];
  kept: CacheEntrySize[];
  freedBytes: number;
  remainingBytes: number;
}

/**
 * Simulate `mcpp cache gc --max-size <budget>`: drop least-recently-used entries
 * until the total fits the budget. Entries without a usable `accessed` timestamp
 * are treated as the most recent, so a projection never promises to free
 * something mcpp would keep.
 *
 * This is an **estimate** — mcpp's own LRU also weighs entry completeness and
 * its own bookkeeping, so the figure is offered as a preview only.
 */
export function projectGc(entries: readonly CacheEntrySize[], budgetBytes: number): CacheProjection {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.bytes), 0);
  if (budgetBytes >= total) {
    return { removed: [], kept: [...entries], freedBytes: 0, remainingBytes: total };
  }
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = a.entry.accessed ?? Number.MAX_SAFE_INTEGER;
      const right = b.entry.accessed ?? Number.MAX_SAFE_INTEGER;
      return left === right ? a.index - b.index : left - right;
    });
  const removed: CacheEntrySize[] = [];
  let remaining = total;
  for (const { entry } of ranked) {
    if (remaining <= budgetBytes) {
      break;
    }
    removed.push(entry);
    remaining -= Math.max(0, entry.bytes);
  }
  const removedSet = new Set(removed);
  return {
    removed,
    kept: entries.filter((entry) => !removedSet.has(entry)),
    freedBytes: total - remaining,
    remainingBytes: remaining,
  };
}
