/**
 * The `vscode`-facing half of the C++ Modules state read.
 *
 * `state.ts` normalises what it is given; this file fetches it. It is the only
 * place that touches `extension.exports`, and it is deliberately defensive: the
 * object is mcppls's test API, not a contract, so every failure becomes
 * `available: false` with a reason and never an exception.
 */

import * as vscode from "vscode";

import { readStateFromExports, type McpplsStateView } from "./state";
import { MCPPLS_EXTENSION_ID } from "./contract";

function dependency(): vscode.Extension<unknown> | undefined {
  return vscode.extensions.getExtension(MCPPLS_EXTENSION_ID);
}

export function languageServerInstalled(): boolean {
  return dependency() !== undefined;
}

export function languageServerVersion(): string | undefined {
  const version = (dependency()?.packageJSON as { version?: string } | undefined)?.version;
  return typeof version === "string" ? version : undefined;
}

/** `mcppls.enable`, read-only: the setting belongs to the other extension. */
export function languageServerEnabled(): boolean {
  return vscode.workspace.getConfiguration("mcppls").get<boolean>("enable", true) !== false;
}

export function readLanguageServerState(): McpplsStateView {
  const extension = dependency();
  const meta = {
    version: languageServerVersion(),
    active: extension?.isActive,
    enabled: languageServerEnabled(),
  };
  if (extension === undefined) {
    return { available: false, reason: `mcppls ${MCPPLS_EXTENSION_ID} is not installed`, ...meta };
  }
  try {
    return readStateFromExports(extension.exports, meta);
  } catch (error) {
    return {
      available: false,
      reason: `reading mcppls state threw: ${error instanceof Error ? error.message : String(error)}`,
      ...meta,
    };
  }
}
