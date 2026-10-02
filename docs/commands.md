# Commands

Every command this extension contributes, what it actually runs, and its title key.

All ids are listed in `src/commands/ids.ts`; the manifest is held to that list by
`test/artifacts.test.ts`, and `test/commands/ids.test.ts` checks the namespacing, the
uniqueness and that every 0.4.x id survived. A title key is the `%…%` placeholder in
`package.json`, resolved by VS Code from `package.nls.json` (English) or
`package.nls.zh-cn.json` at startup — so the Command Palette title follows the **VS Code display
language**, not `mcpp.ui.language`.

Our ids always use the `mcpp.` prefix and never `mcppls.`. See
[compatibility.md](compatibility.md#commands-we-must-not-register).

## Settings and diagnostics

| Command id | Title key | What it does |
| --- | --- | --- |
| `mcpp.openSettings` | `command.mcpp.openSettings.title` | Opens the extension's own settings panel (`src/config/panel.ts`). One panel per window |
| `mcpp.openMcpplsSettings` | `command.mcpp.openMcpplsSettings.title` | Runs `workbench.action.openSettings @ext:sunrisepeak.mcpp-language-server`. Hidden from the Command Palette (`commandPalette` → `when: false`); reachable from the C++ Modules view's **Actions** node |
| `mcpp.selfCheck` | `command.mcpp.selfCheck.title` | Probes `mcpp --protocol-version`, reads the mcppls state and the changed settings, and writes a copyable snapshot to the `mcpp` output channel |

## mcpp CLI and tasks

| Command id | Title key | What it does |
| --- | --- | --- |
| `mcpp.showMenu` | `command.mcpp.showMenu.title` | The quick menu (`src/commands/menu.ts`): 20 entries in five groups. Also the status bar item's command |
| `mcpp.newProject` | `command.mcpp.newProject.title` | Name prompt, folder prompt, then `mcpp new <name>` and `vscode.openFolder`. Never builds. Name validation in `src/cli/newProject.ts` |
| `mcpp.build` | `command.mcpp.build.title` | VS Code task, argv `["build"]` |
| `mcpp.run` | `command.mcpp.run.title` | VS Code task, argv `["run"]` |
| `mcpp.test` | `command.mcpp.test.title` | VS Code task, argv `["test"]` |
| `mcpp.clean` | `command.mcpp.clean.title` | VS Code task, argv `["clean"]`, after a modal confirmation. It is **not** an alias of `mcpp.cleanProjectArtifacts`: same argv, different path (task vs. `runProcess`) |
| `mcpp.showToolchains` | `command.mcpp.showToolchains.title` | `mcpp toolchain list`, parsed from its human output, shown in a read-only picker |
| `mcpp.installToolchain` | `command.mcpp.installToolchain.title` | `mcpp toolchain install <spec>` as a task, after naming what will be downloaded or detected |
| `mcpp.selectDefaultToolchain` | `command.mcpp.selectDefaultToolchain.title` | `mcpp toolchain default <spec>` via `runProcess`, then offers "clean and build" |
| `mcpp.autoConfigureModules` | `command.mcpp.autoConfigureModules.title` | One confirmation, then `mcpp build` and a language-service refresh |

Task details live in `src/cli/tasks.ts` (`projectTaskPlan`) and `src/cli/controller.ts`
(`executeTask`). Every task runs through a dedicated, reuse-message-free task terminal; the
presentation options are fixed (reveal always, focus, clear), so the `mcpp.task.*`
presentation settings are declared but not yet read.

## Cache

The policy — argv, confirmation level, whether a preview is shown — is a pure table in
`src/cli/clean.ts`; `src/views/cacheView.ts` only asks, runs and reports. See
[cache.md](cache.md) for the confirmation levels.

| Command id | Title key | What it does |
| --- | --- | --- |
| `mcpp.refreshCacheStats` | `command.mcpp.refreshCacheStats.title` | Re-runs `mcpp cache list --format json`, `mcpp cache dir` and the `target/` estimate |
| `mcpp.showCachePanel` | `command.mcpp.showCachePanel.title` | Refreshes, then opens the summary as a **read-only Markdown preview document** (there is no webview panel in this build) |
| `mcpp.showCacheEntry` | `command.mcpp.showCacheEntry.title` | `mcpp cache info <package>`, shown verbatim in a preview document; never parsed |
| `mcpp.cleanStaleArtifacts` | `command.mcpp.cleanStaleArtifacts.title` | `mcpp clean --dry-run`, shown as a preview, then `mcpp clean --stale --older-than <mcpp.cache.staleDays>d` |
| `mcpp.cleanProjectArtifacts` | `command.mcpp.cleanProjectArtifacts.title` | Modal offering `mcpp clean` and, as a second button, "Also empty the shared build cache"; that button escalates to `mcpp clean --bmi-cache` and a second acknowledgement |
| `mcpp.gcGlobalCache` | `command.mcpp.gcGlobalCache.title` | Asks for a GiB budget (default `mcpp.cache.gc.defaultBudgetGiB`, else half the current size), shows a local LRU estimate, then `mcpp cache gc --max-size <n>GiB` |
| `mcpp.pruneGlobalCache` | `command.mcpp.pruneGlobalCache.title` | `mcpp cache prune --older-than <mcpp.cache.pruneAgeDays>d` |
| `mcpp.verifyGlobalCache` | `command.mcpp.verifyGlobalCache.title` | `mcpp cache verify`; read-only, output in a preview document |
| `mcpp.cleanLegacyCache` | `command.mcpp.cleanLegacyCache.title` | `mcpp cache clean --legacy`. Reachable from the Command Palette; the cache view's node for it needs a byte count that this build does not measure |

## C++ Modules

These only forward to `sunrisepeak.mcpp-language-server`; nothing here reimplements language
behaviour. The capability table is `src/mcppls/contract.ts`, the probe is
`src/mcppls/capabilities.ts`, and a missing command becomes a warning plus the capability's own
`degradedHint` — never a failure of an mcpp command.

| Command id | Title key | Forwards to | Confirmation |
| --- | --- | --- | --- |
| `mcpp.languageServer.refreshState` | `command.mcpp.languageServer.refreshState.title` | nothing; re-renders the view | none |
| `mcpp.languageServer.restart` | `command.mcpp.languageServer.restart.title` | `mcppls.restartServer` | none |
| `mcpp.languageServer.restartEngine` | `command.mcpp.languageServer.restartEngine.title` | `mcppls.restartClangd` | confirm |
| `mcpp.languageServer.resetWorkspaceCache` | `command.mcpp.languageServer.resetWorkspaceCache.title` | `mcppls.resetWorkspaceCache` | destructive (modal) |
| `mcpp.languageServer.selectContext` | `command.mcpp.languageServer.selectContext.title` | `mcppls.selectContext` | none |
| `mcpp.languageServer.showModuleGraph` | `command.mcpp.languageServer.showModuleGraph.title` | `mcppls.showModuleGraph` | none |
| `mcpp.languageServer.showLogs` | `command.mcpp.languageServer.showLogs.title` | `mcppls.showLogs` | none |
| `mcpp.languageServer.collectReport` | `command.mcpp.languageServer.collectReport.title` | `mcppls.collectReport` | none |
| `mcpp.languageServer.exportDiagnosticBundle` | `command.mcpp.languageServer.exportDiagnosticBundle.title` | `mcppls.exportDiagnosticBundle` | none |
| `mcpp.languageServer.runBuildToolInTerminal` | `command.mcpp.languageServer.runBuildToolInTerminal.title` | `mcppls.runBuildToolInTerminal` | confirm |
| `mcpp.languageServer.manageConflicts` | `command.mcpp.languageServer.manageConflicts.title` | `mcppls.turnOffOtherCppFeatures` / `mcppls.restoreOtherCppFeatures`, called with `true` | confirm |
| `mcpp.languageServer.toggleInWorkspace` | `command.mcpp.languageServer.toggleInWorkspace.title` | `mcppls.turnOffInWorkspace` / `mcppls.turnOnInWorkspace`, called with `!mcppls.enable` | confirm |
| `mcpp.languageServer.installTools` | `command.mcpp.languageServer.installTools.title` | `mcppls.installCommandLineTools` | confirm |
| `mcpp.languageServer.reviewChanges` | `command.mcpp.languageServer.reviewChanges.title` | `mcppls.review.run` / `mcppls.review.clear`, called with `false` | none |

`refresh` for the build path uses a candidate chain
(`mcppls.reloadBuildDescription`, then `mcppls.restartServer`) and is single-flight, so two
builds cannot restart the language server twice. `mcpp.languageService.refreshAfterBuild` is
declared in the registry but is not read yet: the refresh always happens after a build that was
not cancelled.

## Aliases kept from 0.4.x

Ids do not change once shipped. A rename keeps the old id and points it at the new behaviour,
so an existing keybinding keeps working. Five of the six are marked `[Deprecated]` in their
title.

| Old id | Title key | Now does |
| --- | --- | --- |
| `mcpp.configureLanguageServer` | `command.mcpp.configureLanguageServer.title` | same as `mcpp.languageServer.selectContext` |
| `mcpp.configureClangd` | `command.mcpp.configureClangd.title` | same as `mcpp.languageServer.selectContext` |
| `mcpp.checkModuleSupport` | `command.mcpp.checkModuleSupport.title` | same as `mcpp.languageServer.restart` |
| `mcpp.showModuleGraph` | `command.mcpp.showModuleGraph.title` | same as `mcpp.languageServer.showModuleGraph` |
| `mcpp.showLanguageServerLogs` | `command.mcpp.showLanguageServerLogs.title` | same as `mcpp.languageServer.showLogs` |
| `mcpp.refreshCompilationDatabase` | `command.mcpp.refreshCompilationDatabase.title` | runs the `build` task. Its title is **not** marked deprecated |

## Menu and keybinding notes

- **Editor title**: `mcpp.run` (`navigation@1`) and `mcpp.test` (`navigation@2`), both gated on
  `mcpp.inProject`.
- **View title**: on `view == mcpp.cache`, `mcpp.refreshCacheStats` (`navigation@2`) and
  `mcpp.showCachePanel` (`navigation@3`); on `view == mcpp.languageServer`,
  `mcpp.languageServer.refreshState` (`navigation@2`) and `mcpp.languageServer.restart`
  (`navigation@3`).
- **Command Palette**: everything is visible except `mcpp.openMcpplsSettings`
  (`when: false`).
- **No keybindings are contributed.** `contributes.keybindings` is absent from `package.json`;
  bind your own if you want one.
- The status bar item (`$(tools) mcpp`, command `mcpp.showMenu`) is created in
  `src/cli/controller.ts` and is shown only while a project is found.
- `mcpp.internal.refreshProjectView` is registered by the project view but is **not**
  contributed, so it never appears in the palette.
