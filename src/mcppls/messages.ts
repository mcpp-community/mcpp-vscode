/**
 * Turning a structured bridge result into something a person reads.
 *
 * Split out of `./bridge.ts` so the bridge stays free of `vscode` (and testable)
 * while these strings still go through `src/i18n/t.ts`. Every English string here
 * is a key: `tools/l10n-check.mjs` fails the build if one has no Chinese entry.
 */

import { t } from "../i18n/t";
import type { LanguageServerCommandResult } from "./bridge";
import { MCPPLS_EXTENSION_ID, capability } from "./contract";

export type ResultSeverity = "info" | "warning" | "error";

export interface FormattedResult {
  severity: ResultSeverity;
  message: string;
  /** The capability's own advice, when it is gone. */
  hint?: string;
}

function titleOf(key: string): string {
  return capability(key)?.title ?? key;
}

export function formatResult(result: LanguageServerCommandResult): FormattedResult {
  const title = titleOf(result.capabilityKey);
  switch (result.state) {
    case "completed":
      return { severity: "info", message: t("{0}: done.", title) };
    case "unavailable":
      return {
        severity: "warning",
        message: t("The C++ Modules extension ({0}) is not installed or is disabled.", MCPPLS_EXTENSION_ID),
      };
    case "missing":
      return {
        severity: "warning",
        message: t("{0}: the installed C++ Modules does not offer this action.", title),
        hint: capability(result.capabilityKey)?.degradedHint,
      };
    default:
      return {
        severity: "error",
        message: t("{0} failed: {1}", title, result.error ?? t("unknown error")),
      };
  }
}

/** Confirmation text for an action that needs one, or `undefined` when it does not. */
export function confirmationFor(key: string, value?: unknown): string | undefined {
  const entry = capability(key);
  if (entry === undefined || entry.danger === "none") {
    return undefined;
  }
  const parts = [entry.confirmHint ?? entry.title];
  if (typeof value === "boolean") {
    parts.push(value ? t("Direction: enable.") : t("Direction: disable."));
  }
  return parts.join(" ");
}
