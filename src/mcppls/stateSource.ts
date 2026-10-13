/**
 * The `vscode`-facing half of the C++ Modules state read.
 *
 * `state.ts` normalises what it is given; this file fetches it. It is the only
 * place that touches `extension.exports`, and it is deliberately defensive: the
 * object is mcppls's test API, not a contract, so every failure becomes
 * `available: false` with a reason and never an exception.
 *
 * `mcpp.languageService.readState` can switch the whole read off. When it is off
 * the gate below returns before `extension.exports` is touched at all — not a
 * partial read, no read — and the view falls back to the degraded content it
 * always has for an installed-but-unreadable mcppls.
 */

import * as vscode from "vscode";

import { read } from "../config/access";
import { MCPPLS_EXTENSION_ID } from "./contract";
import { localOtherCppFeatures, otherCppFeaturesFromExports, type OtherCppFeatures } from "./otherCppFeatures";
import { readStateFromExports, type McpplsStateView } from "./state";

/** Why a state read did not happen. The view prints it verbatim. */
export function stateUnavailableReason(reason: "disabled" | "missing"): string {
  return reason === "disabled"
    ? "reading the C++ Modules state is turned off (mcpp.languageService.readState)"
    : `mcppls ${MCPPLS_EXTENSION_ID} is not installed`;
}

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

/**
 * Whether C++ Modules serves this workspace's C++ files, `build.mcpp` included:
 * installed and enabled in VS Code, and not switched off here (`mcppls.enable`).
 * Read-only, like everything else in this file.
 */
export function languageServerServes(): boolean {
  return languageServerInstalled() && languageServerEnabled();
}

export function readLanguageServerState(): McpplsStateView {
  const extension = dependency();
  const meta = {
    version: languageServerVersion(),
    active: extension?.isActive,
    enabled: languageServerEnabled(),
  };
  // The gate: nothing below this line runs when the setting is off, so
  // `extension.exports` is never read. `read()` falls back to the declared
  // default (true) when the registry has no value for the key.
  if (read<boolean>("mcpp.languageService.readState") === false) {
    return { available: false, reason: stateUnavailableReason("disabled"), ...meta };
  }
  if (extension === undefined) {
    return { available: false, reason: stateUnavailableReason("missing"), ...meta };
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

/**
 * The other C++ language services serving next to C++ Modules: mcppls's own
 * answer when it gives one (and reading its exports is allowed), else a local
 * read-only look at the same three candidates.
 */
export function readOtherCppFeatures(): OtherCppFeatures {
  const extension = dependency();
  if (extension !== undefined && extension.isActive && read<boolean>("mcpp.languageService.readState") !== false) {
    const answer = otherCppFeaturesFromExports(extension.exports);
    if (answer !== undefined) {
      return answer;
    }
  }
  return localOtherCppFeatures(
    (extensionId) => vscode.extensions.getExtension(extensionId) !== undefined,
    (section, key) => vscode.workspace.getConfiguration(section).get(key),
  );
}
