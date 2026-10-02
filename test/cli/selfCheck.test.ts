import assert from "node:assert/strict";
import test from "node:test";

import { buildSelfCheckText, type SelfCheckInput } from "../../src/cli/selfCheck";

const BASE: SelfCheckInput = {
  extensionVersion: "0.5.0",
  vscodeVersion: "1.91.0",
  platform: "linux-x64",
  languagePreference: "auto",
  trusted: true,
  workspaceRoots: ["/w"],
  projectRoot: "/w",
  mcppPath: "/usr/bin/mcpp",
  mcppProbe: { version: "2026.9.30.2", envelopeMax: 1, kinds: ["mcpp.env", "mcpp.toolchain.list"] },
  mcppls: {
    installed: true,
    version: "0.0.9",
    enabled: true,
    state: "ready · project mcpp · engine clangd 23.1.0",
    capabilities: [
      { key: "refresh", state: "available", command: "mcppls.reloadBuildDescription" },
      { key: "moduleGraph", state: "missing" },
    ],
  },
  cache: { totalBytes: 7_736_306_884, entries: 657, incomplete: 2 },
  changedSettings: [{ key: "mcpp.cache.staleDays", value: 7, source: "workspace" }],
  lastRefresh: { at: "2026-10-02T12:00:00Z", state: "completed", command: "mcppls.reloadBuildDescription" },
};

test("the snapshot names every version and platform up front", () => {
  const text = buildSelfCheckText(BASE);
  assert.match(text, /^mcpp-vscode 0\.5\.0 · VS Code 1\.91\.0 · linux-x64$/m);
  assert.match(text, /Language\s+auto/);
  assert.match(text, /Workspace\s+trusted · 1 root\(s\)/);
});

test("an untrusted workspace is called out", () => {
  assert.match(buildSelfCheckText({ ...BASE, trusted: false }), /NOT trusted/);
});

test("the mcpp section reports the protocol and the advertised kinds", () => {
  const text = buildSelfCheckText(BASE);
  assert.match(text, /version\s+2026\.9\.30\.2/);
  assert.match(text, /envelope\s+1/);
  assert.match(text, /kinds\s+mcpp\.env, mcpp\.toolchain\.list/);
});

test("a missing protocol answer is reported as unknown, not left blank", () => {
  const text = buildSelfCheckText({ ...BASE, mcppProbe: undefined });
  assert.match(text, /version\s+unknown \(mcpp --protocol-version did not answer\)/);
});

test("the language-service section lists each capability and its fate", () => {
  const text = buildSelfCheckText(BASE);
  assert.match(text, /refresh\s+available → mcppls\.reloadBuildDescription/);
  assert.match(text, /moduleGraph\s+missing/);
  assert.match(text, /last refresh\s+completed at 2026-10-02T12:00:00Z/);
});

test("a language service that has never refreshed says so", () => {
  assert.match(buildSelfCheckText({ ...BASE, lastRefresh: undefined }), /last refresh\s+never/);
});

test("the cache figure is formatted, and an unread cache says so", () => {
  assert.match(buildSelfCheckText(BASE), /shared\s+7\.20 GiB · 657 entries · 2 incomplete/);
  assert.match(buildSelfCheckText({ ...BASE, cache: undefined }), /shared\s+not read/);
});

test("changed settings are listed with the scope that won", () => {
  const text = buildSelfCheckText(BASE);
  assert.match(text, /Settings changed from their default \(1\)/);
  assert.match(text, /workspace\s+mcpp\.cache\.staleDays = 7/);
});

test("no changed settings is stated rather than shown as an empty list", () => {
  assert.match(buildSelfCheckText({ ...BASE, changedSettings: [] }), /none/);
});

test("a workspace with no project says so", () => {
  assert.match(buildSelfCheckText({ ...BASE, projectRoot: undefined }), /Project\s+no mcpp\.toml found/);
});

test("every workspace root is listed", () => {
  const text = buildSelfCheckText({ ...BASE, workspaceRoots: ["/a", "/b"] });
  assert.match(text, /2 root\(s\)/);
  assert.match(text, /folder\s+\/a/);
  assert.match(text, /folder\s+\/b/);
});
