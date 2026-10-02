import { CACHE_COMMANDS, CLI_COMMANDS, LANGUAGE_SERVER_COMMANDS, LIBRARY_COMMANDS, TOOL_COMMANDS } from "./ids";

/**
 * The status-bar menu. Entries are keyed by command id; the titles are resolved
 * through `src/i18n/t.ts` when the menu is built, so this table stays data.
 */
export interface QuickMenuItem {
  labelKey: string;
  command: string;
  group: "project" | "toolchain" | "cache" | "languageServer" | "settings";
}

export const quickMenuItems: readonly QuickMenuItem[] = [
  { labelKey: "Build", command: CLI_COMMANDS.build, group: "project" },
  { labelKey: "Run", command: CLI_COMMANDS.run, group: "project" },
  { labelKey: "Test", command: CLI_COMMANDS.test, group: "project" },
  { labelKey: "Clean project artifacts", command: CACHE_COMMANDS.cleanProject, group: "project" },

  { labelKey: "Show toolchains", command: CLI_COMMANDS.showToolchains, group: "toolchain" },
  { labelKey: "Install toolchain", command: CLI_COMMANDS.installToolchain, group: "toolchain" },
  { labelKey: "Select the global default toolchain", command: CLI_COMMANDS.selectDefaultToolchain, group: "toolchain" },

  { labelKey: "Clean stale artifacts", command: CACHE_COMMANDS.cleanStale, group: "cache" },
  { labelKey: "Refresh cache statistics", command: CACHE_COMMANDS.refreshStats, group: "cache" },
  { labelKey: "Search and add a dependency", command: LIBRARY_COMMANDS.search, group: "cache" },
  { labelKey: "Collect the global cache to a budget", command: CACHE_COMMANDS.collect, group: "cache" },
  { labelKey: "Verify the shared cache", command: CACHE_COMMANDS.verify, group: "cache" },

  { labelKey: "C++ Modules: restart the language server", command: LANGUAGE_SERVER_COMMANDS.restart, group: "languageServer" },
  { labelKey: "C++ Modules: select the analysis context", command: LANGUAGE_SERVER_COMMANDS.selectContext, group: "languageServer" },
  { labelKey: "C++ Modules: show the module graph", command: LANGUAGE_SERVER_COMMANDS.showModuleGraph, group: "languageServer" },
  { labelKey: "C++ Modules: open the log", command: LANGUAGE_SERVER_COMMANDS.showLogs, group: "languageServer" },
  { labelKey: "C++ Modules: reset this workspace's cache", command: LANGUAGE_SERVER_COMMANDS.resetWorkspaceCache, group: "languageServer" },

  { labelKey: "Build and refresh the language service", command: CLI_COMMANDS.autoConfigureModules, group: "settings" },
  { labelKey: "Environment self-check", command: TOOL_COMMANDS.selfCheck, group: "settings" },
  { labelKey: "mcpp settings", command: TOOL_COMMANDS.openSettings, group: "settings" },
];

export const quickMenuStatusText = "$(tools) mcpp";

/** The group a menu entry belongs to, localized by the caller. */
export const QUICK_MENU_GROUPS: ReadonlyArray<{ id: QuickMenuItem["group"]; labelKey: string }> = [
  { id: "project", labelKey: "Current mcpp project" },
  { id: "toolchain", labelKey: "mcpp toolchain management" },
  { id: "cache", labelKey: "Build cache" },
  { id: "languageServer", labelKey: "C++ Modules language service" },
  { id: "settings", labelKey: "Settings and diagnostics" },
];
