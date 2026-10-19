import { parseMcppToml, type TomlValueNode } from "../toml/parser";
import type { ProjectSummary } from "../views/models";

function completeValue(value: TomlValueNode | undefined): boolean {
  if (!value || value.open) { return false; }
  if (value.kind === "array") { return (value.elements ?? []).every(completeValue); }
  if (value.kind === "inlineTable") { return (value.entries ?? []).every(entry => completeValue(entry.value)); }
  // The editor parser models floats, dates and non-decimal integers as unknown scalars.
  if (value.kind === "unknown") { return /^(?:[+-]?(?:inf|nan|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)|0[xob][\da-fA-F_]+|\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.test(value.text ?? ""); }
  return true;
}

/** Incomplete edits must not masquerade as a successfully empty dependency list. */
export function assertCompleteManifest(text: string): void {
  const lines = text.split(/\r?\n/), document = parseMcppToml(lines), covered = new Set<number>();
  for (const node of document.nodes) {
    if (node.type === "section" ? node.open : !completeValue(node.value)) { throw new Error("The manifest is incomplete"); }
    for (let line = node.range.startLine; line <= node.range.endLine; line++) { covered.add(line); }
  }
  for (let line = 0; line < lines.length; line++) {
    if (lines[line].trim() && !lines[line].trimStart().startsWith("#") && !covered.has(line)) { throw new Error("The manifest is incomplete"); }
  }
}
export function retainProjectDependencies(next: ProjectSummary | undefined, previous?: ProjectSummary): ProjectSummary | undefined {
  if (next?.error && previous?.root === next.root && !previous.error) {
    return { ...previous, dependencyState: "stale", dependencyError: next.error };
  }
  return next ? { ...next, dependencyState: next.error ? "error" : (next.dependencies?.length ? "ready" : "empty") } : undefined;
}
