/**
 * The one thing the status bar item can be painted with.
 *
 * `StatusBarItem.backgroundColor` looks like it takes any `ThemeColor`, and the
 * API reference says so — but the extension host enforces a whitelist, and it is
 * the *host* that also swaps the foreground so the text stays readable:
 *
 * ```js
 * // extensionHostProcess.js, ExtHostStatusBarEntry
 * static ALLOWED_BACKGROUND_COLORS = new Map([
 *   ["statusBarItem.errorBackground", new ThemeColor("statusBarItem.errorForeground")],
 *   ["statusBarItem.warningBackground", new ThemeColor("statusBarItem.warningForeground")],
 * ]);
 * set backgroundColor(t) { t && !ALLOWED_BACKGROUND_COLORS.has(t.id) && (t = void 0); … }
 * ```
 *
 * So a contributed `mcpp.statusBarBackground` would be silently dropped, and a
 * `color` set alongside one of the two allowed backgrounds would be overridden.
 * This module is the whole answer to "can the mcpp item have a background?" and
 * it is pure, so the answer is testable without an editor host.
 */

/** The value of `mcpp.ui.statusBar.background`. */
export type StatusBarBackground = "none" | "warning" | "error";

/** Every value `mcpp.ui.statusBar.background` accepts, in menu order. */
export const STATUS_BAR_BACKGROUNDS: readonly StatusBarBackground[] = ["warning", "error", "none"];

/**
 * The `ThemeColor` id for a setting value, or `undefined` for "no background".
 *
 * An unknown value is treated as `none` rather than as an error: a settings file
 * with a stale value should leave the status bar plain, not throw during
 * activation.
 */
export function statusBarBackgroundColour(value: unknown): string | undefined {
  switch (value) {
    case "warning":
      return "statusBarItem.warningBackground";
    case "error":
      return "statusBarItem.errorBackground";
    default:
      return undefined;
  }
}
