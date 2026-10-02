import assert from "node:assert/strict";
import test from "node:test";

import {
  BYTES_PER_GIB,
  buildCacheWarningNode,
  cacheSnapshotFrom,
  gcBudgetDialog,
  gcBudgetNeedsExtraConfirm,
  legacyBytesForTree,
  legacyDisplay,
  legacyForPanel,
  refreshTimerDecision,
} from "../../src/views/cacheState";

// ── mcpp.cache.showLegacy ────────────────────────────────────────────────────

test("the pre-v1 node is offered only when the setting is on and the directory is non-empty", () => {
  assert.equal(legacyBytesForTree({ enabled: true, bytes: 175_000_000 }), 175_000_000);
  assert.equal(legacyBytesForTree({ enabled: true, bytes: 0 }), undefined);
  assert.equal(legacyBytesForTree({ enabled: false, bytes: 175_000_000 }), undefined);
  assert.equal(legacyBytesForTree({ enabled: false, bytes: 0 }), undefined);
});

test("a legacy directory that was never measured is not claimed to be empty", () => {
  assert.equal(legacyDisplay({ enabled: true, bytes: undefined }), "unknown");
  assert.equal(legacyBytesForTree({ enabled: true, bytes: undefined }), undefined);
  assert.equal(legacyForPanel({ enabled: true, bytes: undefined }, "/home/u/.mcpp/bmi"), undefined);
});

test("the panel applies the same rule, and never invents a path", () => {
  assert.deepEqual(legacyForPanel({ enabled: true, bytes: 12 }, "/home/u/.mcpp/bmi"), {
    bytes: 12,
    path: "/home/u/.mcpp/bmi",
  });
  assert.equal(legacyForPanel({ enabled: false, bytes: 12 }, "/home/u/.mcpp/bmi"), undefined);
  assert.equal(legacyForPanel({ enabled: true, bytes: 0 }, "/home/u/.mcpp/bmi"), undefined);
  assert.equal(legacyForPanel({ enabled: true, bytes: 12 }, undefined), undefined);
});

// ── mcpp.cache.warnAboveGiB ──────────────────────────────────────────────────

test("no warning below the threshold, and none when the setting disables it", () => {
  assert.equal(buildCacheWarningNode(0, 0), undefined);
  assert.equal(buildCacheWarningNode(8 * BYTES_PER_GIB, 0), undefined);
  assert.equal(buildCacheWarningNode(8 * BYTES_PER_GIB, -1), undefined);
  assert.equal(buildCacheWarningNode(8 * BYTES_PER_GIB, Number.NaN), undefined);
  assert.equal(buildCacheWarningNode(8 * BYTES_PER_GIB - 1, 8), undefined);
  assert.equal(buildCacheWarningNode(Number.NaN, 8), undefined);
});

test("a warning node appears at and above the threshold", () => {
  const at = buildCacheWarningNode(8 * BYTES_PER_GIB, 8);
  assert.equal(at?.id, "cache.warning");
  assert.equal(at?.icon, "warning");
  assert.equal(at?.command?.command, "mcpp.showCachePanel");
  const above = buildCacheWarningNode(9.5 * BYTES_PER_GIB, 8);
  assert.equal(above?.id, "cache.warning");
  assert.match(String(above?.description?.args?.[1]), /8/);
});

// ── mcpp.cache.gc.confirmAboveGiB ────────────────────────────────────────────

test("0 confirms every gc budget, and any other value confirms at or above it", () => {
  assert.equal(gcBudgetNeedsExtraConfirm(0, 0), true);
  assert.equal(gcBudgetNeedsExtraConfirm(4, 0), true);
  assert.equal(gcBudgetNeedsExtraConfirm(1, 1), true);
  assert.equal(gcBudgetNeedsExtraConfirm(0.5, 1), false);
  assert.equal(gcBudgetNeedsExtraConfirm(4, 1), true);
});

test("a nonsensical value never adds a confirmation", () => {
  assert.equal(gcBudgetNeedsExtraConfirm(Number.NaN, 1), false);
  assert.equal(gcBudgetNeedsExtraConfirm(-1, 1), false);
  assert.equal(gcBudgetNeedsExtraConfirm(4, Number.NaN), false);
});

test("the added dialogue names the budget, or the threshold when no budget was given", () => {
  assert.deepEqual(gcBudgetDialog(12, 1).args, [12]);
  // A budget of 0 means "no budget": the threshold is the figure worth naming.
  assert.deepEqual(gcBudgetDialog(0, 1).args, [1]);
  // A budget of 0 with a threshold of 0 ("confirm every cleanup") has no figure.
  assert.deepEqual(gcBudgetDialog(0, 0).args, []);
});

// ── the self-check snapshot (§8 G9) ──────────────────────────────────────────

test("the snapshot carries the three fields buildSelfCheckText reads", () => {
  assert.deepEqual(cacheSnapshotFrom({ totalBytes: 7_736_306_884, totalEntries: 657, incomplete: 2 }), {
    totalBytes: 7_736_306_884,
    entries: 657,
    incomplete: 2,
  });
});

test("nothing read means no snapshot, not a zero", () => {
  assert.equal(cacheSnapshotFrom(undefined), undefined);
});

// ── the two view timers ──────────────────────────────────────────────────────

test("0 disables a refresh timer, a hidden view does too", () => {
  assert.deepEqual(refreshTimerDecision(0, true), { active: false, seconds: 0 });
  assert.deepEqual(refreshTimerDecision(30, false), { active: false, seconds: 30 });
  assert.deepEqual(refreshTimerDecision(30, true), { active: true, seconds: 30 });
  assert.deepEqual(refreshTimerDecision(Number.NaN, true), { active: false, seconds: 0 });
  assert.deepEqual(refreshTimerDecision(-5, true), { active: false, seconds: 0 });
});
