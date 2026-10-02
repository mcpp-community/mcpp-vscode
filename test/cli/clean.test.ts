import assert from "node:assert/strict";
import test from "node:test";

import { planClean, planProblems, withSharedCache } from "../../src/cli/clean";

test("the cleanup policy has no holes", () => {
  assert.deepEqual(planProblems(), []);
});

test("the two project levels are exactly what the plan promised", () => {
  assert.deepEqual(planClean("project").argv, ["clean"]);
  assert.equal(planClean("project").level, 1);
  assert.deepEqual(planClean("stale", { staleDays: 7 }).argv, ["clean", "--stale", "--older-than", "7d"]);
  assert.equal(planClean("stale").level, 2);
  assert.equal(planClean("stale").preview, true);
});

test("the stale threshold defaults to three days and clamps nonsense", () => {
  assert.deepEqual(planClean("stale").argv, ["clean", "--stale", "--older-than", "3d"]);
  assert.deepEqual(planClean("stale", { staleDays: -4 }).argv, ["clean", "--stale", "--older-than", "0d"]);
  assert.deepEqual(planClean("stale", { staleDays: Number.NaN }).argv, ["clean", "--stale", "--older-than", "3d"]);
  // 0 is meaningful: keep none.
  assert.deepEqual(planClean("stale", { staleDays: 0 }).argv, ["clean", "--stale", "--older-than", "0d"]);
});

test("the shared cache is never touched by a project-level clean", () => {
  for (const action of ["project", "stale"] as const) {
    assert.ok(!planClean(action).argv.includes("--bmi-cache"), action);
  }
});

test("withSharedCache raises the danger and says so", () => {
  const escalated = withSharedCache(planClean("project"));
  assert.deepEqual(escalated.argv, ["clean", "--bmi-cache"]);
  assert.equal(escalated.level, 3);
  assert.equal(escalated.acknowledge, true);
  assert.match(escalated.detailKey, /every mcpp project on this machine/);
});

test("withSharedCache is a no-op for anything but the project body", () => {
  const stale = planClean("stale");
  assert.deepEqual(withSharedCache(stale), stale);
});

test("the gc budget is optional; without one mcpp is asked", () => {
  assert.deepEqual(planClean("cacheGc").argv, ["cache", "gc"]);
  assert.deepEqual(planClean("cacheGc", { budgetGiB: 5 }).argv, ["cache", "gc", "--max-size", "5GiB"]);
  assert.deepEqual(planClean("cacheGc", { budgetGiB: 0 }).argv, ["cache", "gc"]);
  assert.deepEqual(planClean("cacheGc", { budgetGiB: Number.NaN }).argv, ["cache", "gc"]);
});

test("prune's age defaults to thirty days and never drops below one", () => {
  assert.deepEqual(planClean("cachePrune").argv, ["cache", "prune", "--older-than", "30d"]);
  assert.deepEqual(planClean("cachePrune", { pruneAgeDays: 0 }).argv, ["cache", "prune", "--older-than", "1d"]);
});

test("cache clean --all is reachable but is the only level 3 action", () => {
  const all = planClean("cacheAll");
  assert.deepEqual(all.argv, ["cache", "clean", "--all"]);
  assert.equal(all.level, 3);
  assert.equal(all.acknowledge, true);
  assert.match(all.detailKey, /[Ee]very mcpp project on this machine/);
  for (const action of ["cacheDeps", "cacheStd", "cachePrune", "cacheGc"] as const) {
    assert.ok(planClean(action).level < 3, action);
  }
});

test("verifying and listing are read-only", () => {
  assert.equal(planClean("cacheVerify").level, 0);
  assert.deepEqual(planClean("cacheVerify").argv, ["cache", "verify"]);
  assert.equal(planClean("cacheList").level, 0);
  assert.deepEqual(planClean("cacheList").argv, ["cache", "list", "--format", "json"]);
});

test("the legacy cleanup needs no preview because nothing rebuilds", () => {
  const legacy = planClean("cacheLegacy");
  assert.deepEqual(legacy.argv, ["cache", "clean", "--legacy"]);
  assert.equal(legacy.preview, false);
  assert.equal(legacy.level, 2);
});

test("every plan runs through a trusted workspace", () => {
  for (const action of ["project", "stale", "cacheGc", "cachePrune", "cacheAll", "cacheVerify"] as const) {
    assert.equal(planClean(action).requiresTrust, true, action);
  }
});

test("no argument is a shell word", () => {
  for (const action of ["project", "stale", "cachePrune", "cacheGc"] as const) {
    for (const part of planClean(action, { budgetGiB: 5, staleDays: 7, pruneAgeDays: 30 }).argv) {
      assert.equal(part.trim(), part);
    }
  }
});
