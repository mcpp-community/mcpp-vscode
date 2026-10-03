import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { measureDirectory } from "../../src/cli/artifacts";

/**
 * The bounded walk behind `mcpp.cache.showLegacy`: the pre-v1 cache lives
 * outside the workspace, so it is measured by path rather than as `target/`.
 *
 * Each case creates one throwaway directory and removes it in the test's own
 * cleanup hook.
 */

function withScratch(t: { after(callback: () => void): void }, body: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  body(root);
}

test("a missing legacy directory measures as absent with zeros, without throwing", (t) => {
  withScratch(t, (root) => {
    const estimate = measureDirectory(path.join(root, "does-not-exist"));
    assert.equal(estimate.exists, false);
    assert.equal(estimate.totalBytes, 0);
    assert.equal(estimate.files, 0);
    assert.deepEqual(estimate.byTopLevel, []);
  });
});

test("a non-empty legacy directory gets a byte figure", (t) => {
  withScratch(t, (root) => {
    mkdirSync(path.join(root, "pkg", "deep"), { recursive: true });
    writeFileSync(path.join(root, "pkg", "a.bin"), Buffer.alloc(700));
    writeFileSync(path.join(root, "pkg", "deep", "b.bin"), Buffer.alloc(300));
    const estimate = measureDirectory(root);
    assert.equal(estimate.exists, true);
    assert.equal(estimate.totalBytes, 1000);
    assert.equal(estimate.files, 2);
  });
});

test("an empty legacy directory measures as zero bytes, not as absent", (t) => {
  withScratch(t, (root) => {
    const estimate = measureDirectory(root);
    assert.equal(estimate.exists, true);
    assert.equal(estimate.totalBytes, 0);
  });
});

test("the walk never follows a symlink back into its own ancestor", (t) => {
  withScratch(t, (root) => {
    mkdirSync(path.join(root, "pkg"), { recursive: true });
    writeFileSync(path.join(root, "pkg", "a.bin"), Buffer.alloc(64));
    symlinkSync(root, path.join(root, "pkg", "loop"), "dir");
    const estimate = measureDirectory(root, { maxEntries: 1000, maxDepth: 8 });
    // The link is counted at zero bytes, so the total stays the 64 it really holds.
    assert.equal(estimate.totalBytes, 64);
  });
});

test("a walk that runs out of budget reports a floor instead of hanging", (t) => {
  withScratch(t, (root) => {
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(path.join(root, `f${index}.bin`), Buffer.alloc(10));
    }
    const estimate = measureDirectory(root, { maxEntries: 5 });
    assert.equal(estimate.truncated, "entries");
    assert.ok(estimate.totalBytes <= 200);
  });
});
