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

test("selects the nearest member inside a multi-member workspace", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-members-"));
  try {
    const memberA = path.join(root, "A");
    const memberB = path.join(root, "B");
    const sourceA = path.join(memberA, "src");
    const sourceB = path.join(memberB, "src");
    mkdirSync(sourceA, { recursive: true });
    mkdirSync(sourceB, { recursive: true });
    writeFileSync(path.join(root, "mcpp.toml"), "[workspace]\nmembers = ['A', 'B']\n");
    writeFileSync(path.join(memberA, "mcpp.toml"), "[package]\nname = 'A'\n");
    writeFileSync(path.join(memberB, "mcpp.toml"), "[package]\nname = 'B'\n");

    assert.equal(findNearestMcppProject(sourceA, root)?.root, memberA);
    assert.equal(findNearestMcppProject(sourceB, root)?.root, memberB);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not discover an mcpp project outside the opened workspace folder", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-workspace-boundary-"));
  try {
    const openedMember = path.join(root, "A");
    const externalMemberSource = path.join(root, "B", "src");
    mkdirSync(openedMember, { recursive: true });
    mkdirSync(externalMemberSource, { recursive: true });
    writeFileSync(path.join(openedMember, "mcpp.toml"), "[package]\nname = 'A'\n");
    writeFileSync(path.join(root, "B", "mcpp.toml"), "[package]\nname = 'B'\n");

    assert.equal(findNearestMcppProject(externalMemberSource, openedMember), undefined);
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
