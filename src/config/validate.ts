/**
 * Value validation for the settings registry. Pure: no `vscode`.
 *
 * Used in two places: `access.ts` when a value arrives from the editor (a
 * hand-edited `settings.json` can hold anything), and the configuration panel
 * before it writes. An invalid value never reaches the rest of the extension –
 * the declared default is used and the user is told once.
 */

import type { SettingEntry } from "./registry";

export type ValidationFailure =
  | "type"
  | "enum"
  | "minimum"
  | "maximum"
  | "items";

export interface ValidationResult {
  ok: boolean;
  /** Present when `ok`: the coerced value. */
  value?: boolean | string | number | string[];
  /** Present when `!ok`: why it was rejected. */
  reason?: ValidationFailure;
}

function typeOf(entry: SettingEntry): string {
  return entry.type === "array" ? "array of strings" : entry.type;
}

export function validateValue(entry: SettingEntry, raw: unknown): ValidationResult {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "type" };
  }
  switch (entry.type) {
    case "boolean": {
      if (typeof raw !== "boolean") {
        return { ok: false, reason: "type" };
      }
      return { ok: true, value: raw };
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false, reason: "type" };
      }
      if (entry.minimum !== undefined && raw < entry.minimum) {
        return { ok: false, reason: "minimum" };
      }
      if (entry.maximum !== undefined && raw > entry.maximum) {
        return { ok: false, reason: "maximum" };
      }
      return { ok: true, value: raw };
    }
    case "string": {
      if (typeof raw !== "string") {
        return { ok: false, reason: "type" };
      }
      if (entry.enum !== undefined && !entry.enum.includes(raw)) {
        return { ok: false, reason: "enum" };
      }
      return { ok: true, value: raw };
    }
    case "array": {
      if (!Array.isArray(raw)) {
        return { ok: false, reason: "type" };
      }
      if (raw.some((item) => typeof item !== "string")) {
        return { ok: false, reason: "items" };
      }
      return { ok: true, value: [...raw] as string[] };
    }
    default:
      return { ok: false, reason: "type" };
  }
}

/** The declared default, as a fresh value (arrays are copied). */
export function defaultValue<T>(entry: SettingEntry): T {
  return (Array.isArray(entry.default) ? [...entry.default] : entry.default) as T;
}

/** Human-readable expectation, for the "value rejected" notice. */
export function expectation(entry: SettingEntry): string {
  if (entry.enum !== undefined) {
    return entry.enum.join(" | ");
  }
  if (entry.type === "number" && (entry.minimum !== undefined || entry.maximum !== undefined)) {
    const low = entry.minimum ?? Number.NEGATIVE_INFINITY;
    const high = entry.maximum ?? Number.POSITIVE_INFINITY;
    return `${low} … ${high}`;
  }
  return typeOf(entry);
}
