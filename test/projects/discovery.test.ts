import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findNearestMcppProject, discoveryBoundaryOf } from "../../src/projects/discovery";

test("finds the nearest mcpp manifest and project root", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-discovery-"));
  try {
    const sourceDirectory = path.join(root, "src", "nested");
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(path.join(root, "mcpp.toml"), "[package]\nname = 'demo'\n");

    assert.deepEqual(findNearestMcppProject(sourceDirectory), {
      root,
      manifestPath: path.join(root, "mcpp.toml"),
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
    assert.equal(findNearestMcppProject(externalMemberSource, openedMember, "workspaceFolder"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcpp.project.discoveryBoundary=filesystem finds the nested project outside the workspace", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcpp-vscode-discovery-filesystem-"));
  try {
    const openedMember = path.join(root, "A");
    const externalMember = path.join(root, "B");
    const externalMemberSource = path.join(externalMember, "src", "nested");
    mkdirSync(openedMember, { recursive: true });
    mkdirSync(externalMemberSource, { recursive: true });
    writeFileSync(path.join(openedMember, "mcpp.toml"), "[package]\nname = 'A'\n");
    writeFileSync(path.join(externalMember, "mcpp.toml"), "[package]\nname = 'B'\n");

    // The boundary parameter is the only difference; ignoring it fails this test.
    assert.deepEqual(findNearestMcppProject(externalMemberSource, openedMember, "filesystem"), {
      root: externalMember,
      manifestPath: path.join(externalMember, "mcpp.toml"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the discovery boundary setting maps to the two supported walks", () => {
  assert.equal(discoveryBoundaryOf("filesystem"), "filesystem");
  assert.equal(discoveryBoundaryOf("workspaceFolder"), "workspaceFolder");
  // An unknown value keeps the shipped behaviour: stop at the workspace folder.
  assert.equal(discoveryBoundaryOf("everything"), "workspaceFolder");
  assert.equal(discoveryBoundaryOf(undefined), "workspaceFolder");
});
