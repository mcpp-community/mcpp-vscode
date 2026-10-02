/**
 * The `mcpp.buildScript.*` switches, resolved in one place.
 *
 * `src/extension.ts` is the only assembly point and it already hands this slice
 * one thing: the diagnostic severity, read and validated from the registry. It
 * cannot grow a second argument for the feature switches, so the providers read
 * them here. Keeping the resolution **pure** — a reader in, flags out — is what
 * lets a unit test prove that flipping one registry key changes exactly one
 * contribution, and that the never-report-a-missing-module rule survives every
 * one of them being off (§3.2.1: mcpp keeps `build.mcpp` out of the build
 * database, so this extension can never validate an import).
 *
 * The keys, per `data/config-registry.json`:
 *   `mcpp.buildScript.intelligence`              completion + hover, the master switch
 *   `mcpp.buildScript.diagnostics`               static diagnostics on/off
 *   `mcpp.buildScript.diagnostics.severity`      `warning` | `info` | `off` (passed in)
 *   `mcpp.buildScript.snippets`                  snippet completions for the API
 *   `mcpp.buildScript.imports.knownModules`      the known-module list in import completion
 */
import type { Severity } from "./analysis";

/** The values the registry allows for `mcpp.buildScript.diagnostics.severity`. */
export type DiagnosticSeveritySetting = Exclude<Severity, "error">;

/**
 * The registry accessor shape (`src/config/access.ts`'s `read`, or a test stub).
 * A function with an optional `resource` argument satisfies it.
 */
export type SettingsReader = <T>(key: string) => T;

/** What the `mcpp-build` providers contribute, given the current settings. */
export interface BuildScriptContributions {
  /** Completion and hover for `mcpp::` symbols and known module names. */
  intelligence: boolean;
  /** The severity to publish diagnostics at; `undefined` means publish none. */
  diagnosticSeverity?: "warning" | "info";
  /** Snippet completions for the build-script API. */
  snippets: boolean;
  /** The known-module list in import completion. */
  knownModules: boolean;
}

/**
 * Resolve the switches. `severity()` is the callback `src/extension.ts` already
 * passes; it folds intelligence and diagnostics in, and this function folds them
 * again so each key is provably read here as well.
 *
 * `!== false` rather than a truthiness test throughout: every one of these keys
 * defaults to `true`, and a caller (or a test stub) that hands back `undefined`
 * must mean "not turned off", not "off".
 */
export function buildScriptContributions(
  read: SettingsReader,
  severity: () => DiagnosticSeveritySetting,
): BuildScriptContributions {
  const intelligence = read<boolean>("mcpp.buildScript.intelligence") !== false;
  const diagnosticsOn = intelligence && read<boolean>("mcpp.buildScript.diagnostics") !== false;
  const level = severity();
  const diagnosticSeverity =
    diagnosticsOn && (level === "warning" || level === "info") ? level : undefined;

  return {
    intelligence,
    ...(diagnosticSeverity === undefined ? {} : { diagnosticSeverity }),
    // Snippets and the known-module list live *inside* the intelligence layer:
    // their own key only ever narrows what that layer already offers.
    snippets: intelligence && read<boolean>("mcpp.buildScript.snippets") !== false,
    knownModules: intelligence && read<boolean>("mcpp.buildScript.imports.knownModules") !== false,
  };
}
