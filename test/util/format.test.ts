import assert from "node:assert/strict";
import test from "node:test";

import {
  ageInDays,
  bucketIndex,
  formatBytes,
  formatCount,
  fromUnixSeconds,
  parseAgeBuckets,
  projectGc,
} from "../../src/util/format";

test("formatBytes uses binary units by default and three significant digits", () => {
  assert.equal(formatBytes(0), "0.00 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1024), "1.00 KiB");
  assert.equal(formatBytes(1024 * 1024 * 1.5), "1.50 MiB");
  assert.equal(formatBytes(1024 * 1024 * 12), "12.0 MiB");
  assert.equal(formatBytes(1024 * 1024 * 123), "123 MiB");
  // 7.22 GiB — the figure the plan quotes from a real cache.
  assert.equal(formatBytes(7_736_306_884), "7.20 GiB");
});

test("formatBytes can speak decimal units", () => {
  assert.equal(formatBytes(1_000_000, "decimal"), "1.00 MB");
  assert.equal(formatBytes(1_000_000, "binary"), "977 KiB");
});

test("formatBytes survives nonsense", () => {
  assert.equal(formatBytes(Number.NaN), "0.00 B");
  assert.equal(formatBytes(-5), "0.00 B");
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "0.00 B");
});

test("formatCount rounds and groups", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(657), "657");
  assert.equal(formatCount(1234.6), (1235).toLocaleString());
});

test("fromUnixSeconds rejects zero and non-finite values", () => {
  assert.equal(fromUnixSeconds(undefined), undefined);
  assert.equal(fromUnixSeconds(0), undefined);
  assert.equal(fromUnixSeconds(Number.NaN), undefined);
  assert.equal(fromUnixSeconds(1_790_804_836)?.getTime(), 1_790_804_836_000);
});

test("ageInDays floors at zero for a future timestamp", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  assert.equal(ageInDays(new Date("2026-10-02T12:00:00Z"), now), 0);
  assert.equal(ageInDays(new Date("2026-10-05T12:00:00Z"), now), 0);
  assert.equal(ageInDays(new Date("2026-09-29T12:00:00Z"), now), 3);
});

test("parseAgeBuckets accepts d/h/w/m and falls back to the documented default", () => {
  assert.deepEqual(parseAgeBuckets(["1d", "7d", "30d"]), [1, 7, 30]);
  assert.deepEqual(parseAgeBuckets(["48h", "1w", "2m"]), [2, 7, 60]);
  assert.deepEqual(parseAgeBuckets([]), [1, 7, 30]);
  assert.deepEqual(parseAgeBuckets(["nonsense"]), [1, 7, 30]);
  // Sorted and de-duplicated, so a hand-edited setting cannot overlap.
  assert.deepEqual(parseAgeBuckets(["30d", "7d", "7d", "1d"]), [1, 7, 30]);
});

test("bucketIndex puts the oldest entries in the overflow bucket", () => {
  const bounds = [1, 7, 30];
  assert.equal(bucketIndex(0, bounds), 0);
  assert.equal(bucketIndex(1, bounds), 1);
  assert.equal(bucketIndex(7, bounds), 2);
  assert.equal(bucketIndex(29, bounds), 2);
  assert.equal(bucketIndex(30, bounds), 3);
});

test("projectGc keeps everything when the budget already fits", () => {
  const entries = [{ bytes: 100, accessed: 1 }, { bytes: 200, accessed: 2 }];
  const projection = projectGc(entries, 1000);
  assert.deepEqual(projection.removed, []);
  assert.equal(projection.freedBytes, 0);
  assert.equal(projection.remainingBytes, 300);
});

test("projectGc drops least-recently-used entries first", () => {
  const entries = [
    { bytes: 400, accessed: 30 },
    { bytes: 300, accessed: 10 },
    { bytes: 300, accessed: 20 },
  ];
  // 1000 bytes total, budget 600: the two oldest (10, then 20) go.
  const projection = projectGc(entries, 600);
  assert.deepEqual(projection.removed.map((entry) => entry.accessed), [10, 20]);
  assert.equal(projection.freedBytes, 600);
  assert.equal(projection.remainingBytes, 400);
  assert.equal(projection.kept.length, 1);
});

test("projectGc treats entries without a timestamp as newest", () => {
  const entries = [
    { bytes: 500, accessed: undefined },
    { bytes: 500, accessed: 1 },
  ];
  const projection = projectGc(entries, 500);
  assert.deepEqual(projection.removed.map((entry) => entry.accessed), [1]);
});

test("projectGc never reports a negative remaining size", () => {
  const projection = projectGc([{ bytes: 0, accessed: 1 }, { bytes: 0, accessed: 2 }], 0);
  assert.equal(projection.remainingBytes, 0);
  assert.equal(projection.freedBytes, 0);
});
