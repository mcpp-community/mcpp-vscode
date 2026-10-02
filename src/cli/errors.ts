/**
 * mcpp's exit-code contract (SPEC-003) turned into something a UI can branch on.
 *
 * | code | meaning                                    |
 * |------|--------------------------------------------|
 * | 0    | success                                    |
 * | 1    | ran and failed                             |
 * | 2    | usage error                                |
 * | 4    | environment not ready                      |
 * | 70   | internal error                             |
 * | 101  | build failure — **only for `mcpp run`**    |
 * | 127  | unknown command                            |
 *
 * Two documented quirks are respected by the callers of this module:
 * `mcpp build --configure-only` returns **2** for a *planning* failure, and
 * `mcpp emit build-database` returns **1** together with a usable envelope —
 * see {@link hasUsableOutput}. Nothing here parses narration for meaning; the
 * only text it understands is the `MCPP_*` diagnostic code that
 * `mcpp self explain` accepts.
 *
 * Pure string/number functions: no child process, no `vscode`.
 */

export type McppFailureKind =
  | "none"
  | "failed"
  | "usage"
  | "environment"
  | "internal"
  | "build-failed"
  | "unknown-command"
  | "cancelled";

export interface McppOutcome {
  kind: McppFailureKind;
  /** Raw exit code, or -1 when the process could not be started at all. */
  exitCode: number;
  /** The single stderr line that best explains it, when there is one. */
  detail?: string;
  /** A `MCPP_*` diagnostic code found in the output, when there is one. */
  diagnosticCode?: string;
}

const USAGE = 2;
const ENVIRONMENT = 4;
const INTERNAL = 70;
const BUILD_FAILED = 101;
const UNKNOWN_COMMAND = 127;

/** `MCPP_OFFLINE_DOWNLOAD_REQUIRED`, never a lowercase word like `mcpp_offline`. */
const DIAGNOSTIC_CODE = /\bMCPP_[A-Z][A-Z0-9_]*/;

/**
 * Map an exit code (plus the argv that produced it, which is the only way to
 * tell `mcpp run`'s build failure apart) to a failure kind.
 *
 * `undefined` means "the process never produced an exit code" — a spawn failure
 * or a cancellation — and yields `{ kind: "cancelled", exitCode: -1 }`. Signal
 * terminations reported as a negative code are treated the same way.
 *
 * Codes that are not in the contract (for example a program's own exit code
 * relayed by `mcpp run`) fall back to `"failed"`.
 */
export function classifyExit(exitCode: number | undefined, command?: readonly string[]): McppOutcome {
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode) || exitCode < 0) {
    return { kind: "cancelled", exitCode: -1 };
  }
  if (exitCode === 0) {
    return { kind: "none", exitCode };
  }
  if (exitCode === UNKNOWN_COMMAND) {
    return { kind: "unknown-command", exitCode };
  }
  if (exitCode === BUILD_FAILED) {
    // 101 is `mcpp run`'s "your program failed to build"; for anything else it
    // is an ordinary runtime failure.
    return { kind: command?.[0] === "run" ? "build-failed" : "failed", exitCode };
  }
  if (exitCode === USAGE) {
    return { kind: "usage", exitCode };
  }
  if (exitCode === ENVIRONMENT) {
    return { kind: "environment", exitCode };
  }
  if (exitCode === INTERNAL) {
    return { kind: "internal", exitCode };
  }
  return { kind: "failed", exitCode };
}

/** The first `MCPP_*` diagnostic code in `output`, when there is one. */
export function diagnosticCodeIn(output: string): string | undefined {
  if (typeof output !== "string") {
    return undefined;
  }
  return DIAGNOSTIC_CODE.exec(output)?.[0];
}

/** Minimal JSON extraction for salvage checks: the trimmed text, then its outermost `{…}` / `[…]`. */
function jsonDocumentIn(stdout: string): unknown {
  if (typeof stdout !== "string") {
    return undefined;
  }
  const text = stdout.trim();
  if (text.length === 0) {
    return undefined;
  }
  const attempts = [text];
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    attempts.push(text.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    attempts.push(text.slice(arrayStart, arrayEnd + 1));
  }
  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch {
      // Not this candidate; try the next one.
    }
  }
  return undefined;
}

/**
 * True when stdout carried something usable **even though the exit code was
 * non-zero** — the `mcpp emit build-database` partial-failure case, where the
 * envelope and its `diagnostics` are still worth reading.
 *
 * False when the command succeeded (there is nothing to salvage) and false when
 * stdout has no parseable JSON document. A bare `--json` document counts just
 * like an envelope.
 */
export function hasUsableOutput(outcome: McppOutcome, stdout: string): boolean {
  if (outcome.exitCode === 0) {
    return false;
  }
  return jsonDocumentIn(stdout) !== undefined;
}

/**
 * The follow-up command that explains a failure, e.g.
 * `mcpp self explain MCPP_OFFLINE_DOWNLOAD_REQUIRED`. `undefined` when there is
 * no diagnostic code to explain.
 */
export function explainHint(outcome: McppOutcome): string | undefined {
  const code = outcome.diagnosticCode ?? diagnosticCodeIn(outcome.detail ?? "");
  return code === undefined ? undefined : `mcpp self explain ${code}`;
}
