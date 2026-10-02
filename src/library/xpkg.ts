/**
 * `mcpp xpkg parse <descriptor.lua> --json`, decoded — as a pure module.
 *
 * The index's Lua descriptors are read cheaply and tolerantly by
 * `src/library/indexModel.ts` (a few single-line catalog fields, no process).
 * Everything **authoritative** comes from here instead: `mcpp`'s own resolver
 * is the only thing that knows which platform a version belongs to, whether a
 * descriptor is Form A, and what a target's `kind` is. That command is run on
 * demand — when a row is expanded or the detail page opens — never once per
 * package (233 spawns would freeze the view).
 *
 * The document is the flat shape `mcpp` prints, verified against
 * `mcpp 2026.9.30.2` and all 239 `mcpplibs` descriptors:
 *
 * ```json
 * {"namespace":"compat","name":"argparse",
 *  "versions":{"linux":["3.2"],"macosx":["3.2"],"windows":["3.2"]},
 *  "standard":"c++23","import_std":false,
 *  "sources":["mcpp_generated/argparse_anchor.c"],
 *  "include_dirs":["&lt;archive&gt;/include"],
 *  "generated_files":[{"path":"…","bytes":52}],
 *  "generated_contents":{"mcpp_generated/argparse_anchor.c":"…"},
 *  "targets":["argparse"],"unknown_keys":[]}
 * ```
 *
 * Two facts this module is built around, both measured rather than assumed:
 *
 * - a **Form A** descriptor answers with only `namespace`, `name`, `versions`
 *   and `form: "A"` — it deliberately carries no build information, because the
 *   upstream archive ships its own manifest. That is the index's `external`
 *   surface ("上游 mcpp.toml"), and it is the only honest answer offline.
 * - `targets` is an **array of names** in every descriptor here (239/239). The
 *   site generator's `targets` *kinds* come from the upstream manifest, which
 *   `xpkg parse` does not expose. So a `kind` is honoured when the JSON happens
 *   to carry one and is not invented when it does not.
 */

/**
 * The consumer-facing usage label, exactly the index site's `SURFACES` table
 * (`.xpkgindex/plugins/mcpp.py`): what a reader does with the package, not how
 * it is built. An earlier design invented shape letters here; those were wrong.
 */
export type Surface = "module" | "header" | "tool" | "external";

/** `SURFACES` order, which is also the order the chips and badges are shown in. */
export const SURFACES: readonly Surface[] = ["module", "header", "tool", "external"];

/**
 * The label and the example line for each surface.
 *
 * `import` / `#include` / `tool` are code, not prose — the site generator emits
 * them untranslated in every language, so they are constants here. Only
 * `external` is a sentence, and it is looked up through `uiKey` so the caller
 * can localize it. `usage` is the muted placeholder the site shows when a
 * descriptor names no module or header of its own.
 */
export const SURFACE_TEXT: Readonly<
  Record<Surface, { label: string; usage: string; uiKey?: string }>
> = {
  module: { label: "import", usage: "import x.y;" },
  header: { label: "#include", usage: "#include <foo.h>" },
  tool: { label: "tool", usage: "$ tool" },
  external: { label: "upstream mcpp.toml", usage: "import x.y;", uiKey: "library.surface.external" },
};

/** One `targets[]` entry. `mcpp` prints bare names; the site's kinds are optional. */
export interface XpkgTarget {
  name?: string;
  kind?: string;
}

/** The decoded `mcpp xpkg parse --json` document. Every list is present. */
export interface XpkgInfo {
  namespace: string;
  name: string;
  /** `form: "A"` means the descriptor names no build shape of its own. */
  form?: string;
  versions: Record<string, string[]>;
  standard?: string;
  importStd?: boolean;
  sources: string[];
  includeDirs: string[];
  generatedFiles: string[];
  /** Only the paths; the contents themselves are of no use to a reader. */
  generatedContents: string[];
  targets: XpkgTarget[];
  unknownKeys: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** A `versions` object; anything else becomes an empty table. */
function versionTable(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [platform, list] of Object.entries(value)) {
    const versions = stringList(list);
    if (versions.length > 0) {
      out[platform] = versions;
    }
  }
  return out;
}

function targetList(value: unknown): XpkgTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: XpkgTarget[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) {
      out.push({ name: entry });
      continue;
    }
    if (isRecord(entry)) {
      const name = typeof entry.name === "string" ? entry.name : undefined;
      const kind = typeof entry.kind === "string" ? entry.kind : undefined;
      out.push({ ...(name === undefined ? {} : { name }), ...(kind === undefined ? {} : { kind }) });
    }
  }
  return out;
}

