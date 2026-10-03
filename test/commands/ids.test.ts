import assert from "node:assert/strict";
import test from "node:test";

import {
  CACHE_COMMANDS,
  CLI_COMMANDS,
  DEPRECATED_COMMANDS,
  LANGUAGE_SERVER_COMMANDS,
  LEGACY_LANGUAGE_SERVER_COMMANDS,
  TOOL_COMMANDS,
  contributedCommandIds,
} from "../../src/commands/ids";
import { QUICK_MENU_GROUPS, quickMenuItems, quickMenuStatusText } from "../../src/commands/menu";

const ALL = contributedCommandIds();

test("the status-bar label identifies mcpp and is not the language-service item", () => {
  assert.equal(quickMenuStatusText, "$(tools) mcpp");
});

test("no command id collides with a server-advertised mcppls id", () => {
  for (const id of ALL) {
    assert.ok(id.startsWith("mcpp."), `${id} must be namespaced with mcpp.`);
  }
});

test("ids are unique across every group", () => {
  assert.equal(new Set(ALL).size, ALL.length);
});

test("every 0.4.x id is still contributed", () => {
  for (const id of [
    "mcpp.showMenu",
    "mcpp.newProject",
    "mcpp.build",
    "mcpp.run",
    "mcpp.test",
    "mcpp.clean",
    "mcpp.showToolchains",
    "mcpp.installToolchain",
    "mcpp.selectDefaultToolchain",
    "mcpp.configureLanguageServer",
    "mcpp.refreshCompilationDatabase",
    "mcpp.checkModuleSupport",
    "mcpp.autoConfigureModules",
    "mcpp.showModuleGraph",
    "mcpp.showLanguageServerLogs",
    "mcpp.configureClangd",
  ]) {
    assert.ok(ALL.includes(id), `${id} disappeared`);
  }
});

test("the C++ Modules group lists every id it registers", () => {
  assert.deepEqual(Object.values(LANGUAGE_SERVER_COMMANDS), [
    "mcpp.languageServer.refreshState",
    "mcpp.languageServer.restart",
    "mcpp.languageServer.restartEngine",
    "mcpp.languageServer.resetWorkspaceCache",
    "mcpp.languageServer.selectContext",
    "mcpp.languageServer.showModuleGraph",
    "mcpp.languageServer.showLogs",
    "mcpp.languageServer.collectReport",
    "mcpp.languageServer.exportDiagnosticBundle",
    // Not every id here maps to an mcppls capability: `revealBundle` reveals the
    // zip the last capture wrote, which is this extension's own bookkeeping.
    "mcpp.languageServer.revealBundle",
    "mcpp.languageServer.openLogFolder",
    "mcpp.languageServer.runBuildToolInTerminal",
    "mcpp.languageServer.manageConflicts",
    "mcpp.languageServer.toggleInWorkspace",
    "mcpp.languageServer.installTools",
    "mcpp.languageServer.reviewChanges",
  ]);
});

test("the cache group carries both cleanup levels and the read-only pair", () => {
  assert.equal(CACHE_COMMANDS.cleanStale, "mcpp.cleanStaleArtifacts");
  assert.equal(CACHE_COMMANDS.cleanProject, "mcpp.cleanProjectArtifacts");
  assert.equal(CACHE_COMMANDS.verify, "mcpp.verifyGlobalCache");
  // The statistics moved into the sidebar view, so the "open a panel" command is gone.
  assert.ok(!("showPanel" in CACHE_COMMANDS));
  assert.equal(CACHE_COMMANDS.refreshStats, "mcpp.refreshCacheStats");
});

test("the deprecated alias is contributed but never offered", () => {
  assert.equal(DEPRECATED_COMMANDS.configureClangd, "mcpp.configureClangd");
  assert.ok(ALL.includes(DEPRECATED_COMMANDS.configureClangd));
  assert.ok(!quickMenuItems.some((item) => item.command === DEPRECATED_COMMANDS.configureClangd));
});

test("every menu entry names a contributed command and a non-empty label", () => {
  for (const item of quickMenuItems) {
    assert.ok(ALL.includes(item.command), `${item.command} is not contributed`);
    assert.ok(item.labelKey.length > 0);
    assert.ok(!/clangd/i.test(item.labelKey), `${item.labelKey} mentions clangd`);
    assert.ok(QUICK_MENU_GROUPS.some((group) => group.id === item.group), `${item.command} has no menu group`);
  }
});

test("the menu covers the four things a user looks for", () => {
  const commands = quickMenuItems.map((item) => item.command);
  assert.ok(commands.includes(CLI_COMMANDS.build));
  assert.ok(commands.includes(CACHE_COMMANDS.cleanStale));
  assert.ok(commands.includes(LANGUAGE_SERVER_COMMANDS.restart));
  assert.ok(commands.includes(TOOL_COMMANDS.selfCheck));
});

test("the legacy language-service ids are kept and distinct from the new ones", () => {
  for (const id of Object.values(LEGACY_LANGUAGE_SERVER_COMMANDS)) {
    assert.ok(ALL.includes(id), id);
  }
  assert.ok(
    !Object.values(LANGUAGE_SERVER_COMMANDS).some((id) =>
      (Object.values(LEGACY_LANGUAGE_SERVER_COMMANDS) as readonly string[]).includes(id),
    ),
  );
});
