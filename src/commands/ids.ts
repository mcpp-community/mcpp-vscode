/**
 * Every command id this extension contributes, in one place.
 *
 * Two rules live here:
 *
 * 1. **`mcpp.` only.** Our ids must never collide with a command the C++ Modules
 *    server advertises (`mcppls.*`): `vscode-languageclient` registers those
 *    itself, and a duplicate id stops the language client from starting
 *    (mcppls's S3-5.6-3). `test/mcppls/contract.test.ts` asserts this.
 * 2. **Ids do not change once shipped.** A rename keeps the old id and points it
 *    at the new implementation, so a user's keybinding keeps working — see
 *    `DEPRECATED_COMMANDS` below.
 */

/** mcpp CLI commands that existed in 0.4.x. */
export const CLI_COMMANDS = {
  showMenu: "mcpp.showMenu",
  newProject: "mcpp.newProject",
  build: "mcpp.build",
  run: "mcpp.run",
  test: "mcpp.test",
  clean: "mcpp.clean",
  showToolchains: "mcpp.showToolchains",
  installToolchain: "mcpp.installToolchain",
  selectDefaultToolchain: "mcpp.selectDefaultToolchain",
  autoConfigureModules: "mcpp.autoConfigureModules",
} as const;

/** The language-service entries that existed in 0.4.x (kept as aliases, see below). */
export const LEGACY_LANGUAGE_SERVER_COMMANDS = {
  configureLanguageServer: "mcpp.configureLanguageServer",
  refreshCompilationDatabase: "mcpp.refreshCompilationDatabase",
  checkModuleSupport: "mcpp.checkModuleSupport",
  showModuleGraph: "mcpp.showModuleGraph",
  showLanguageServerLogs: "mcpp.showLanguageServerLogs",
} as const;

/** The C++ Modules view and everything it forwards. */
export const LANGUAGE_SERVER_COMMANDS = {
  refreshState: "mcpp.languageServer.refreshState",
  restart: "mcpp.languageServer.restart",
  restartEngine: "mcpp.languageServer.restartEngine",
  resetWorkspaceCache: "mcpp.languageServer.resetWorkspaceCache",
  selectContext: "mcpp.languageServer.selectContext",
  showModuleGraph: "mcpp.languageServer.showModuleGraph",
  showLogs: "mcpp.languageServer.showLogs",
  collectReport: "mcpp.languageServer.collectReport",
  exportDiagnosticBundle: "mcpp.languageServer.exportDiagnosticBundle",
  runBuildToolInTerminal: "mcpp.languageServer.runBuildToolInTerminal",
  manageConflicts: "mcpp.languageServer.manageConflicts",
  toggleInWorkspace: "mcpp.languageServer.toggleInWorkspace",
  installTools: "mcpp.languageServer.installTools",
  reviewChanges: "mcpp.languageServer.reviewChanges",
} as const;

/** Cache statistics and the cleanup table. */
export const CACHE_COMMANDS = {
  refreshStats: "mcpp.refreshCacheStats",
  showEntry: "mcpp.showCacheEntry",
  cleanStale: "mcpp.cleanStaleArtifacts",
  cleanProject: "mcpp.cleanProjectArtifacts",
  collect: "mcpp.gcGlobalCache",
  prune: "mcpp.pruneGlobalCache",
  verify: "mcpp.verifyGlobalCache",
  cleanLegacy: "mcpp.cleanLegacyCache",
} as const;

/**
 * The library-ecosystem view. The list and the detail page talk to their
 * webviews over messages, so these are the only ids a menu can name.
 */
export const LIBRARY_COMMANDS = {
  search: "mcpp.library.search",
  openDetail: "mcpp.library.openDetail",
  updateIndex: "mcpp.library.updateIndex",
} as const;

/** Settings, diagnostics and the mcpp CLI entry points added in 0.5.0. */
export const TOOL_COMMANDS = {
  openSettings: "mcpp.openSettings",
  openLanguageServerSettings: "mcpp.openMcpplsSettings",
  selfCheck: "mcpp.selfCheck",
} as const;

/**
 * Ids kept for compatibility. A keybinding or a script that names one of these
 * still works; the menu shows the new title.
 */
export const DEPRECATED_COMMANDS = {
  configureClangd: "mcpp.configureClangd",
} as const;

export type CommandId =
  | (typeof CLI_COMMANDS)[keyof typeof CLI_COMMANDS]
  | (typeof LEGACY_LANGUAGE_SERVER_COMMANDS)[keyof typeof LEGACY_LANGUAGE_SERVER_COMMANDS]
  | (typeof LANGUAGE_SERVER_COMMANDS)[keyof typeof LANGUAGE_SERVER_COMMANDS]
  | (typeof CACHE_COMMANDS)[keyof typeof CACHE_COMMANDS]
  | (typeof LIBRARY_COMMANDS)[keyof typeof LIBRARY_COMMANDS]
  | (typeof TOOL_COMMANDS)[keyof typeof TOOL_COMMANDS];

/** Every id the manifest contributes, in the order the palette shows them. */
export function contributedCommandIds(): string[] {
  return [
    ...Object.values(TOOL_COMMANDS),
    ...Object.values(CLI_COMMANDS),
    ...Object.values(CACHE_COMMANDS),
    ...Object.values(LIBRARY_COMMANDS),
    ...Object.values(LANGUAGE_SERVER_COMMANDS),
    ...Object.values(LEGACY_LANGUAGE_SERVER_COMMANDS),
    ...Object.values(DEPRECATED_COMMANDS),
  ];
}
