import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { estimateArtifacts, formatArtifactEstimate } from "../../src/cli/artifacts";

/** Creates a throwaway workspace; `onTest` cleans it up. */
function workspace(onTest: { after(callback: () => void): void }): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-artifacts-"));
  onTest.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("估算 target/ 的体积并按顶层目录分组", (t) => {
  const root = workspace(t);
  const target = path.join(root, "target");
  mkdirSync(path.join(target, "a", "nested"), { recursive: true });
  mkdirSync(path.join(target, "b"), { recursive: true });
  writeFileSync(path.join(target, "a", "fileA.bin"), Buffer.alloc(100));
  writeFileSync(path.join(target, "a", "nested", "deep.bin"), Buffer.alloc(50));
  writeFileSync(path.join(target, "b", "fileB.bin"), Buffer.alloc(200));
  writeFileSync(path.join(target, "loose.bin"), Buffer.alloc(10));
  // A symlink back to its own ancestor: followed, this would never terminate.
  symlinkSync(path.join(target, "a"), path.join(target, "a", "loop"), "dir");

  const estimate = estimateArtifacts(root);

  assert.equal(estimate.path, target);
  assert.equal(estimate.exists, true);
  // 100 + 50 + 200 + 10 bytes; the symlink contributes 0.
  assert.equal(estimate.totalBytes, 360);
  // fileA, deep.bin, fileB, loose.bin, plus the symlink counted as an entry.
  assert.equal(estimate.files, 5);
  assert.deepEqual(estimate.byTopLevel, [
    { name: "b", bytes: 200, files: 1 },
    { name: "a", bytes: 150, files: 3 },
  ]);
  assert.equal(estimate.truncated, undefined);
  assert.equal(formatArtifactEstimate(estimate), "360 B in 2 groups");
});

test("空的 target/ 是 0 字节和 0 组", (t) => {
  const root = workspace(t);
  mkdirSync(path.join(root, "target"), { recursive: true });

  const estimate = estimateArtifacts(root);
  assert.equal(estimate.exists, true);
  assert.equal(estimate.totalBytes, 0);
  assert.equal(estimate.files, 0);
  assert.deepEqual(estimate.byTopLevel, []);
  // `formatBytes` keeps three significant digits, so an exact zero renders as "0.00 B".
  assert.equal(formatArtifactEstimate(estimate), "0.00 B in 0 groups");
});

test("缺少 target/ 时给出零估算且不抛错", (t) => {
  const root = workspace(t);
  const estimate = estimateArtifacts(path.join(root, "does-not-exist"));

  assert.deepEqual(estimate, {
    path: path.join(root, "does-not-exist", "target"),
    exists: false,
    totalBytes: 0,
    files: 0,
    byTopLevel: [],
  });
  assert.equal(formatArtifactEstimate(estimate), "no target/ directory");
});

test("条目预算用尽时标记 truncated 为 entries", (t) => {
  const root = workspace(t);
  const target = path.join(root, "target");
  mkdirSync(target, { recursive: true });
  for (let index = 0; index < 10; index += 1) {
    writeFileSync(path.join(target, `f${index}.bin`), Buffer.alloc(100));
  }

  const estimate = estimateArtifacts(root, { maxEntries: 3 });
  assert.equal(estimate.exists, true);
  assert.equal(estimate.truncated, "entries");
  assert.equal(estimate.files, 3);
  assert.ok(estimate.totalBytes > 0 && estimate.totalBytes <= 1000);
  assert.match(formatArtifactEstimate(estimate), /truncated: entries/);
});

test("深度预算用尽时标记 truncated 为 depth", (t) => {
  const root = workspace(t);
  const deep = path.join(root, "target", "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(deep, "x.bin"), Buffer.alloc(7));

  const estimate = estimateArtifacts(root, { maxDepth: 2 });
  assert.equal(estimate.exists, true);
  assert.equal(estimate.truncated, "depth");
  assert.equal(estimate.totalBytes, 0);
  assert.equal(estimate.files, 0);
  assert.match(formatArtifactEstimate(estimate), /truncated: depth/);
});
