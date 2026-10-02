import assert from "node:assert/strict";
import test from "node:test";

import { PollTimer } from "../../src/mcppls/timers";
import { degradedNoticeEnabled, resetCacheConfirmation } from "../../src/views/viewPolicy";

/**
 * A fake clock. `setInterval` registers a handle, `clearInterval` retires it,
 * and `tick()` fires only the handles that are still armed — which is what makes
 * "dispose and stop() actually stop the refreshing" observable.
 */
function fakeClock() {
  const handlers = new Map<number, () => void>();
  const cleared: unknown[] = [];
  let next = 0;
  return {
    cleared,
    get armed(): number {
      return handlers.size;
    },
    setIntervalFn: (handler: () => void) => {
      next += 1;
      handlers.set(next, handler);
      return next;
    },
    clearIntervalFn: (handle: unknown) => {
      cleared.push(handle);
      handlers.delete(handle as number);
    },
    tick(): void {
      for (const handler of [...handlers.values()]) {
        handler();
      }
    },
  };
}

// ── mcpp.languageService.confirmResetCache ───────────────────────────────────

test("the reset-cache modal is demanded by default, for a destructive capability", () => {
  assert.equal(
    resetCacheConfirmation({ danger: "destructive", confirmResetCache: true }),
    "extra-modal",
  );
});

test("turning the setting off falls back to the capability's own level, never below it", () => {
  assert.equal(
    resetCacheConfirmation({ danger: "destructive", confirmResetCache: false }),
    "capability",
  );
  assert.equal(resetCacheConfirmation({ danger: "confirm", confirmResetCache: false }), "capability");
});

test("a capability that needs no confirmation never gets one added", () => {
  assert.equal(resetCacheConfirmation({ danger: "none", confirmResetCache: true }), "none");
  assert.equal(resetCacheConfirmation({ danger: "none", confirmResetCache: false }), "none");
});

test("only an action that already needs confirmation can be asked one more time", () => {
  // The extra modal is never the *only* confirmation, and never attaches to an
  // action the capability table calls safe.
  const decisions = [
    resetCacheConfirmation({ danger: "destructive", confirmResetCache: true }),
    resetCacheConfirmation({ danger: "destructive", confirmResetCache: false }),
    resetCacheConfirmation({ danger: "confirm", confirmResetCache: true }),
    resetCacheConfirmation({ danger: "none", confirmResetCache: true }),
  ];
  assert.deepEqual(decisions, ["extra-modal", "capability", "extra-modal", "none"]);
});

// ── mcpp.languageService.notifyOnDegraded ────────────────────────────────────

test("the degraded notice is emitted unless the setting turns it off", () => {
  assert.equal(degradedNoticeEnabled(undefined), true, "the registry default is true");
  assert.equal(degradedNoticeEnabled(true), true);
  assert.equal(degradedNoticeEnabled(false), false);
});

// ── the shared interval timer ────────────────────────────────────────────────

test("a non-positive period arms nothing", () => {
  const clock = fakeClock();
  const timer = new PollTimer({
    periodMs: 0,
    tick: () => undefined,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  timer.start(0);
  assert.equal(timer.active, false);
  timer.start(-3);
  assert.equal(timer.active, false);
  timer.start(Number.NaN);
  assert.equal(timer.active, false);
  assert.equal(clock.armed, 0);
  timer.dispose();
});

test("a positive period ticks until it is stopped, and dispose is idempotent", () => {
  const clock = fakeClock();
  let ticks = 0;
  const timer = new PollTimer({
    periodMs: 0,
    tick: () => {
      ticks += 1;
    },
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  timer.start(100);
  assert.equal(timer.active, true);
  assert.equal(timer.period, 100);
  clock.tick();
  clock.tick();
  assert.equal(ticks, 2);

  timer.stop();
  assert.equal(timer.active, false);
  timer.stop();
  timer.dispose();
  timer.dispose();
  clock.tick();
  assert.equal(ticks, 2, "a disposed timer must not tick");
  assert.ok(clock.cleared.length >= 1);
});

test("re-arming replaces the previous interval instead of adding one", () => {
  const clock = fakeClock();
  const timer = new PollTimer({
    periodMs: 0,
    tick: () => undefined,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  timer.start(10);
  assert.deepEqual(clock.cleared, [], "the first arm has nothing to clear");
  timer.start(20);
  assert.equal(timer.period, 20);
  assert.equal(clock.cleared.length, 1, "the first interval must be cleared before the second is armed");
  assert.equal(timer.active, true);
  timer.dispose();
});

test("a throwing tick does not kill the timer", () => {
  const clock = fakeClock();
  let attempts = 0;
  const timer = new PollTimer({
    periodMs: 0,
    tick: () => {
      attempts += 1;
      throw new Error("the refresh failed");
    },
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  timer.start(100);
  clock.tick();
  clock.tick();
  assert.equal(attempts, 2);
  assert.equal(timer.active, true);
  timer.dispose();
});
