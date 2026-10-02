/**
 * Runtime strings, in one place, following the editor's language by default.
 *
 * The **English text is the key** (the same convention `vscode.l10n` uses), so a
 * missing translation degrades to readable English rather than to an identifier.
 * `data/i18n/zh-cn.json` carries the translations; `tools/generate-l10n.mjs`
 * turns it into `l10n/bundle.l10n.zh-cn.json`, which is what makes `auto` work
 * inside VS Code.
 *
 * `mcpp.ui.language` overrides the choice for **our** strings — runtime messages
 * and our webviews. It cannot change the command palette or the Settings UI:
 * VS Code resolves `package.nls.*` once at startup from its own locale. That
 * limitation is documented in `docs/settings.md` and stated in the panel.
 */

import * as vscode from "vscode";

import zhCn from "../../data/i18n/zh-cn.json";
import { format, translate, type Bundle, type LanguagePreference } from "./translate";

export type { LanguagePreference } from "./translate";

const BUNDLES: Readonly<Record<"en" | "zh-cn", Bundle>> = {
  en: {},
  "zh-cn": zhCn as Bundle,
};

let preference: LanguagePreference = "auto";

/** The effective preference, for the environment self-check and the panel. */
export function languagePreference(): LanguagePreference {
  return preference;
}

export function setLanguagePreference(value: LanguagePreference | undefined): void {
  preference = value === "en" || value === "zh-cn" ? value : "auto";
}

export type Substitution = string | number | boolean;

/**
 * Resolve one runtime string.
 *
 * - `auto` asks VS Code, which consults `l10n/bundle.l10n.<locale>.json` and
 *   falls back to the English text we passed in;
 * - a manual preference reads our own bundle, so the escape hatch works even
 *   when the editor is in a third language.
 */
export function t(english: string, ...args: readonly Substitution[]): string {
  if (preference === "auto") {
    return vscode.l10n.t(english, ...args);
  }
  return translate(preference, english, args, BUNDLES[preference]);
}

/** Substitute into an already-translated template (webviews, generated HTML). */
export { format };

/** The bundle this build ships, for `tools/l10n-check.mjs`. */
export function translationBundle(): Bundle {
  return BUNDLES["zh-cn"];
}
