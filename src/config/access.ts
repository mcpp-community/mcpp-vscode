/**
 * Typed reads and writes for `mcpp.*` settings.
 *
 * Every read goes through the registry, so a value that does not match its
 * declaration (a hand-edited `settings.json`) is replaced by the declared
 * default and reported once — never silently passed on to the rest of the code.
 *
 * Writes always name a target. The configuration panel and the commands choose
 * it deliberately; nothing here writes `mcppls.*` or any other section.
 */

import * as vscode from "vscode";

import { defaultValue, expectation, validateValue } from "./validate";
import { SECTION, SETTINGS, setting, subKey, type SettingEntry } from "./registry";

export type ValueSource = "default" | "user" | "workspace" | "workspaceFolder" | "language" | "invalid";

export interface EffectiveValue<T> {
  value: T;
  source: ValueSource;
}

const warned = new Set<string>();

function configuration(resource?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION, resource ?? null);
}

/**
 * Where the effective value comes from, for the panel's "current value" column
 * and for the environment self-check.
 */
export function effective<T>(key: string, resource?: vscode.Uri): EffectiveValue<T> {
  const entry = setting(key);
  if (entry === undefined) {
    return { value: undefined as unknown as T, source: "invalid" };
  }
  const inspected = configuration(resource).inspect(entry.key.slice(SECTION.length + 1));
  const candidates: Array<[ValueSource, unknown]> = [
    ["workspaceFolder", inspected?.workspaceFolderValue],
    ["workspace", inspected?.workspaceValue],
    ["user", inspected?.globalValue],
  ];
  for (const [source, raw] of candidates) {
    if (raw === undefined) {
      continue;
    }
    const result = validateValue(entry, raw);
    if (result.ok) {
      return { value: result.value as T, source };
    }
    warnOnce(entry, source, raw);
    return { value: defaultValue<T>(entry), source: "invalid" };
  }
  return { value: defaultValue<T>(entry), source: "default" };
}

/** Shorthand for callers that only want the value. */
export function read<T>(key: string, resource?: vscode.Uri): T {
  return effective<T>(key, resource).value;
}

function warnOnce(entry: SettingEntry, source: ValueSource, raw: unknown): void {
  const signature = `${entry.key}@${source}`;
  if (warned.has(signature)) {
    return;
  }
  warned.add(signature);
  void vscode.window.showWarningMessage(
    `${entry.key}: ${JSON.stringify(raw)} is not a valid value (expected ${expectation(entry)}); using the default.`,
  );
}

/** Test seam: forget which invalid values have been reported. */
export function resetInvalidWarnings(): void {
  warned.clear();
}

export type WriteTarget = "user" | "workspace" | "workspaceFolder";

function configurationTarget(target: WriteTarget): vscode.ConfigurationTarget {
  switch (target) {
    case "workspace":
      return vscode.ConfigurationTarget.Workspace;
    case "workspaceFolder":
      return vscode.ConfigurationTarget.WorkspaceFolder;
    default:
      return vscode.ConfigurationTarget.Global;
  }
}

/**
 * Write one setting. A `resource`-scoped setting must name the folder it
 * applies to, otherwise VS Code would write it to the wrong place.
 */
export async function write(
  key: string,
  value: unknown,
  target: WriteTarget,
  resource?: vscode.Uri,
): Promise<void> {
  const entry = setting(key);
  if (entry === undefined) {
    throw new Error(`unknown mcpp setting: ${key}`);
  }
  if (entry.scope === "resource" && target !== "user" && resource === undefined) {
    throw new Error(`${key} is resource-scoped; a folder URI is required`);
  }
  await configuration(resource).update(subKey(entry.key), value, configurationTarget(target));
}

/** Every setting whose effective value differs from its declared default. */
export function changedSettings(resource?: vscode.Uri): Array<{ key: string; value: unknown; source: ValueSource }> {
  const changed: Array<{ key: string; value: unknown; source: ValueSource }> = [];
  for (const entry of SETTINGS) {
    const current = effective(entry.key, resource);
    if (current.source === "default" || current.source === "language") {
      continue;
    }
    changed.push({ key: entry.key, value: current.value, source: current.source });
  }
  return changed;
}

/** Fires for any `mcpp.*` change; the panel and the views subscribe once. */
export function onDidChange(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) {
      listener();
    }
  });
}
