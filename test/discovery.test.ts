import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveClangdCandidates, findNearestMcppProject } from "../src/discovery";

test("finds the nearest mcpp manifest and root compilation database", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-discovery-"));
  try {
    const sourceDirectory = path.join(root, "src", "nested");
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(path.join(root, "mcpp.toml"), "[package]\nname = 'demo'\n");
    writeFileSync(path.join(root, "compile_commands.json"), "[]\n");

    assert.deepEqual(findNearestMcppProject(sourceDirectory), {
      root,
      manifestPath: path.join(root, "mcpp.toml"),
      compilationDatabasePath: path.join(root, "compile_commands.json"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derives sibling, xlings and PATH clangd candidates", () => {
  assert.deepEqual(
    deriveClangdCandidates("/tools/xim-x-llvm/22.1.8/bin/clang++"),
    [
      "/tools/xim-x-llvm/22.1.8/bin/clangd",
      "/tools/xim-x-llvm-tools/22.1.8/bin/clangd",
      "clangd",
    ],
  );
});

test("derives the user xlings tools path from an mcpp registry compiler", () => {
  assert.deepEqual(
    deriveClangdCandidates(
      "/Users/demo/.mcpp/registry/data/xpkgs/xim-x-llvm/22.1.8/bin/clang++",
    ),
    [
      "/Users/demo/.mcpp/registry/data/xpkgs/xim-x-llvm/22.1.8/bin/clangd",
      "/Users/demo/.mcpp/registry/data/xpkgs/xim-x-llvm-tools/22.1.8/bin/clangd",
      "/Users/demo/.xlings/data/xpkgs/xim-x-llvm-tools/22.1.8/bin/clangd",
      "clangd",
    ],
  );
});
