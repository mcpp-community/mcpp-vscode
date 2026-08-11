import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveClangdCandidates,
  findNearestMcppProject,
  isPathWithinProject,
  manifestProjectRoot,
  projectAffectedByManifest,
  shouldReconcileDeletedManifest,
} from "../src/discovery";

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

test("routes a deleted manifest only to the project that owned it", () => {
  assert.equal(manifestProjectRoot("/work/member/mcpp.toml"), path.join("/work", "member"));
  assert.equal(shouldReconcileDeletedManifest("/work/member", "/work/member/mcpp.toml"), true);
  assert.equal(shouldReconcileDeletedManifest("/work/other", "/work/member/mcpp.toml"), false);
  assert.equal(isPathWithinProject("/work/member", "/work"), true);
  assert.equal(isPathWithinProject("/work-other/member", "/work"), false);
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

test("does not treat a virtual workspace root as a package project", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-virtual-workspace-"));
  try {
    writeFileSync(path.join(root, "mcpp.toml"), "[workspace]\nmembers = ['A', 'B']\n");

    // #387 在 virtual workspace 根执行 configure-only 时只发布 member CDB，
    // 根目录本身没有可供 clangd 消费的 compile_commands.json。
    assert.equal(findNearestMcppProject(root, root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a rooted workspace as a package project", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-rooted-workspace-"));
  try {
    writeFileSync(
      path.join(root, "mcpp.toml"),
      "[package]\nname = 'root'\n[workspace]\nmembers = ['A']\n",
    );

    assert.equal(findNearestMcppProject(root, root)?.root, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recognizes dotted virtual and inline rooted workspace manifests", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-workspace-toml-forms-"));
  try {
    writeFileSync(path.join(root, "mcpp.toml"), "workspace.members = ['A']\n");
    assert.equal(findNearestMcppProject(root, root), undefined);

    writeFileSync(
      path.join(root, "mcpp.toml"),
      "package = { name = 'root', version = '0.1.0' }\n[workspace]\nmembers = ['A']\n",
    );
    assert.equal(findNearestMcppProject(root, root)?.root, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routes workspace root manifest changes to the active member", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-workspace-change-"));
  try {
    const memberRoot = path.join(root, "A");
    const member = {
      root: memberRoot,
      manifestPath: path.join(memberRoot, "mcpp.toml"),
      compilationDatabasePath: path.join(memberRoot, "compile_commands.json"),
    };
    const rootProject = {
      root,
      manifestPath: path.join(root, "mcpp.toml"),
      compilationDatabasePath: path.join(root, "compile_commands.json"),
    };
    mkdirSync(memberRoot, { recursive: true });

    writeFileSync(rootProject.manifestPath, "[workspace]\nmembers = ['A']\n");
    assert.deepEqual(
      projectAffectedByManifest(rootProject.manifestPath, member, undefined),
      member,
    );

    writeFileSync(
      rootProject.manifestPath,
      "[package]\nname = 'root'\n[workspace]\nmembers = ['A']\n",
    );
    assert.deepEqual(
      projectAffectedByManifest(rootProject.manifestPath, member, rootProject),
      member,
    );
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
