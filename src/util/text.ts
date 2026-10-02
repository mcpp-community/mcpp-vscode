/**
 * Small text helpers shared by the CLI adapter and the views. Pure: no `vscode`.
 */

/** `mcpp` colourises its status row; anything captured from a terminal may carry ANSI. */
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

export interface ClampedText {
  text: string;
  truncated: boolean;
  /** Lines dropped from the front, so a caller can say "… N earlier lines". */
  droppedLines: number;
}

export interface ClampOptions {
  maxLines?: number;
  maxChars?: number;
}

/**
 * Keep the **tail** of a long output and say so. Command output that matters
 * (a failure, a list of stale directories) is at the end; the head is status
 * narration. The full text is expected to be in the `mcpp` output channel.
 */
export function clampOutput(input: string, options: ClampOptions = {}): ClampedText {
  const maxLines = options.maxLines ?? 400;
  const maxChars = options.maxChars ?? 64 * 1024;
  const normalised = stripAnsi(input).replace(/\r\n/g, "\n");
  const lines = normalised.split("\n");
  let truncated = false;
  let droppedLines = 0;
  let kept = lines;
  if (lines.length > maxLines) {
    droppedLines = lines.length - maxLines;
    kept = lines.slice(droppedLines);
    truncated = true;
  }
  let text = kept.join("\n");
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    truncated = true;
  }
  return { text, truncated, droppedLines };
}

/** First line of a multi-line string, trimmed; used for one-line tree tooltips. */
export function firstLine(text: string): string {
  const index = text.indexOf("\n");
  return (index === -1 ? text : text.slice(0, index)).trim();
}

/** Escape a string for use as a `markdown` tooltip / webview text node. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Split a comma-separated setting value (`"mcpp,cmake"`) into trimmed entries. */
export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** `["-j","4"]` -> `"-j 4"`, quoting entries that contain whitespace. */
export function formatArguments(args: readonly string[]): string {
  return args
    .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ");
}
