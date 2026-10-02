/**
 * The C++ Modules view's settings, as decisions.
 *
 * Three settings shape that view, and each one is a policy question rather than
 * a rendering detail, so the answers live here — free of `vscode` and therefore
 * testable:
 *
 * - `mcpp.languageService.confirmResetCache` — does resetting the workspace cache
 *   ask a modal of its own, or does it rely on the capability table's `danger`?
 *   The answer may only ever *add* a confirmation;
 * - `mcpp.languageService.notifyOnDegraded` — is the one-time "the dependency is
 *   gone" notice emitted at all?
 *
 * `src/mcppls/contract.ts` stays the single source of what each capability's
 * danger is; `src/views/languageServerView.ts` stays the only place that talks to
 * `vscode.window`.
 */

export type LsConfirmation = "extra-modal" | "capability" | "none";

export interface ResetCacheConfirmInput {
  /** The capability's own `danger` level, from `contract.ts`. */
  danger: "none" | "confirm" | "destructive";
  /** `mcpp.languageService.confirmResetCache`. */
  confirmResetCache: boolean;
}

/**
 * What the reset-cache command must ask before forwarding.
 *
 * Both settings default to `true`, so the shipped behaviour is unchanged:
 * the destructive capability asks its modal, and this setting adds a second
 * explicit step. Turning the setting off falls back to the capability's own
 * level — it never removes a `destructive` modal.
 */
export function resetCacheConfirmation(input: ResetCacheConfirmInput): LsConfirmation {
  if (!input.confirmResetCache) {
    return input.danger === "none" ? "none" : "capability";
  }
  return input.danger === "none" ? "none" : "extra-modal";
}

/** `mcpp.languageService.notifyOnDegraded`: emit the one-time dependency notice? */
export function degradedNoticeEnabled(notifyOnDegraded: boolean | undefined): boolean {
  return notifyOnDegraded !== false;
}