/**
 * Decode one already-parsed JSON value. Anything that is not the documented
 * document — a different `kind`, a resolver error envelope, a hand-edited file —
 * returns `undefined`, which the callers render as "cannot read this descriptor"
 * rather than as a package with no versions.
 */
export function parseXpkgJsonValue(value: unknown): XpkgInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = value.name;
  if (typeof name !== "string" || name.length === 0) {
    return undefined;
  }
  const namespace = typeof value.namespace === "string" ? value.namespace : "";
  const generatedContents = isRecord(value.generated_contents) ? Object.keys(value.generated_contents) : [];
  return {
    namespace,
    name,
    ...(typeof value.form === "string" && value.form.length > 0 ? { form: value.form } : {}),
    versions: versionTable(value.versions),
    ...(typeof value.standard === "string" && value.standard.length > 0 ? { standard: value.standard } : {}),
    ...(typeof value.import_std === "boolean" ? { importStd: value.import_std } : {}),
    sources: stringList(value.sources),
    includeDirs: stringList(value.include_dirs),
    generatedFiles: generatedFilePaths(value.generated_files),
    generatedContents,
    targets: targetList(value.targets),
    unknownKeys: stringList(value.unknown_keys),
  };
}

/** `generated_files` is either a list of paths or a list of `{path, bytes}`. */
function generatedFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) {
      out.push(entry);
    } else if (isRecord(entry) && typeof entry.path === "string" && entry.path.length > 0) {
      out.push(entry.path);
    }
  }
  return out;
}

/**
 * Decode the command's stdout. A non-JSON answer (an error message on stdout, a
 * partial write) returns `undefined`; the caller keeps the descriptor's own
 * fields and says the authoritative read failed.
 */
