/**
 * The project view: identity, toolchain, targets, actions.
 *
 * The summary is read from `mcpp.toml` and refreshed when the manifest changes;
 * anything unreadable is omitted rather than guessed, and `mcpp: Environment
 * Self-check` is the place that reports what mcpp itself resolves.
 */

import { readFileSync } from "node:fs";

import * as vscode from "vscode";

import { readProjectSummary } from "../projects/summary";
import { MCPP_MANIFEST_GLOB } from "../projects/context";
import type { McppProjectDiscovery } from "../projects/discovery";
import { buildProjectTree } from "./models";
import { registerTreeView } from "./treeProvider";

export const PROJECT_VIEW_ID = "mcpp.project";

export interface ProjectViewDeps {
  currentProject: () => McppProjectDiscovery | undefined;
}

/** Read one manifest into a summary; a failure becomes `error`, never a throw. */
export function summariseProject(project: McppProjectDiscovery | undefined): ReturnType<typeof readProjectSummary> | undefined {
  if (project === undefined) {
    return undefined;
  }
  try {
    const text = readFileSync(project.manifestPath, "utf8");
    return readProjectSummary(project.root, text.split(/\r?\n/));
  } catch (error) {
    return {
      root: project.root,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function registerProjectView(context: vscode.ExtensionContext, deps: ProjectViewDeps): void {
  let summary = summariseProject(deps.currentProject());

  const view = registerTreeView(PROJECT_VIEW_ID, () => buildProjectTree(summary));
  context.subscriptions.push(view.disposable);

  const reload = (): void => {
    summary = summariseProject(deps.currentProject());
    view.provider.refresh();
  };

  const watcher = vscode.workspace.createFileSystemWatcher(MCPP_MANIFEST_GLOB);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(reload),
    watcher.onDidChange(reload),
    watcher.onDidDelete(reload),
    vscode.window.onDidChangeActiveTextEditor(reload),
    vscode.workspace.onDidChangeWorkspaceFolders(reload),
    vscode.workspace.onDidGrantWorkspaceTrust(reload),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mcpp.internal.refreshProjectView", async () => {
      reload();
    }),
  );

  reload();
}
