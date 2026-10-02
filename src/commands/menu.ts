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
 * ## Why the icons are files
 *
 * `vscode.QuickPickItem.iconPath` accepts a `ThemeIcon`, but VS Code 1.132
 * discards its colour: `MainThreadQuickOpen.expandIconPath` turns the icon into a
 * bare codicon class (`o.iconClass = asClassName(e)`), and the list renderer only
 * ever paints that class in the row's ordinary foreground. A `Uri` is different —
 * it becomes the row's `background-image`, painted as-is — so the only way to
 * colour a quick pick icon is to *ship a coloured image*.
 *
 * That is what `iconColor` is for. It is a **palette word** (`blue`, `green`, …),
 * not a theme-colour id like `TreeNode.iconColor`, because the colour is baked
 * into the file and cannot follow the theme the way a `ThemeIcon` does. Each word
 * resolves to the default light and dark value of the matching `charts.*` token,
 * so the menu and the project tree agree; `media/quick-menu/<icon>--<colour>--
 * <dark|light>.svg` is generated from `@vscode/codicons` by
 * `tools/generate-quick-menu-icons.mjs`, and `test/commands/menu.test.ts` walks
 * this table and stats every file so the two cannot drift apart.
 *
 * The palette groups rows by **what they do**, the same way the tree does: blue
 * builds or adds, green runs or verifies, purple tests or collects, yellow
 * manages the toolchain, red deletes, and `neutral` is for rows whose only job is
 * to configure or report.
 */
export interface QuickMenuItem {
  labelKey: string;
  command: string;
  /** A codicon id, e.g. `"tools"`. */
  icon: string;
  /** A palette word; see the note above. */
  iconColor: QuickMenuColour;
  group: "project" | "library" | "toolchain" | "cache" | "languageServer" | "settings";
}

/** The palette words `iconColor` may use; the generator owns their values. */
export const QUICK_MENU_COLOURS = ["blue", "green", "purple", "yellow", "red", "neutral"] as const;

export type QuickMenuColour = (typeof QUICK_MENU_COLOURS)[number];

/** The groups, in the order the menu shows them. */
export const QUICK_MENU_GROUPS: ReadonlyArray<{ id: QuickMenuItem["group"]; labelKey: string }> = [
  { id: "project", labelKey: "Current mcpp project" },
  { id: "library", labelKey: "mcpp library ecosystem" },
  { id: "toolchain", labelKey: "mcpp toolchain management" },
  { id: "cache", labelKey: "Build cache" },
  { id: "languageServer", labelKey: "C++ Modules language service" },
  { id: "settings", labelKey: "Settings and diagnostics" },
];

/**
 * The asset name for one row's icon in one theme.
 *
 * The generator writes exactly these names; the test checks that every one of
 * them exists, which is what keeps this convention and the files in step.
 */
export function quickMenuIconAsset(item: QuickMenuItem, theme: "dark" | "light"): string {
  return `${item.icon}--${item.iconColor}--${theme}.svg`;
}

export const quickMenuItems: readonly QuickMenuItem[] = [
  { labelKey: "Build", command: CLI_COMMANDS.build, icon: "tools", iconColor: "blue", group: "project" },
  { labelKey: "Run", command: CLI_COMMANDS.run, icon: "play", iconColor: "green", group: "project" },
  { labelKey: "Test", command: CLI_COMMANDS.test, icon: "beaker", iconColor: "purple", group: "project" },
  { labelKey: "Clean project artifacts", command: CACHE_COMMANDS.cleanProject, icon: "trash", iconColor: "red", group: "project" },

  { labelKey: "Search and add a dependency", command: LIBRARY_COMMANDS.search, icon: "library", iconColor: "blue", group: "library" },
  { labelKey: "Refresh the mcpp Package Index", command: LIBRARY_COMMANDS.updateIndex, icon: "cloud-download", iconColor: "blue", group: "library" },

  { labelKey: "Show toolchains", command: CLI_COMMANDS.showToolchains, icon: "chip", iconColor: "yellow", group: "toolchain" },
  { labelKey: "Install toolchain", command: CLI_COMMANDS.installToolchain, icon: "cloud-download", iconColor: "yellow", group: "toolchain" },
  { labelKey: "Select the global default toolchain", command: CLI_COMMANDS.selectDefaultToolchain, icon: "star-full", iconColor: "yellow", group: "toolchain" },

  { labelKey: "Refresh cache statistics", command: CACHE_COMMANDS.refreshStats, icon: "refresh", iconColor: "green", group: "cache" },
  { labelKey: "Clean stale artifacts", command: CACHE_COMMANDS.cleanStale, icon: "trash", iconColor: "red", group: "cache" },
  { labelKey: "Collect the global cache to a budget", command: CACHE_COMMANDS.collect, icon: "archive", iconColor: "purple", group: "cache" },
  { labelKey: "Verify the shared cache", command: CACHE_COMMANDS.verify, icon: "verified", iconColor: "green", group: "cache" },

  { labelKey: "C++ Modules: restart the language server", command: LANGUAGE_SERVER_COMMANDS.restart, icon: "debug-restart", iconColor: "neutral", group: "languageServer" },
  { labelKey: "C++ Modules: select the analysis context", command: LANGUAGE_SERVER_COMMANDS.selectContext, icon: "symbol-interface", iconColor: "neutral", group: "languageServer" },
  { labelKey: "C++ Modules: show the module graph", command: LANGUAGE_SERVER_COMMANDS.showModuleGraph, icon: "type-hierarchy", iconColor: "neutral", group: "languageServer" },
  { labelKey: "C++ Modules: open the log", command: LANGUAGE_SERVER_COMMANDS.showLogs, icon: "output", iconColor: "neutral", group: "languageServer" },
  { labelKey: "C++ Modules: reset this workspace's cache", command: LANGUAGE_SERVER_COMMANDS.resetWorkspaceCache, icon: "trash", iconColor: "neutral", group: "languageServer" },

  { labelKey: "Build and refresh the language service", command: CLI_COMMANDS.autoConfigureModules, icon: "refresh", iconColor: "blue", group: "settings" },
  { labelKey: "Environment self-check", command: TOOL_COMMANDS.selfCheck, icon: "heart", iconColor: "green", group: "settings" },
  { labelKey: "mcpp settings", command: TOOL_COMMANDS.openSettings, icon: "settings-gear", iconColor: "neutral", group: "settings" },
];

export const quickMenuStatusText = "$(tools) mcpp";
