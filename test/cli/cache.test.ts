import assert from "node:assert/strict";
import test from "node:test";

import { parseCacheDir, parseCacheList, summarizeCache, type CacheEntry } from "../../src/cli/cache";

const CACHE_ROOT = "/home/u/.mcpp/build-cache/v1";
const DAY = 86_400;

/** Truncated "now", like the capture: `accessed` is Unix seconds. */
const nowSeconds = Math.floor(Date.now() / 1000);

interface RawEntry {
  accessed?: number;
  bytes: unknown;
  complete?: unknown;
  dir?: unknown;
  files?: unknown;
  key?: unknown;
  kind?: unknown;
  label?: unknown;
}

/** A real `mcpp cache list --format json` envelope around the given entries. */
function envelope(entries: unknown[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "mcpp.cache",
    kindVersion: 1,
    mcpp: { version: "2026.9.30.2", protocol: { min: 1, max: 1 } },
    data: { root: CACHE_ROOT, entries },
    diagnostics: [],
    effects: [],
  });
}

const realistic: RawEntry[] = [
  {
    accessed: nowSeconds - 2 * 3600,
    bytes: 24257,
    complete: true,
    dir: `${CACHE_ROOT}/pkg/ns/name@1.0.0/c0d9ff40c3354f15`,
    files: 7,
    key: "c0d9ff40c3354f15",
    kind: "pkg",
    label: "ns/name@1.0.0",
  },
  {
    accessed: nowSeconds - 3 * DAY,
    bytes: 1000,
    complete: false,
    dir: `${CACHE_ROOT}/pkg/ns/name@1.0.0/1f7ab3c2d4e5f607`,
    files: 4,
    key: "1f7ab3c2d4e5f607",
    kind: "pkg",
    label: "ns/name@1.0.0",
  },
  {
    accessed: nowSeconds - 10 * DAY,
    bytes: 5000,
    complete: true,
    dir: `${CACHE_ROOT}/pkg/ns/other@2.0.0/aa11bb22cc33dd44`,
    files: 3,
    key: "aa11bb22cc33dd44",
    kind: "pkg",
    label: "ns/other@2.0.0",
  },
  {
    accessed: nowSeconds - 40 * DAY,
    bytes: 8000,
    complete: true,
    dir: `${CACHE_ROOT}/std/std.pcm/9988776655443322`,
    files: 2,
    key: "9988776655443322",
    kind: "std",
    label: "std",
  },
];

test("解析并聚合两类缓存的真实清单", () => {
  const parsed = parseCacheList(envelope(realistic));
  assert.ok(parsed);
  assert.equal(parsed.root, CACHE_ROOT);
  assert.equal(parsed.entries.length, 4);
  assert.deepEqual(parsed.entries[0], {
    accessed: nowSeconds - 2 * 3600,
    bytes: 24257,
    complete: true,
    dir: `${CACHE_ROOT}/pkg/ns/name@1.0.0/c0d9ff40c3354f15`,
    files: 7,
    key: "c0d9ff40c3354f15",
    kind: "pkg",
    label: "ns/name@1.0.0",
  });

  const inventory = summarizeCache(parsed.root, parsed.entries, {
    topN: 2,
    ageBoundaries: ["1d", "7d", "30d"],
  });

  assert.equal(inventory.root, CACHE_ROOT);
  assert.equal(inventory.totalEntries, 4);
  assert.equal(inventory.totalBytes, 38_257);

  // pkg is larger than std, so it must come first.
  assert.deepEqual(inventory.byKind, [
    { kind: "pkg", entries: 3, bytes: 30_257 },
    { kind: "std", entries: 1, bytes: 8_000 },
  ]);

  assert.deepEqual(inventory.topLabels, [
    { label: "ns/name@1.0.0", entries: 2, bytes: 25_257, oldestAccessed: nowSeconds - 3 * DAY },
    { label: "std", entries: 1, bytes: 8_000, oldestAccessed: nowSeconds - 40 * DAY },
  ]);

  assert.equal(inventory.incomplete.length, 1);
  assert.equal(inventory.incomplete[0]?.key, "1f7ab3c2d4e5f607");
  assert.equal(inventory.oldestAccessed, nowSeconds - 40 * DAY);
  assert.equal(inventory.newestAccessed, nowSeconds - 2 * 3600);

  // Exactly one entry per bucket against the fixed 1/7/30 day boundaries.
  assert.deepEqual(inventory.ageBuckets, [
    { fromDays: 0, toDays: 1, entries: 1, bytes: 24_257 },
    { fromDays: 1, toDays: 7, entries: 1, bytes: 1_000 },
    { fromDays: 7, toDays: 30, entries: 1, bytes: 5_000 },
    { fromDays: 30, entries: 1, bytes: 8_000 },
  ]);
});

test("topLabels 默认取前 5 且按体积降序", () => {
  const many: CacheEntry[] = Array.from({ length: 7 }, (_unused, index) => ({
    bytes: (index + 1) * 100,
    complete: true,
    dir: `${CACHE_ROOT}/pkg/pkg${index}`,
    key: `key${index}`,
    kind: "pkg",
    label: `pkg${index}`,
  }));

  const inventory = summarizeCache(CACHE_ROOT, many);
  assert.equal(inventory.topLabels.length, 5);
  assert.deepEqual(
    inventory.topLabels.map((entry) => entry.label),
    ["pkg6", "pkg5", "pkg4", "pkg3", "pkg2"],
  );
  assert.equal(inventory.topLabels[0]?.bytes, 700);
  assert.equal(inventory.topLabels[0]?.oldestAccessed, undefined);
  assert.equal(inventory.oldestAccessed, undefined);
  assert.equal(inventory.newestAccessed, undefined);
});

