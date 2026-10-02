/**
 * The language-independent half of `src/i18n/t.ts`. Pure: no `vscode`, so the
 * resolution rules are unit-testable.
 *
 * English text is the key; a translation bundle maps it to the target language.
 * A missing entry returns the English text, which is why a forgotten translation
 * reads as English rather than as an identifier.
 */

export type LanguagePreference = "auto" | "en" | "zh-cn";
export type Bundle = Readonly<Record<string, string>>;

/** `{0}`-style substitution, the same placeholder syntax `vscode.l10n` uses. */
export function format(template: string, args: readonly unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number.parseInt(index, 10)];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Resolve one string for an explicit preference. `auto` is not handled here:
 * that path belongs to VS Code, which owns the editor's locale.
 */
export function translate(
  preference: Exclude<LanguagePreference, "auto">,
  english: string,
  args: readonly unknown[],
  bundle: Bundle,
): string {
  if (preference === "en") {
    return format(english, args);
  }
  const translated = bundle[english];
  return format(typeof translated === "string" && translated.length > 0 ? translated : english, args);
}

/** `"zh-cn"` for any Chinese locale VS Code may report; `undefined` otherwise. */
export function localeFromEditorLanguage(language: string | undefined): "en" | "zh-cn" | undefined {
  if (language === undefined) {
    return undefined;
  }
  return language.toLowerCase().startsWith("zh") ? "zh-cn" : "en";
}

/** Missing entries for a set of used strings, for `tools/l10n-check.mjs`. */
export function missingTranslations(used: Iterable<string>, bundle: Bundle): string[] {
  const missing: string[] = [];
  for (const key of used) {
    if (typeof bundle[key] !== "string" || bundle[key].length === 0) {
      missing.push(key);
    }
  }
  return missing;
}
