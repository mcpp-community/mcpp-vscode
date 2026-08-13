import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stageAvailableProjectPcms } from "../src/pcm";

test("stages missing and newer module PCMs for a consumer", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-pcm-"));
  const source = path.join(root, "build", "pcm.cache");
  const destination = path.join(root, "test", "pcm.cache");
  try {
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(source, "mcpplibs.demo.pcm"), "module");
    writeFileSync(path.join(source, "std.pcm"), "std");
    writeFileSync(path.join(destination, "std.pcm"), "existing");

    const copied = stageAvailableProjectPcms({
      kind: "llvm",
      capability: "full",
      reason: "test",
      modulePcmSourceDirectories: [source],
      modulePcmConsumerDirectories: [destination],
    });

    assert.equal(copied, 1);
    assert.equal(existsSync(path.join(destination, "mcpplibs.demo.pcm")), true);
    assert.equal(readFileSync(path.join(destination, "std.pcm"), "utf8"), "existing");

    writeFileSync(path.join(source, "std.pcm"), "updated");
    const newer = new Date(Date.now() + 1_000);
    utimesSync(path.join(source, "std.pcm"), newer, newer);
    assert.equal(stageAvailableProjectPcms({
      kind: "llvm",
      capability: "full",
      reason: "test",
      modulePcmSourceDirectories: [source],
      modulePcmConsumerDirectories: [destination],
    }), 1);
    assert.equal(readFileSync(path.join(destination, "std.pcm"), "utf8"), "updated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
