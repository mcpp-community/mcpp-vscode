/**
 * Renamed settings: the old name keeps working, and the user is offered the
 * move once.
 *
 * This mirrors what the C++ Modules extension does for its own renames: read
 * the alias, write nothing until the user agrees, and never remove the old
 * value on their behalf.
 */

import * as vscode from "vscode";

import { effective, write } from "./access";
import { renamedKeys, subKey, SECTION } from "./registry";

export interface RenamedSetting {
  from: string;
  to: string;
  value: unknown;
}

/** Renames whose old name still holds a value the new name does not. */
export function pendingRenames(resource?: vscode.Uri): RenamedSetting[] {
  const pending: RenamedSetting[] = [];
  const configuration = vscode.workspace.getConfiguration(SECTION, resource ?? null);
  for (const { from, to } of renamedKeys()) {
    const oldValue = configuration.get(subKey(from));
    if (oldValue === undefined) {
      continue;
    }
    const current = effective(to, resource);
    if (current.source !== "default") {
      continue;
    }
    pending.push({ from, to, value: oldValue });
  }
  return pending;
}

/**
 * Perform the move for every pending rename. The old key is left in place —
 * removing a user's setting is their decision, and a stale alias is harmless
 * because nothing reads it.
 */
export async function applyRenames(
  pending: readonly RenamedSetting[],
  target: "user" | "workspace",
  resource?: vscode.Uri,
): Promise<number> {
  let moved = 0;
  for (const rename of pending) {
    try {
      await write(rename.to, rename.value, target, resource);
      moved += 1;
    } catch {
      // A rejected write (read-only settings, no folder) is not fatal: the user
      // can still set the new key themselves.
    }
  }
  return moved;
}

/** Notification text, kept here so the panel and the activation path agree. */
export function renamePrompt(pending: readonly RenamedSetting[]): string {
  const names = pending.map((rename) => `${rename.from} → ${rename.to}`).join(", ");
  return `mcpp: ${pending.length} setting(s) were renamed (${names}). Move them to the new names?`;
}
