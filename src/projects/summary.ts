/**
 * A project summary read out of `mcpp.toml`, for the project view.
 *
 * Deliberately shallow and line-oriented: the view shows an identity line and
 * the toolchain/targets, so it needs a handful of scalars, not a manifest model.
 * Anything it cannot read stays `undefined` and the view simply omits it — the
 * authoritative reader is mcpp itself, and `mcpp: Environment Self-check` shows
 * what mcpp says.
 *
 * Pure: no `vscode`, no `mcpp` execution.
 */

import type { ProjectSummary, TargetSummary } from "../views/models";

/** `[section]` or `[section.sub]`, ignoring quotes inside dotted names. */
function headerOf(line: string): string | undefined {
  const match = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
  if (match === null) {
    return undefined;
  }
  const name = match[1].replace(/^['"]|['"]$/g, "").trim();
  return name.length === 0 ? undefined : name;
}

/** `key = "value"` where the value is a plain string or a bare word. */
function scalar(body: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*(.+?)\\s*(?:#.*)?$`);
  const match = pattern.exec(body);
  if (match === null) {
    return undefined;
  }
  return unquote(match[1]);
}

function unquote(raw: string): string | undefined {
  const trimmed = raw.trim();
  const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed);
  const value = quoted === null ? trimmed : quoted[1];
  return value.length === 0 ? undefined : value;
}

/** Section names whose scalars we read, matched by prefix. */
const IDENTITY = "package";
const TOOLCHAIN = "toolchain";
const TARGETS = "targets.";

export function readProjectSummary(root: string, lines: readonly string[]): ProjectSummary {
  let section: string | undefined;
  let name: string | undefined;
  let version: string | undefined;
  let standard: string | undefined;
  let profile: string | undefined;
  let toolchainSpec: string | undefined;
  let target: string | undefined;
  const targets: TargetSummary[] = [];
  let currentTarget: { name: string; kind?: string } | undefined;

  const flushTarget = (): void => {
    if (currentTarget !== undefined) {
      targets.push({ name: currentTarget.name, kind: currentTarget.kind ?? "target" });
      currentTarget = undefined;
    }
  };

  for (const line of lines) {
    const header = headerOf(line);
    if (header !== undefined) {
      flushTarget();
      section = header;
      if (header.startsWith(TARGETS)) {
        currentTarget = { name: header.slice(TARGETS.length).replace(/^['"]|['"]$/g, "") };
      }
      continue;
    }
    if (section === IDENTITY) {
      // `[package]` only: a `[target.'cfg(..)'.package]` is a different plane.
      name ??= scalar(line, "name");
      version ??= scalar(line, "version");
      standard ??= scalar(line, "standard");
      profile ??= scalar(line, "default_profile");
    } else if (section === TOOLCHAIN) {
      toolchainSpec ??= scalar(line, "spec") ?? scalar(line, "family");
    } else if (section === "build") {
      profile ??= scalar(line, "profile");
    } else if (currentTarget !== undefined) {
      currentTarget.kind ??= scalar(line, "kind");
    }
  }
  flushTarget();

  // `[target.<triple>]` names the triple; `[targets.<name>]` names an artifact.
  for (const line of lines) {
    const match = /^\s*\[\s*target\s*\.\s*(?:'([^']+)'|"([^"]+)"|([^\]]+))\s*\]\s*$/.exec(line);
    if (match !== null) {
      target = (match[1] ?? match[2] ?? match[3] ?? "").trim() || undefined;
      break;
    }
  }

  // Keys are omitted rather than set to undefined, so a summary compares cleanly.
  const summary: ProjectSummary = { root };
  if (name !== undefined) summary.name = name;
  if (version !== undefined) summary.version = version;
  if (standard !== undefined) summary.standard = standard;
  if (profile !== undefined) summary.profile = profile;
  if (toolchainSpec !== undefined) summary.toolchainSpec = toolchainSpec;
  if (target !== undefined) summary.target = target;
  if (targets.length > 0) summary.targets = targets;
  if (lines.some((line) => headerOf(line) === "test")) summary.hasTests = true;
  return summary;
}
