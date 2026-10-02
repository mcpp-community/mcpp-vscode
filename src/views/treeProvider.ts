/**
 * One tree provider for all three views.
 *
 * The trees are described as data (`./models.ts`); this file is the only part
 * that knows about `vscode.TreeItem`. Labels carry keys, so the translation
 * happens here, at render time.
 */

import * as vscode from "vscode";

import { t } from "../i18n/t";
import type { Label, TreeNode } from "./models";

/** `{ key, args }` -> a sentence in the user's language. */
export function resolveLabel(label: Label | undefined): string {
  if (label === undefined) {
    return "";
  }
  return t(label.key, ...(label.args ?? []));
}

export function toTreeItem(node: TreeNode): vscode.TreeItem {
  const collapsible =
    node.children === undefined
      ? vscode.TreeItemCollapsibleState.None
      : node.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed;

  const item = new vscode.TreeItem(resolveLabel(node.label), collapsible);
  item.id = node.id;
  item.description = node.description === undefined ? undefined : resolveLabel(node.description);
  item.tooltip = node.tooltip === undefined ? undefined : resolveLabel(node.tooltip);
  if (node.icon !== undefined) {
    item.iconPath = new vscode.ThemeIcon(node.icon);
  }
  item.contextValue = node.contextValue;
  if (node.command !== undefined) {
    item.command = {
      command: node.command.command,
      title: resolveLabel(node.command.title),
      arguments: [...(node.command.arguments ?? [])],
    };
  }
  return item;
}

/**
 * A provider over a snapshot the caller recomputes whenever something changes.
 * `refresh()` re-asks for the root nodes and fires the tree event.
 */
export class StaticTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();

  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(private readonly roots: () => readonly TreeNode[]) {}

  public refresh(): void {
    this.changed.fire(undefined);
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    return toTreeItem(element);
  }

  public getChildren(element?: TreeNode): TreeNode[] {
    if (element === undefined) {
      return [...this.roots()];
    }
    return [...(element.children ?? [])];
  }
}

/** Registers a view and returns nothing; the provider can be refreshed by the caller. */
export function registerTreeView(
  viewId: string,
  roots: () => readonly TreeNode[],
): { provider: StaticTreeProvider; disposable: vscode.Disposable } {
  const provider = new StaticTreeProvider(roots);
  const disposable = vscode.window.registerTreeDataProvider(viewId, provider);
  return { provider, disposable };
}