test("空清单返回全零统计", () => {
  const inventory = summarizeCache("/nowhere", []);
  assert.equal(inventory.totalEntries, 0);
  assert.equal(inventory.totalBytes, 0);
  assert.deepEqual(inventory.byKind, []);
  assert.deepEqual(inventory.topLabels, []);
  assert.deepEqual(inventory.incomplete, []);
  assert.equal(inventory.oldestAccessed, undefined);
  assert.equal(inventory.newestAccessed, undefined);
  assert.deepEqual(
    inventory.ageBuckets.map((bucket) => [bucket.fromDays, bucket.toDays, bucket.entries, bucket.bytes]),
    [
      [0, 1, 0, 0],
      [1, 7, 0, 0],
      [7, 30, 0, 0],
      [30, undefined, 0, 0],
    ],
  );
});

test("拒绝非 mcpp.cache 信封，坏条目不抛错", () => {
  // Not that document at all.
  assert.equal(parseCacheList(""), undefined);
  assert.equal(parseCacheList("not json at all"), undefined);
  assert.equal(parseCacheList("null"), undefined);
  assert.equal(parseCacheList("[]"), undefined);
  assert.equal(parseCacheList(JSON.stringify({ kind: "mcpp.toolchain", data: { entries: [] } })), undefined);
  assert.equal(parseCacheList(JSON.stringify({ kind: "mcpp.cache" })), undefined);
  assert.equal(parseCacheList(JSON.stringify({ kind: "mcpp.cache", data: {} })), undefined);
  assert.equal(parseCacheList(JSON.stringify({ kind: "mcpp.cache", data: { entries: "nope" } })), undefined);

  // The right document with an empty list is valid, not an error.
  const empty = parseCacheList(envelope([]));
  assert.ok(empty);
  assert.equal(empty.root, CACHE_ROOT);
  assert.deepEqual(empty.entries, []);

  // Malformed entries are dropped, negative bytes are clamped to 0.
  const mixed = parseCacheList(
    envelope([
      { accessed: nowSeconds, bytes: -5, complete: true, dir: `${CACHE_ROOT}/neg`, key: "neg", kind: "pkg", label: "neg" },
      { bytes: 10, complete: true, dir: `${CACHE_ROOT}/no-label`, key: "no-label", kind: "pkg" },
      { bytes: "12", complete: true, dir: `${CACHE_ROOT}/string`, key: "string", kind: "pkg", label: "string" },
      { bytes: 10, complete: true, key: "no-dir", kind: "pkg", label: "no-dir" },
      { bytes: 10, complete: true, dir: `${CACHE_ROOT}/no-key`, kind: "pkg", label: "no-key" },
      { bytes: 10, complete: true, dir: `${CACHE_ROOT}/blank-label`, key: "blank", kind: "pkg", label: "" },
      "garbage",
      null,
    ]),
  );
  assert.ok(mixed);
  assert.equal(mixed.entries.length, 1);
  assert.deepEqual(mixed.entries[0], {
    accessed: nowSeconds,
    bytes: 0,
    complete: true,
    dir: `${CACHE_ROOT}/neg`,
    key: "neg",
    kind: "pkg",
    label: "neg",
  });

  const summary = summarizeCache(mixed.root, mixed.entries);
  assert.equal(summary.totalEntries, 1);
  assert.equal(summary.totalBytes, 0);
  assert.deepEqual(summary.incomplete, []);
  assert.deepEqual(summary.ageBuckets.map((bucket) => bucket.entries), [1, 0, 0, 0]);
});

test("条目缺少 kind 时归入 unknown 而不是丢弃", () => {
  const parsed = parseCacheList(envelope([{ bytes: 7, dir: `${CACHE_ROOT}/x`, key: "x", label: "x" }]));
  assert.ok(parsed);
  assert.equal(parsed.entries[0]?.kind, "unknown");
  // `complete` is absent, which is treated as incomplete on purpose.
  assert.equal(parsed.entries[0]?.complete, false);
  const summary = summarizeCache(parsed.root, parsed.entries);
  assert.deepEqual(summary.byKind, [{ kind: "unknown", entries: 1, bytes: 7 }]);
  assert.equal(summary.incomplete.length, 1);
});

test("解析 cache dir 的两行输出", () => {
  const output = [
    "/home/u/.mcpp/build-cache/v1",
    "legacy (unused, removable with `mcpp cache clean --legacy`): /home/u/.mcpp/bmi",
    "",
  ].join("\n");
  assert.deepEqual(parseCacheDir(output), {
    root: "/home/u/.mcpp/build-cache/v1",
    legacyPath: "/home/u/.mcpp/bmi",
  });
});

test("cache dir 没有 legacy 行时只给根目录", () => {
  assert.deepEqual(parseCacheDir("/home/u/.mcpp/build-cache/v1\n"), {
    root: "/home/u/.mcpp/build-cache/v1",
  });
  assert.deepEqual(parseCacheDir("\n  /srv/mcpp cache/v1  \n"), { root: "/srv/mcpp cache/v1" });
  assert.deepEqual(parseCacheDir(""), {});
  assert.deepEqual(parseCacheDir("\n\n"), {});
});

test("legacy 行中的反引号路径不会被当作 legacy 路径", () => {
  const parsed = parseCacheDir([
    "/home/u/.mcpp/build-cache/v1",
    "legacy (unused, removable with `mcpp cache clean --legacy`): /home/u/.mcpp/bmi",
  ].join("\n"));
  assert.equal(parsed.legacyPath, "/home/u/.mcpp/bmi");
  assert.notEqual(parsed.legacyPath, "mcpp cache clean --legacy");

  // A legacy line without a path contributes nothing.
  assert.deepEqual(parseCacheDir("/root/cache\nlegacy (unused, removable)\n"), {
    root: "/root/cache",
  });
});