export function parseXpkgJson(text: string): XpkgInfo | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return parseXpkgJsonValue(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

/** `.cppm` anywhere in a source or a generated file makes the package modular. */
function isModular(info: XpkgInfo): boolean {
  return (
    info.generatedContents.some((path) => path.endsWith(".cppm")) ||
    info.sources.some((source) => source.includes(".cppm")) ||
    info.generatedFiles.some((path) => path.endsWith(".cppm"))
  );
}

/** A target the site files under the `tool` surface. */
function hasBinaryTarget(info: XpkgInfo): boolean {
  return info.targets.some((target) => /^(bin|binary)$/i.test(target.kind ?? ""));
}

/**
 * Every surface a descriptor's **parsed fields** support, in the order the site
 * generator emits them (`_surfaces`): a module package may also offer its
 * header, a package may ship both a library and a binary.
 *
 * A Form A descriptor answers `["external"]` and nothing else: the fields that
 * would justify a module or header claim are not in the descriptor, and the
 * index site only fills them in by fetching the upstream manifest — which this
 * extension deliberately never does.
 *
 * An empty array is a real answer, not a failure, and it happens when a
 * descriptor's fields name targets but neither a module nor a header. The site's
 * generator degrades exactly that case to `external`; saying nothing is more
 * honest than calling an inline Form B descriptor "upstream mcpp.toml". The row
 * then shows no usage label, and the detail page still shows everything known.
 * (The seven `compat.*-runtime` anchor packages are *not* that case: they carry a
 * generated `.c` source, which is the header surface the generator gives a Form B
 * package whose interfaces no module wraps.)
 */
export function surfacesOf(info: XpkgInfo): Surface[] {
  if (info.form !== undefined) {
    return ["external"];
  }
  const out: Surface[] = [];
  const modular = isModular(info);
  if (modular) {
    out.push("module");
  }
  // `include_dirs` is not by itself a public header surface: on a module package
  // it can exist only so the wrapper's own `#include` resolves. The site
  // generator therefore keeps the header surface only for a package that is not
  // modular (or that demonstrates an include line, which needs the example scan).
  if (!modular && (info.includeDirs.length > 0 || info.sources.length > 0)) {
    out.push("header");
  }
  if (hasBinaryTarget(info)) {
    out.push("tool");
  }
  return out;
}

/** The surface a row leads with, or `undefined` when nothing is claimed. */
export function surfaceOf(info: XpkgInfo): Surface | undefined {
  return surfacesOf(info)[0];
}

/** Does the descriptor's own text name a `kind = "bin"` target? */
export function textNamesBinaryTarget(text: string): boolean {
  return /\bkind\s*=\s*"(?:bin|binary)"/.test(text);
}

/**
 * The site's per-platform version groups, in a stable order: the current
 * platform first, then the rest as `mcpp` printed them. Used by the detail
 * page's version matrix, where the current platform must be the one a reader
 * finds first.
 */
export function versionGroups(
  versions: Record<string, string[]>,
  currentPlatform: string | undefined,
): Array<{ platform: string; versions: string[] }> {
  const platforms = Object.keys(versions);
  const ordered = [
    ...(currentPlatform !== undefined && platforms.includes(currentPlatform) ? [currentPlatform] : []),
    ...platforms.filter((platform) => platform !== currentPlatform),
  ];
  return ordered.map((platform) => ({ platform, versions: [...versions[platform]] }));
}

/**
 * The current platform as `mcpp` names it: `linux` / `macosx` / `windows`.
 * `undefined` for a platform the index has no vocabulary for, so the caller
 * shows the matrix rather than guessing which column is "mine".
 */
export function platformKey(nodePlatform: string): string | undefined {
  switch (nodePlatform) {
    case "linux":
      return "linux";
    case "darwin":
      return "macosx";
    case "win32":
      return "windows";
    default:
      return undefined;
  }
}

/**
 * Version order, total and deterministic.
 *
 * mcpp's versions are dotted numbers (`3.2`, `1.6.43`, `0.2.4`), sometimes with
 * a packaging revision (`22.1.8.1`), a prerelease tail (`1.0.0-rc1`) or a
 * non-semver tag the upstream project publishes (`b10069.2`, the llama.cpp
 * checkpoint revisions). The comparison follows the shape a reader expects:
 *
 * - the dotted core first, segment by segment, numerically when both segments
 *   are numbers (`1.10` is after `1.9`);
 * - build metadata (`+…`) is ignored;
 * - a prerelease (`-rc1`) sorts **below** its release, as semver says;
 * - a numeric segment outranks a non-numeric one, which is what makes the
 *   `"latest"` alias some xlings descriptors publish lose to the concrete
 *   version beside it — the only answer `mcpp add` accepts.
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  const core = compareSegments(left.core, right.core);
  if (core !== 0) {
    return core;
  }
  if (left.pre === undefined && right.pre === undefined) {
    return 0;
  }
  if (left.pre === undefined) {
    return 1;
  }
  if (right.pre === undefined) {
    return -1;
  }
  return compareSegments(left.pre, right.pre);
}

function splitVersion(version: string): { core: string[]; pre?: string[] } {
  const withoutBuild = version.split("+")[0];
  const dash = withoutBuild.indexOf("-");
  if (dash === -1) {
    return { core: withoutBuild.split(".") };
  }
  return { core: withoutBuild.slice(0, dash).split("."), pre: withoutBuild.slice(dash + 1).split(".") };
}

function compareSegments(left: readonly string[], right: readonly string[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const one = left[index];
    const two = right[index];
    if (one === undefined) {
      return two === undefined ? 0 : -1;
    }
    if (two === undefined) {
      return 1;
    }
    const oneNumber = /^\d+$/.test(one);
    const twoNumber = /^\d+$/.test(two);
    if (oneNumber && twoNumber) {
      const difference = Number(one) - Number(two);
      if (difference !== 0) {
        return difference < 0 ? -1 : 1;
      }
      continue;
    }
    if (oneNumber !== twoNumber) {
      return oneNumber ? 1 : -1;
    }
    const natural = compareNatural(one, two);
    if (natural !== 0) {
      return natural;
    }
  }
  return 0;
}

/** `rc2` before `rc10`: within an alphanumeric identifier, digit runs are numbers. */
function compareNatural(left: string, right: string): number {
  const one = left.match(/\d+|\D+/g) ?? [];
  const two = right.match(/\d+|\D+/g) ?? [];
  const length = Math.max(one.length, two.length);
  for (let index = 0; index < length; index += 1) {
    const a = one[index];
    const b = two[index];
    if (a === undefined) {
      return b === undefined ? 0 : -1;
    }
    if (b === undefined) {
      return 1;
    }
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) {
        return difference < 0 ? -1 : 1;
      }
      continue;
    }
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/** The list's versions, greatest first. */
export function sortVersions(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a));
}

/**
 * The version `mcpp add` must be given: the greatest one this platform has.
 *
 * `undefined` means the index knows no version for the current platform, and the
 * UI says so instead of running a command mcpp would reject.
 */
export function latestVersion(versions: Record<string, string[]>, platform: string | undefined): string | undefined {
  if (platform === undefined) {
    return undefined;
  }
  const list = versions[platform];
  if (list === undefined || list.length === 0) {
    return undefined;
  }
  return sortVersions(list)[0];
}

/** Every version this platform has, greatest first; `[]` when it has none. */
export function versionsFor(versions: Record<string, string[]>, platform: string | undefined): string[] {
  if (platform === undefined) {
    return [];
  }
  return sortVersions(versions[platform] ?? []);
}
