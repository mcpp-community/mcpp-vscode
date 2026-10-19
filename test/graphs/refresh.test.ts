import assert from "node:assert/strict";
import test from "node:test";
import { RefreshCoordinator } from "../../src/graphs/refresh";
const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
test("100 event bursts coalesce, in-flight events produce one followup, hidden events wait", async () => {
  let calls = 0, finish: (() => void) | undefined, active = 0, maxActive = 0;
  const coordinator = new RefreshCoordinator(async () => { calls++; active++; maxActive = Math.max(maxActive, active); await new Promise<void>(resolve => { finish = resolve; }); active--; }, 5, 20);
  try {
    for (let i = 0; i < 100; i++) void coordinator.request();
    await tick(); assert.equal(calls, 1);
    for (let i = 0; i < 100; i++) void coordinator.request();
    finish!(); await tick(); assert.equal(calls, 2); assert.equal(maxActive, 1);
    finish!(); await tick(); assert.equal(calls, 2);
    coordinator.setVisible(false); void coordinator.request(); await tick(); assert.equal(calls, 2);
    coordinator.setVisible(true); await tick(); assert.equal(calls, 3); finish!(); await tick();
  } finally { coordinator.dispose(); }
});
test("cancellation aborts the active query and disposal cancels deferred refresh", async () => {
  let aborted = false, calls = 0;
  const coordinator = new RefreshCoordinator(signal => new Promise<void>(resolve => {
    calls++; signal.addEventListener("abort", () => { aborted = true; resolve(); });
  }), 5);
  const flight = coordinator.request(true); await tick(); coordinator.cancel(); await flight; assert.equal(aborted, true);
  void coordinator.request(); coordinator.dispose(); await tick(); assert.equal(calls, 1);
});
