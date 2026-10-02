/**
 * The project view: two labelled sections — 「基本信息」 and 「常用命令」.
 *
 * The first section is what the project is (identity, target, toolchain, the
 * declared dependencies and the folded C++ Modules block); the second is what can
 * be done to it. The summary is read from `mcpp.toml` and refreshed when the
 * manifest changes; anything unreadable is omitted rather than guessed, and
 * `mcpp: Environment Self-check` is the place that reports what mcpp itself
 * resolves.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import * as vscode from "vscode";

import { readProjectSummary } from "../projects/summary";
import { MCPP_MANIFEST_GLOB } from "../projects/context";
import type { McppProjectDiscovery } from "../projects/discovery";
import type { LanguageServerBlockSource } from "./languageServerView";
import {
  buildProjectTree,
  countSourceFiles,
  keybindingsFromPackage,
  readDependencies,
  readLockfile,
  type KeyboardPlatform,
  type LockPackage,
  type ProjectSummary,
} from "./models";
import { registerTreeView } from "./treeProvider";

export const PROJECT_VIEW_ID = "mcpp.project";

export interface ProjectViewDeps {
  currentProject: () => McppProjectDiscovery | undefined;
  /**
   * The folded C++ Modules block. Omit it and the block is never rendered, which
   * is also what happens when `mcpp.views.languageServer.show` is off.
   */
  languageService?: LanguageServerBlockSource;
}

/** `mcpp.lock` sits next to `mcpp.toml`, and changes without the manifest changing. */
const LOCKFILE_NAME = "mcpp.lock";
const LOCKFILE_GLOB = "**/mcpp.lock";

/** Read one manifest into a summary; a failure becomes `error`, never a throw. */
export function summariseProject(project: McppProjectDiscovery | undefined): ProjectSummary | undefined {
  if (project === undefined) {
    return undefined;
  }
  try {
    const text = readFileSync(project.manifestPath, "utf8");
    const lines = text.split(/\r?\n/);
    const summary = readProjectSummary(project.root, lines);
    const dependencies = readDependencies(lines);
    return dependencies.length === 0 ? summary : { ...summary, dependencies };
  } catch (error) {
    return {
      root: project.root,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface ProjectSnapshot {
  summary: ProjectSummary | undefined;
  lock: LockPackage[];
}

export function registerProjectView(context: vscode.ExtensionContext, deps: ProjectViewDeps): void {
  // Read from the manifest rather than copied into the source: a hint in the tree
  // that disagrees with `package.json` is worse than no hint.
  const keybindings = keybindingsFromPackage(context.extension.packageJSON);
  const platform: KeyboardPlatform = process.platform === "darwin" ? "mac" : "other";
  const bridge = deps.languageService;

  // Counting source files walks the project, so it is not repeated for every
  // active-editor change: the manifest watcher and a workspace-folder change ask
  // for a fresh count, everything else reuses the last one.
  let measured: { root: string; count: number } | undefined;
  const withSources = (summary: ProjectSummary | undefined, fresh: boolean): ProjectSummary | undefined => {
    if (summary === undefined || summary.error !== undefined) {
      return summary;
    }
    if (fresh || measured === undefined || measured.root !== summary.root) {
      measured = { root: summary.root, count: countSourceFiles(summary.root) };
    }
    return { ...summary, sourceFiles: measured.count };
  };

  const snapshot = (project: McppProjectDiscovery | undefined, freshSources: boolean): ProjectSnapshot => ({
    summary: withSources(summariseProject(project), freshSources),
    lock: project === undefined ? [] : readLockfile(path.join(project.root, LOCKFILE_NAME)),
  });

  let current = snapshot(deps.currentProject(), true);

  const view = registerTreeView(PROJECT_VIEW_ID, () =>
    buildProjectTree(current.summary, {
      lock: current.lock,
      keybindings,
      platform,
      languageService: bridge?.input(),
    }),
  );
  context.subscriptions.push(view.disposable);

  const reload = (freshSources: boolean): void => {
    current = snapshot(deps.currentProject(), freshSources);
    view.provider.refresh();
  };

  const manifestWatcher = vscode.workspace.createFileSystemWatcher(MCPP_MANIFEST_GLOB);
  const lockWatcher = vscode.workspace.createFileSystemWatcher(LOCKFILE_GLOB);
  context.subscriptions.push(
    manifestWatcher,
    lockWatcher,
    manifestWatcher.onDidCreate(() => reload(true)),
    manifestWatcher.onDidChange(() => reload(true)),
    manifestWatcher.onDidDelete(() => reload(true)),
    lockWatcher.onDidCreate(() => reload(false)),
    lockWatcher.onDidChange(() => reload(false)),
    lockWatcher.onDidDelete(() => reload(false)),
    vscode.window.onDidChangeActiveTextEditor(() => reload(false)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => reload(true)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => reload(true)),
  );

  if (bridge !== undefined) {
    const tree = view.view;
    context.subscriptions.push(
      bridge.onDidChange(() => reload(false)),
      // The folded block's poller only runs while this tree is on screen.
      tree.onDidChangeVisibility(() => bridge.setVisible(tree.visible)),
    );
    bridge.setVisible(tree.visible);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("mcpp.internal.refreshProjectView", async () => {
      reload(true);
    }),
  );

  reload(true);
}
