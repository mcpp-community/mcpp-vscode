/**
 * The tree provider for the project view.
 *
 * The trees are described as data (`./models.ts`); this file is the only part
 * that knows about `vscode.TreeItem`. Labels carry keys, so the translation
 * happens here, at render time.
 */

import * as vscode from "vscode";

import { t } from "../i18n/t";
import type { Label, LabelArgument, TreeNode } from "./models";

/** `{ key, args }` -> a sentence in the user's language. */
export function resolveLabel(label: Label | undefined): string {
  if (label === undefined) {
    return "";
  }
  return t(label.key, ...(label.args ?? []).map(resolveArgument));
}

/**
 * An argument is usually a value, but it may be another label: `C++23 · 87
 * source file(s)` is two translatable pieces, and the join happens here rather
 * than in a builder that must stay free of the current language.
 */
function resolveArgument(argument: LabelArgument): string | number {
  return typeof argument === "object" ? resolveLabel(argument) : argument;
}

export function toTreeItem(node: TreeNode): vscode.TreeItem {
  const collapsible =
    node.children === undefined || node.children.length === 0
      ? vscode.TreeItemCollapsibleState.None
      : node.expanded === true
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;

  const item = new vscode.TreeItem(resolveLabel(node.label), collapsible);
  item.id = node.id;
  item.description = node.description === undefined ? undefined : resolveLabel(node.description);
  item.tooltip = node.tooltip === undefined ? undefined : resolveLabel(node.tooltip);
  if (node.icon !== undefined) {
    // A `ThemeColor` id is resolved by the host; an id a theme does not define
    // leaves the icon in the normal foreground colour, which is why the model
    // only ever names `charts.*`.
    item.iconPath =
      node.iconColor === undefined || node.iconColor.length === 0
        ? new vscode.ThemeIcon(node.icon)
        : new vscode.ThemeIcon(node.icon, new vscode.ThemeColor(node.iconColor));
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
 *
 * It is disposable so it can be handed straight to `createTreeView`'s
 * `context.subscriptions.push`, next to the view it feeds.
 */
export class StaticTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();

  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(private readonly roots: () => readonly TreeNode[]) {}

  public refresh(): void {
    this.changed.fire(undefined);
  }

  public dispose(): void {
    this.changed.dispose();
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

/**
 * Registers a view and hands back the provider, the view and its disposable.
 *
 * The `TreeView` is returned (rather than using `registerTreeDataProvider`)
 * because a caller may need its visibility: the project view gates the C++
 * Modules poller on whether its tree is actually on screen.
 */
export function registerTreeView(
  viewId: string,
  roots: () => readonly TreeNode[],
): { provider: StaticTreeProvider; view: vscode.TreeView<TreeNode>; disposable: vscode.Disposable } {
  const provider = new StaticTreeProvider(roots);
  const view = vscode.window.createTreeView(viewId, { treeDataProvider: provider });
  return { provider, view, disposable: view };
}
