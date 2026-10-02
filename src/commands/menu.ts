import { CACHE_COMMANDS, CLI_COMMANDS, LANGUAGE_SERVER_COMMANDS, LIBRARY_COMMANDS, TOOL_COMMANDS } from "./ids";

/**
 * The status-bar menu, as **data**: entries are keyed by command id, the titles
 * are resolved through `src/i18n/t.ts` when the menu is built, and the icon is a
 * codicon id without the `$()` (the same convention `TreeNode.icon` uses).
 *
 * The groups are not decoration. They are what the menu is built from — the
 * quick pick renders one separator per group — so an entry and its section can
 * never disagree, and a section that ends up empty simply produces no separator.
 *
 * **Why there is no colour here.** `vscode.QuickPickItem.iconPath` accepts a
 * `ThemeIcon` with a `ThemeColor`, but VS Code 1.132 discards the colour:
 * `MainThreadQuickOpen.expandIconPath` turns the icon into a bare codicon class
 * (`o.iconClass = asClassName(e)`), and the list renderer only ever paints that
 * class in the row's ordinary foreground. The tree view keeps its colour, the
 * quick pick cannot have one, and a colour that is silently ignored is worse
 * than none — so the menu distinguishes rows by icon *shape* and by section.
 */
export interface QuickMenuItem {
  labelKey: string;
  command: string;
  /** A codicon id, e.g. `"tools"`. */
  icon: string;
  group: "project" | "library" | "toolchain" | "cache" | "languageServer" | "settings";
}

/** The groups, in the order the menu shows them. */
export const QUICK_MENU_GROUPS: ReadonlyArray<{ id: QuickMenuItem["group"]; labelKey: string }> = [
  { id: "project", labelKey: "Current mcpp project" },
  { id: "library", labelKey: "mcpp library ecosystem" },
  { id: "toolchain", labelKey: "mcpp toolchain management" },
  { id: "cache", labelKey: "Build cache" },
  { id: "languageServer", labelKey: "C++ Modules language service" },
  { id: "settings", labelKey: "Settings and diagnostics" },
];

export const quickMenuItems: readonly QuickMenuItem[] = [
  { labelKey: "Build", command: CLI_COMMANDS.build, icon: "tools", group: "project" },
  { labelKey: "Run", command: CLI_COMMANDS.run, icon: "play", group: "project" },
  { labelKey: "Test", command: CLI_COMMANDS.test, icon: "beaker", group: "project" },
  { labelKey: "Clean project artifacts", command: CACHE_COMMANDS.cleanProject, icon: "trash", group: "project" },

  { labelKey: "Search and add a dependency", command: LIBRARY_COMMANDS.search, icon: "library", group: "library" },
  { labelKey: "Refresh the mcpp Package Index", command: LIBRARY_COMMANDS.updateIndex, icon: "cloud-download", group: "library" },

  { labelKey: "Show toolchains", command: CLI_COMMANDS.showToolchains, icon: "chip", group: "toolchain" },
  { labelKey: "Install toolchain", command: CLI_COMMANDS.installToolchain, icon: "cloud-download", group: "toolchain" },
  { labelKey: "Select the global default toolchain", command: CLI_COMMANDS.selectDefaultToolchain, icon: "star", group: "toolchain" },

  { labelKey: "Refresh cache statistics", command: CACHE_COMMANDS.refreshStats, icon: "refresh", group: "cache" },
  { labelKey: "Clean stale artifacts", command: CACHE_COMMANDS.cleanStale, icon: "trash", group: "cache" },
  { labelKey: "Collect the global cache to a budget", command: CACHE_COMMANDS.collect, icon: "archive", group: "cache" },
  { labelKey: "Verify the shared cache", command: CACHE_COMMANDS.verify, icon: "verified", group: "cache" },

  { labelKey: "C++ Modules: restart the language server", command: LANGUAGE_SERVER_COMMANDS.restart, icon: "debug-restart", group: "languageServer" },
  { labelKey: "C++ Modules: select the analysis context", command: LANGUAGE_SERVER_COMMANDS.selectContext, icon: "symbol-interface", group: "languageServer" },
  { labelKey: "C++ Modules: show the module graph", command: LANGUAGE_SERVER_COMMANDS.showModuleGraph, icon: "type-hierarchy", group: "languageServer" },
  { labelKey: "C++ Modules: open the log", command: LANGUAGE_SERVER_COMMANDS.showLogs, icon: "output", group: "languageServer" },
  { labelKey: "C++ Modules: reset this workspace's cache", command: LANGUAGE_SERVER_COMMANDS.resetWorkspaceCache, icon: "trash", group: "languageServer" },

  { labelKey: "Build and refresh the language service", command: CLI_COMMANDS.autoConfigureModules, icon: "refresh", group: "settings" },
  { labelKey: "Environment self-check", command: TOOL_COMMANDS.selfCheck, icon: "heart", group: "settings" },
  { labelKey: "mcpp settings", command: TOOL_COMMANDS.openSettings, icon: "settings-gear", group: "settings" },
];

export const quickMenuStatusText = "$(tools) mcpp";
