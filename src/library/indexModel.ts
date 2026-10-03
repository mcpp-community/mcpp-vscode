/**
 * The library view's model: everything that can be decided without an editor.
 *
 * The index is a directory of Lua descriptors on disk
 * (`<home>/.mcpp/registry/data/<registry>/pkgs/<letter>/<file>.lua`). The list
 * phase has a hard budget: **no process per package** — 239 `mcpp` spawns would
 * freeze the sidebar — so the catalog fields (`namespace`, `name`,
 * `description`, `licenses`, `repo`, whether a `CN` mirror exists) and the
 * version numbers are read out of the Lua **text**, tolerantly, and anything
 * that does not fit a single-line shape is simply left out. Every authoritative
 * value comes from `mcpp xpkg parse --json` instead (`src/library/xpkg.ts`),
 * which runs only when a row is expanded or the detail page opens.
 *
 * The vocabulary is the index site generator's, not ours
 * (`.xpkgindex/plugins/mcpp.py`): the usage label is one of the four `SURFACES`,
 * the badges are the generator's own badges, and the openkal facets are
 * **measurements** recorded in `.xpkgindex/openkal-compat.json` — never
 * descriptor fields, so they are read from that file or not shown at all.
 *
 * This module is `vscode`-free on purpose (`test/architecture.test.ts`): the
 * escaping, the tolerant parsing, the version ordering and the example lookup are
 * all unit-testable without an editor host.
 */

import {
  SURFACE_TEXT,
  SURFACES,
  latestVersion,
  parseXpkgJson,
  platformKey,
  surfacesOf,
  textNamesBinaryTarget,
  versionGroups,
  versionsFor,
  type Surface,
  type XpkgInfo,
} from "./xpkg";

// ─────────────────────────────────────────────────────────────── vocabulary ──

/**
 * The packages that make up openkal — the site generator's `OPENKAL_FAMILY`,
 * copied verbatim (it is a list of **names**, not prose, so it is not
 * translated). `openkal-compat` needs no list: it is read from the measurement
 * file. A rename upstream is a one-line change here.
 */
export const OPENKAL_FAMILY: readonly string[] = [
  "mcpplibs.openkal",
  "mcpplibs.openkal-kit",
  "mcpplibs.openkal-linux",
  "mcpplibs.openkal-macos",
  "mcpplibs.openkal-windows",
  "mcpplibs.openkal-uefi",
  "mcpplibs.openkal-opensbi",
  "mcpplibs.openkal-emscripten",
  "mcpplibs.openkal-libc",
  "mcpplibs.openkal-musl",
  "mcpplibs.openkal-llvm-runtime",
  "mcpplibs.std-freestanding-alloc-kal",
];

/** Every badge the view may show, in the order it shows them (§12.5). */
export type BadgeKey =
  | "examples"
  | "cn"
  | "openkal-ecosystem"
  | "openkal-compat"
  | "openkal-posix"
  | "openkal-platform";

/** The `ui` key and English fallback for each badge. */
export const BADGE_UI: Readonly<Record<BadgeKey, { key: string; fallback: string }>> = {
  examples: { key: "library.badge.examples", fallback: "✓ Has examples" },
  cn: { key: "library.badge.cn", fallback: "China mirror" },
  "openkal-ecosystem": { key: "library.badge.openkalEcosystem", fallback: "openkal-ecosystem" },
  "openkal-compat": { key: "library.badge.openkalCompat", fallback: "openkal-compat" },
  "openkal-posix": { key: "library.badge.openkalPosix", fallback: "POSIX environment" },
  "openkal-platform": { key: "library.badge.openkalPlatform", fallback: "uses platform interfaces" },
};

/** The current platform, as `mcpp` names it. Re-exported so callers need one import. */
export { platformKey };

// ──────────────────────────────────────────────────────────────── Lua text ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop Lua comments without touching string literals.
 *
 * It matters: descriptors are heavily commented, and a comment that mentions
 * `kind = "bin"` or a `.cppm` path must not become a fact about the package.
 * Line comments (`-- …`), long comments (`--[[ … ]]`, `--[=[ … ]=]`) and the
 * long strings they can be confused with are all handled; `"` and `'` literals
 * are copied through with their escapes.
 */
export function stripLuaComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const quote = char;
      out += char;
      index += 1;
      while (index < text.length) {
        const inner = text[index];
        out += inner;
        index += 1;
        if (inner === "\\") {
          if (index < text.length) {
            out += text[index];
            index += 1;
          }
          continue;
        }
        if (inner === quote) {
          break;
        }
      }
      continue;
    }
    if (char === "-" && text[index + 1] === "-") {
      const long = /^\[(=*)\[/.exec(text.slice(index + 2));
      if (long !== null) {
        const close = `]${long[1]}]`;
        const end = text.indexOf(close, index + 2 + long[0].length);
        index = end === -1 ? text.length : end + close.length;
        continue;
      }
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * The body of the `{ … }` that starts at `open` (the index of the brace), or
 * `undefined` when the braces do not balance. String literals are skipped so a
 * `}` inside a URL cannot close the block early.
 */
export function bracedBody(text: string, open: number): { body: string; end: number } | undefined {
  if (text[open] !== "{") {
    return undefined;
  }
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        index += text[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { body: text.slice(open + 1, index), end: index + 1 };
      }
    }
    index += 1;
  }
  return undefined;
}

/** The `{ … }` assigned to `key`, searching the whole text. */
export function keyBlock(text: string, key: string): string | undefined {
  const pattern = new RegExp(`(?:^|[^\\w.])${key}\\s*=\\s*\\{`, "m");
  const match = pattern.exec(text);
  if (match === null) {
    return undefined;
  }
  const open = match.index + match[0].length - 1;
  return bracedBody(text, open)?.body;
}

/** One `key = value` pair at the top level of a Lua table body. */
export interface LuaEntry {
  key: string;
  /** A string literal's contents, or the raw body of a `{ … }` value. */
  value?: string;
  body?: string;
}

/**
 * The assignments at the **top level** of a table body, in source order.
 *
 * Only the top level, deliberately: `package` contains the whole `xpm` table,
 * and a `name = "x"` nested inside a manifest target is not the package name.
 * A value that is neither a one-line string nor a brace block is skipped — the
 * caller then omits the field rather than guessing at it.
 */
export function topLevelEntries(body: string): LuaEntry[] {
  const entries: LuaEntry[] = [];
  let depth = 0;
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < body.length && body[index] !== quote) {
        index += body[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (char === "{" || char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "}" || char === ")") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 0) {
      const quoted = /^\[["']([^"']*)["']\]\s*=\s*/.exec(body.slice(index));
      const bare = quoted === null ? /^([A-Za-z_]\w*)\s*=\s*/.exec(body.slice(index)) : null;
      const match = quoted ?? bare;
      if (match !== null) {
        const key = quoted === null ? bare![1] : quoted[1];
        let cursor = index + match[0].length;
        while (cursor < body.length && /\s/.test(body[cursor])) {
          cursor += 1;
        }
        if (body[cursor] === "{") {
          const block = bracedBody(body, cursor);
          if (block === undefined) {
            return entries;
          }
          entries.push({ key, body: block.body });
          index = block.end;
          continue;
        }
        if (body[cursor] === '"' || body[cursor] === "'") {
          const quote = body[cursor];
          let end = cursor + 1;
          let value = "";
          while (end < body.length && body[end] !== quote) {
            if (body[end] === "\\") {
              value += body[end + 1] ?? "";
              end += 2;
              continue;
            }
            value += body[end];
            end += 1;
          }
          // A value that spans a line break is not the single-line shape the
          // catalog fields are written in; it is omitted rather than guessed at.
          if (!value.includes("\n") && !value.includes("\r")) {
            entries.push({ key, value });
          }
          index = end + 1;
          continue;
        }
        // A number, a boolean or an expression: not a catalog field.
        const lineEnd = body.indexOf("\n", cursor);
        index = lineEnd === -1 ? body.length : lineEnd;
        continue;
      }
    }
    index += 1;
  }
  return entries;
}

/** Every `"…"` literal in a table body, in order — the shape of `licenses`. */
export function stringLiterals(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    out.push(match[1].replace(/\\(.)/g, "$1"));
  }
  return out;
}

/** The catalog fields of one descriptor, as far as its text states them. */
export interface DescriptorFields {
  namespace?: string;
  name?: string;
  description?: string;
  licenses: string[];
  repo?: string;
}

/**
 * Parse a descriptor's Lua text tolerantly. Never throws, and never invents a
 * value: a field written across lines, escaped unusually, or nested somewhere
 * unexpected is left out, and the caller falls back to the file name and says
 * the descriptor could not be read.
 */
export function parseDescriptorLua(text: string): DescriptorFields {
  const clean = stripLuaComments(text);
  const body = keyBlock(clean, "package") ?? clean;
  const entries = topLevelEntries(body);
  const fields: DescriptorFields = { licenses: [] };
  for (const entry of entries) {
    if (entry.body !== undefined) {
      if (entry.key === "licenses") {
        fields.licenses = stringLiterals(entry.body).filter((value) => value.length > 0);
      }
      continue;
    }
    if (entry.value === undefined || entry.value.length === 0) {
      continue;
    }
    if (entry.key === "namespace") {
      fields.namespace = entry.value;
    } else if (entry.key === "name") {
      fields.name = entry.value;
    } else if (entry.key === "description") {
      fields.description = entry.value;
    } else if (entry.key === "repo") {
      fields.repo = entry.value;
    }
  }
  return fields;
}

/** A `CN` mirror url — the badge the site derives from the descriptor's urls. */
export function hasCnMirror(text: string): boolean {
  const clean = stripLuaComments(text);
  // Both shapes occur: `CN = "…"` and `["CN"] = "…"`.
  return /\bCN\b\s*=/.test(clean) || /\[\s*["']CN["']\s*\]\s*=/.test(clean);
}

/** `name` and `namespace` as the file name encodes them (`ns.name.lua`, or `name.lua`). */
export function idFromFileName(fileName: string): { namespace?: string; name: string } {
  const base = fileName.replace(/\.lua$/i, "");
  // The separator is the *last* dot: `boost-ext.ut` is `boost-ext` + `ut`, and
  // the one descriptor whose own fields are unreadable
  // (`huxerui.huxerui.lua`) is `huxerui` + `huxerui`, not `huxerui` + `huxerui.huxerui`.
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return { name: base };
  }
  return { namespace: base.slice(0, dot), name: base.slice(dot + 1) };
}

/**
 * The package id, `ns.name`, with the file name as the fallback (§9.3).
 *
 * `name` may be written **fully qualified**: `huxerui.huxerui.lua` declares
 * `namespace = "huxerui"` and `name = "huxerui.huxerui"` on purpose (mcpp#278
 * INV-NAME — the split form "parses but can never be installed"), and `mcpp`
 * itself reports the two halves separately. The prefix is therefore stripped
 * again here, which is the difference between a usable id and `huxerui` three
 * times over.
 */
export function descriptorId(fields: DescriptorFields, fileName: string): { id: string; namespace?: string; name: string } {
  const fallback = idFromFileName(fileName);
  let name = fields.name !== undefined && fields.name.length > 0 ? fields.name : fallback.name;
  let namespace = fields.namespace !== undefined && fields.namespace.length > 0 ? fields.namespace : fallback.namespace;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const head = name.slice(0, dot);
    const tail = name.slice(dot + 1);
    if (namespace === undefined || namespace === head) {
      namespace = head;
    }
    name = tail;
  }
  return { id: namespace === undefined ? name : `${namespace}.${name}`, ...(namespace === undefined ? {} : { namespace }), name };
}

/**
 * The list's cheap surface guess, from the descriptor text alone.
 *
 * The authoritative answer is `surfacesOf(xpkg parse --json)`; this exists
 * because the list may not spawn a process per package. It asks the same
 * questions in the same order as the site generator's `_surfaces`: a `.cppm`
 * anywhere makes it a module, a `kind = "bin"` target makes it a tool, an
 * inline `sources`/`include_dirs` manifest makes it a header package, and a
 * descriptor with no inline manifest at all is a Form A `external`.
 *
 * `undefined` means the text does not say — the row then shows no usage label,
 * and opening the package gets the authoritative answer.
 */
export function surfaceFromDescriptorText(text: string): Surface | undefined {
  const clean = stripLuaComments(text);
  if (/\.cppm"/.test(clean)) {
    return "module";
  }
  if (textNamesBinaryTarget(clean)) {
    return "tool";
  }
  if (/\b(?:sources|include_dirs)\s*=\s*\{/.test(clean)) {
    return "header";
  }
  if (/\btargets\s*=\s*\{/.test(clean)) {
    // Targets but no sources and no headers: the text does not say how the
    // package is consumed. The parse's own answer is used when it is available.
    return undefined;
  }
  // No inline manifest at all is what a Form A descriptor looks like.
  return /\b(?:package|xpm)\s*=/.test(clean) ? "external" : undefined;
}

/**
 * Merge what the parse says with what the text says, without ever letting the
 * cheap guess override the authoritative reader.
 *
 * The **only** thing the text may add is a `tool` surface: `xpkg parse` prints
 * target names, so a `kind = "bin"` is visible in the descriptor's own inline
 * manifest but not in the command's output. Everything else comes from the parse
 * when it succeeded — which is what keeps a feature-gated `.cppm` (ftxui) from
 * being reported as a module just because the text mentions one.
 */
export function mergeSurfaces(info: XpkgInfo | undefined, text: string): Surface[] {
  const fromParse = info === undefined ? [] : surfacesOf(info);
  const out: Surface[] = [...fromParse];
  if (textNamesBinaryTarget(stripLuaComments(text)) && !out.includes("tool")) {
    out.push("tool");
  }
  return SURFACES.filter((surface) => out.includes(surface));
}

/**
 * The version numbers the descriptor's own `xpm` table lists, per platform.
 *
 * A cheap list-phase stand-in for the authoritative `versions` in
 * `mcpp xpkg parse --json`, which the detail page uses. It reads the
 * `["<version>"] =` keys of each platform block and, for the xlings-style
 * `["latest"] = { ref = "1.6.43" }` alias, the `ref` it points at — but never
 * returns `latest` itself as a version, because `mcpp add` accepts only an exact
 * version.
 */
export function versionsFromDescriptorText(text: string): Record<string, string[]> {
  const clean = stripLuaComments(text);
  const xpm = keyBlock(clean, "xpm");
  if (xpm === undefined) {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const platform of topLevelEntries(xpm)) {
    if (platform.body === undefined) {
      continue;
    }
    const found: string[] = [];
    const aliases: string[] = [];
    for (const entry of topLevelEntries(platform.body)) {
      // An entry with a `ref` is an alias (`["latest"] = { ref = "1.6.43" }`,
      // and the xlings-style named variants): `mcpp add` accepts an exact
      // version only, so the ref is the version and the alias name is dropped.
      const ref = entry.body === undefined ? null : /\bref\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(entry.body);
      if (ref !== null) {
        aliases.push(ref[1]);
        continue;
      }
      // A version entry names an archive: a numeric key, or one whose body
      // carries a `url`/`sha256`. That is what keeps structural keys — `deps`,
      // `cxxflags`, `runtime` — out of the version list, while non-semver
      // revisions (`b10069.2`, the llama.cpp checkpoint tags) stay in it.
      if (/^\d/.test(entry.key) || (entry.body !== undefined && /\b(?:url|sha256)\s*=/.test(entry.body))) {
        found.push(entry.key);
      }
    }
    const versions = [...new Set([...found, ...aliases])];
    if (versions.length > 0) {
      out[platform.key] = versions;
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────── the entries ──

/** Where one example project demonstrates a package. */
export interface ExampleRef {
  project: string;
  /** The first test file, relative to the index root; the site calls this `path`. */
  path: string;
  paths: string[];
  count: number;
}

/** One source file of an example project, already read. */
export interface CodeFile {
  path: string;
  text: string;
}

/** One index descriptor, as the view needs it. */
export interface LibraryEntry {
  id: string;
  namespace?: string;
  name: string;
  description?: string;
  licenses: string[];
  repo?: string;
  /** The registry directory name, e.g. `mcpplibs`. */
  registry: string;
  /** Absolute path of the descriptor. */
  file: string;
  /** The list's cheap guess; the detail page replaces it with the authoritative list. */
  surface?: Surface;
  surfaces: Surface[];
  hasCnMirror: boolean;
  hasExamples: boolean;
  openkal?: OpenkalFacet;
  /** The example project that demonstrates this package, when the index has one. */
  example?: ExampleRef;
  /** The greatest version this platform has, from the descriptor text. */
  version?: string;
  versions: Record<string, string[]>;
  /** Declared in the workspace's `mcpp.toml`. */
  added: boolean;
  /** Set when the descriptor text could not be read at all. */
  unreadable?: boolean;
}

export interface DescriptorInput {
  /** The descriptor's base name, used as the fallback identity. */
  fileName: string;
  registry: string;
  file: string;
  text: string;
  platform?: string;
  example?: ExampleRef;
  openkal?: OpenkalFacet;
  added?: boolean;
}

/**
 * Assemble one entry from its text. The only place a descriptor becomes a row:
 * the identity falls back to the file name, the surface to the cheap text
 * guess, and every optional field is omitted rather than filled with a guess.
 */
export function descriptorEntry(input: DescriptorInput): LibraryEntry {
  const fields = parseDescriptorLua(input.text);
  const identity = descriptorId(fields, input.fileName);
  const versions = versionsFromDescriptorText(input.text);
  const surface = surfaceFromDescriptorText(input.text);
  const entry: LibraryEntry = {
    id: identity.id,
    ...(identity.namespace === undefined ? {} : { namespace: identity.namespace }),
    name: identity.name,
    ...(fields.description === undefined ? {} : { description: fields.description }),
    licenses: [...fields.licenses],
    ...(fields.repo === undefined ? {} : { repo: fields.repo }),
    registry: input.registry,
    file: input.file,
    ...(surface === undefined ? {} : { surface }),
    surfaces: surface === undefined ? [] : [surface],
    hasCnMirror: hasCnMirror(input.text),
    hasExamples: input.example !== undefined,
    version: latestVersion(versions, input.platform),
    versions,
    added: input.added === true,
  };
  if (input.example !== undefined) {
    entry.example = input.example;
  }
  const openkal = input.openkal;
  if (openkal !== undefined && (openkal.level !== undefined || openkal.kind !== undefined)) {
    entry.openkal = openkal;
  }
  if (fields.namespace === undefined && fields.name === undefined) {
    // Nothing at all was readable: the row still exists, from its file name,
    // and the UI says the descriptor could not be read.
    entry.unreadable = true;
  }
  return entry;
}

/** Replace the cheap text guess with the authoritative parse's answer. */
export function withAuthoritative(
  entry: LibraryEntry,
  info: XpkgInfo | undefined,
  text: string,
  platform: string | undefined,
): LibraryEntry {
  if (info === undefined) {
    return entry;
  }
  const surfaces = mergeSurfaces(info, text);
  const next: LibraryEntry = {
    ...entry,
    surfaces,
    versions: info.versions,
    version: latestVersion(info.versions, platform),
  };
  if (surfaces[0] === undefined) {
    delete next.surface;
  } else {
    next.surface = surfaces[0];
  }
  return next;
}

// ─────────────────────────────────────────────────────────────── examples ──

/**
 * The dependency ids a manifest declares, at any nesting depth.
 *
 * Mirrors the site generator's `_collect_dependencies`: a bare
 * `tinyhttps = "…"` resolves in the index's default namespace, so it names both
 * `tinyhttps` and `mcpplibs.tinyhttps`; `[dependencies.compat]` with
 * `argparse = "3.2"` names `compat.argparse`; `[target.'cfg(linux)'.dependencies…]`
 * is found too, because a dependency a platform gate hides is still the package
 * that example demonstrates.
 *
 * The same reader serves two callers: the example index (one `mcpp.toml` per
 * project under `tests/examples`) and the workspace's own `mcpp.toml`, which is
 * how the "already declared" filter knows what is added.
 */
export function declaredDependencies(tomlText: string): string[] {
  const out = new Set<string>();
  const bare = new Set<string>();
  const header = /^\s*\[([^\]]+)\]\s*$/;
  let prefix = "";
  let collecting = false;
  const lines = tomlText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/#.*$/, "").trim();
    const section = header.exec(line);
    if (section !== null) {
      const path = section[1]
        .split(".")
        .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
        .filter((part) => part.length > 0);
      const at = path.findIndex((part) => part === "dependencies" || part === "dev-dependencies");
      collecting = at !== -1;
      prefix = at !== -1 && path.length > at + 1 ? path[at + 1] : "";
      continue;
    }
    if (!collecting) {
      continue;
    }
    // A dependency table can be written inline (`compat = { argparse = "3.2" }`)
    // or across several lines; both are accumulated before the keys are read.
    let statement = line;
    while (bracesOpen(statement) > 0 && index + 1 < lines.length) {
      index += 1;
      statement += ` ${lines[index].replace(/#.*$/, "").trim()}`;
    }
    if (statement.length === 0) {
      continue;
    }
    const assignment = /^([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(statement);
    if (assignment === null) {
      continue;
    }
    const key = assignment[1];
    const value = assignment[2].trim();
    if (value.startsWith("{")) {
      // A namespace table: every key inside names a package in it.
      for (const inner of value.matchAll(/([A-Za-z0-9_.\-]+)\s*=/g)) {
        addDependency(out, bare, prefix.length > 0 ? `${prefix}.${key}.${inner[1]}` : `${key}.${inner[1]}`, false);
      }
      continue;
    }
    if (!/^[A-Za-z_][\w\-]*$/.test(key)) {
      // `ns.name = "1.0"`: already a fully-qualified id.
      addDependency(out, bare, key, false);
      continue;
    }
    // Under `[dependencies.compat]` the key is a bare name in that namespace.
    addDependency(out, bare, prefix.length > 0 ? `${prefix}.${key}` : key, prefix.length === 0);
  }
  for (const name of bare) {
    out.add(name);
    out.add(`mcpplibs.${name}`);
  }
  // Sorted: the answer is a set, and a stable order keeps callers and tests honest.
  return [...out].sort();
}

/** One dependency name, plus the unqualified form when it may resolve by default. */
function addDependency(out: Set<string>, bare: Set<string>, id: string, unqualified: boolean): void {
  if (unqualified) {
    bare.add(id);
  }
  out.add(id);
}

/** How many `{` are still open on one (possibly concatenated) TOML line. */
function bracesOpen(text: string): number {
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        index += text[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
    index += 1;
  }
  return depth;
}

// ─────────────────────────────────────────────── what the project already has ──

/** One dependency a workspace manifest declares, with the constraint it names. */
export interface DeclaredDependencyEntry {
  id: string;
  /**
   * The constraint text (`3.2`, `^1.0`) when the value is a plain string.
   * A table value — `{ path = "…" }`, a git source — names no version, and the
   * project's lock file is the next place to look.
   */
  version?: string;
  /** Declared under `[dev-dependencies]` (or a feature only tests pull in). */
  dev: boolean;
}

/**
 * The version-aware sibling of `declaredDependencies` (§22): the detail page
 * asks "which version does this project already ask for", which an id-only
 * list cannot answer. Same walk, same shapes — bare keys stay bare here
 * (`argparse` is not expanded to `compat.argparse`), because the matching rule
 * of the only caller (`installedFor`) compares against both forms anyway.
 */
export function declaredDependencyEntries(tomlText: string): DeclaredDependencyEntry[] {
  const out: DeclaredDependencyEntry[] = [];
  const seen = new Set<string>();
  const push = (id: string, version: string | undefined, dev: boolean): void => {
    if (id.length === 0 || seen.has(`${dev ? "d" : "r"}:${id}`)) {
      return;
    }
    seen.add(`${dev ? "d" : "r"}:${id}`);
    out.push(version === undefined ? { id, dev } : { id, version, dev });
  };
  const header = /^\s*\[([^\]]+)\]\s*$/;
  let dev = false;
  let prefix = "";
  let collecting = false;
  const lines = tomlText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/#.*$/, "").trim();
    const section = header.exec(line);
    if (section !== null) {
      const path = section[1]
        .split(".")
        .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
        .filter((part) => part.length > 0);
      const at = path.findIndex((part) => part === "dependencies" || part === "dev-dependencies");
      collecting = at !== -1;
      dev = path[at] === "dev-dependencies";
      prefix = at !== -1 && path.length > at + 1 ? path[at + 1] : "";
      continue;
    }
    if (!collecting) {
      continue;
    }
    let statement = line;
    while (bracesOpen(statement) > 0 && index + 1 < lines.length) {
      index += 1;
      statement += ` ${lines[index].replace(/#.*$/, "").trim()}`;
    }
    if (statement.length === 0) {
      continue;
    }
    const assignment = /^([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(statement);
    if (assignment === null) {
      continue;
    }
    const key = assignment[1];
    const value = assignment[2].trim();
    const version = /^"([^"]*)"$/.exec(value);
    if (version !== null) {
      push(prefix.length > 0 ? `${prefix}.${key}` : key, version[1], dev);
      continue;
    }
    if (value.startsWith("{")) {
      // Three shapes live inside braces. A namespace table
      // (`compat = { argparse = "3.2" }`) names `compat.argparse` with that
      // version. A source table (`counters = { path = "../counters" }`, git
      // tables) names `counters` with no version at all; a `version` key
      // inside one is honoured, the other source fields are not facts about
      // the package.
      const SOURCE_KEYS = new Set(["path", "git", "url", "branch", "rev", "tag"]);
      const pairs = [...value.matchAll(/([A-Za-z0-9_.\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,}]+))/g)]
        .map((match) => ({ key: match[1], value: (match[2] ?? match[3] ?? match[4] ?? "").trim() }))
        .filter((pair) => pair.key !== undefined);
      const named = pairs.filter((pair) => !SOURCE_KEYS.has(pair.key) && pair.key !== "version");
      if (named.length > 0) {
        for (const pair of named) {
          push(
            prefix.length > 0 ? `${prefix}.${key}.${pair.key}` : `${key}.${pair.key}`,
            pair.value.length > 0 ? pair.value : undefined,
            dev,
          );
        }
      } else {
        const tableVersion = pairs.find((pair) => pair.key === "version" && pair.value.length > 0)?.value;
        push(prefix.length > 0 ? `${prefix}.${key}` : key, tableVersion, dev);
      }
      continue;
    }
    push(prefix.length > 0 ? `${prefix}.${key}` : key, undefined, dev);
  }
  return out;
}

/** One package a build resolved, straight out of `mcpp.lock`. */
export interface LockPackage {
  id: string;
  version: string;
}

/**
 * `mcpp.lock` (format `version = 2`): one `[package."<name>"]` table per
 * resolved package, with `namespace` and `version` beside it — measured, not
 * assumed, against a real lock written by `mcpp 2026.9.30.2`. The file's own
 * header says the rest: dev-dependencies are excluded, and only index-resolved
 * packages appear, so a path or git dependency is never an answer here.
 */
export function lockPackageVersions(lockText: string): LockPackage[] {
  const out: LockPackage[] = [];
  const header = /^\s*\[package\."?([A-Za-z0-9_.\-]+)"?\]\s*$/;
  let namespace: string | undefined;
  let version: string | undefined;
  let name: string | undefined;
  const flush = (): void => {
    if (name !== undefined && version !== undefined) {
      // The key is the short name (`[package."openkal"]` + namespace). A
      // fully-qualified key also occurs (`[package."mcpplibs.cmdline"]`): when
      // the namespace is only the name's own head, the name already is the id.
      let id =
        namespace === undefined || namespace.length === 0 ? name : `${namespace}.${name}`;
      const dot = name.lastIndexOf(".");
      if (namespace !== undefined && dot > 0 && namespace === name.slice(0, dot)) {
        id = name;
      }
      out.push({ id, version });
    }
    namespace = undefined;
    version = undefined;
    name = undefined;
  };
  for (const raw of lockText.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) {
      continue;
    }
    const section = header.exec(line);
    if (section !== null) {
      flush();
      name = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      // Some other table: whatever half-read package there was is over.
      flush();
      continue;
    }
    if (name === undefined) {
      continue;
    }
    const assignment = /^([A-Za-z_][\w]*)\s*=\s*"([^"]*)"/.exec(line);
    if (assignment === null) {
      continue;
    }
    if (assignment[1] === "namespace") {
      namespace = assignment[2];
    } else if (assignment[1] === "version") {
      version = assignment[2];
    }
  }
  flush();
  return out;
}

/** The project's own answer about one package (§20.1, wired in §22). */
export interface InstalledDependency {
  /** The constraint the manifest asks for, or the version a build resolved. */
  version: string;
  /** Declared under `[dev-dependencies]`. */
  dev: boolean;
}

/**
 * Whether the project already depends on `id`, and on which version:
 * `mcpp.toml` first — the matching rule is §20.1's, the key equals the id or
 * is its last segment, because `mcpp add compat.argparse` writes the short
 * `argparse = "3.2"` — then `mcpp.lock`, for a dependency whose manifest value
 * named no version. `undefined` is a real answer: the project does not have it.
 */
export function installedFor(
  id: string,
  tomlText: string,
  lockText: string,
): InstalledDependency | undefined {
  const short = id.slice(id.lastIndexOf(".") + 1);
  for (const entry of declaredDependencyEntries(tomlText)) {
    if ((entry.id === id || entry.id === short) && entry.version !== undefined) {
      return { version: entry.version, dev: entry.dev };
    }
  }
  for (const locked of lockPackageVersions(lockText)) {
    if (locked.id === id || locked.id === short) {
      return { version: locked.version, dev: false };
    }
  }
  return undefined;
}

/** One example project's manifest and its test files, already read. */
export interface ExampleInput {
  project: string;
  text: string;
  /** Paths relative to the index root, in the order the caller found them. */
  sources: string[];
}

/**
 * package id → the example project that consumes it.
 *
 * The site generator's `_scan_examples` contract: `{project, path, paths[],
 * count}`, keyed by every dependency id the project's manifest names. Several
 * projects may demonstrate one package; the first (sorted) wins, which is what
 * the generator does too.
 */
export function exampleCatalog(inputs: readonly ExampleInput[]): Map<string, ExampleRef> {
  const catalog = new Map<string, ExampleRef>();
  const sorted = [...inputs].sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
  for (const input of sorted) {
    if (input.sources.length === 0) {
      continue;
    }
    const ref: ExampleRef = {
      project: input.project,
      path: input.sources[0],
      paths: [...input.sources],
      count: input.sources.length,
    };
    for (const id of declaredDependencies(input.text)) {
      if (!catalog.has(id)) {
        catalog.set(id, ref);
      }
    }
  }
  return catalog;
}

/** The `import x.y;` / `#include <foo.h>` lines, in file order. */
export interface UsageLine {
  file: string;
  /** 1-based, so it can be shown beside the code. */
  line: number;
  text: string;
}

const IMPORT_LINE = /^\s*import\s+[A-Za-z_][\w.]*\s*;/;
const INCLUDE_LINE = /^\s*#include\s*[<"][^>"]+[>"]/;

/** The interface lines the site files a package under a `SURFACE` by. */
export function usageLines(files: readonly CodeFile[]): UsageLine[] {
  const out: UsageLine[] = [];
  for (const file of files) {
    file.text.split(/\r?\n/).forEach((text, index) => {
      if (IMPORT_LINE.test(text) || INCLUDE_LINE.test(text)) {
        out.push({ file: file.path, line: index + 1, text: text.replace(/\s+$/, "") });
      }
    });
  }
  return out;
}

/** Regex metacharacters are literal in a package name, never a pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The `import` / `#include` lines a reader of **this** package writes, out of
 * an example project's real code (§22): a line counts when it names the
 * package — the dotted id or its short name as a word — so `import std;` and
 * the example's own other dependencies stay out. Deduplicated, capped at
 * four: this is a hint beside the command, not a second code section.
 */
export function usageLinesFor(files: readonly CodeFile[], id: string): string[] {
  const short = id.slice(id.lastIndexOf(".") + 1);
  const dotted = new RegExp(`\\b${escapeRegExp(id)}\\b`);
  const bare = new RegExp(`\\b${escapeRegExp(short)}\\b`);
  const out: string[] = [];
  for (const line of usageLines(files)) {
    if ((dotted.test(line.text) || bare.test(line.text)) && !out.includes(line.text)) {
      out.push(line.text);
      if (out.length >= 4) {
        break;
      }
    }
  }
  return out;
}

/**
 * The usage lines to show when no example project states the real ones (§22).
 *
 * A module package is imported by its short name — measured in a real project:
 * `openkal = "0.12.0"` in the manifest, `import openkal.types;` in the
 * sources — so `import <name>;` is the honest root form. A header package's
 * real path lives inside the upstream archive and is unknowable offline, so
 * the index site's own muted placeholder answers (`#include <foo.h>`) rather
 * than an invented path. `tool` and `external` packages are not imported at
 * all; their surface badge already says what they are.
 */
export function syntheticUsageLines(surfaces: readonly Surface[], name: string): string[] {
  if (surfaces.includes("module")) {
    return [`import ${name};`];
  }
  if (surfaces.includes("header")) {
    return [SURFACE_TEXT.header.usage];
  }
  return [];
}

/** A window of an example file around one interface line. */
export interface CodeSnippet {
  file: string;
  /** 1-based line number of the first line of `lines`. */
  startLine: number;
  lines: string[];
  /** The 1-based line the interface line is on. */
  usageLine: number;
}

export interface SnippetOptions {
  /** Lines of context before and after the interface line. */
  context?: number;
  maxSnippets?: number;
  maxLines?: number;
}

/**
 * The example code to show: one window per interface line, with overlapping
 * windows merged, capped so a package with many test files cannot push the
 * detail page's buttons off the screen. This is the *real* code from
 * `tests/examples/<project>/tests/*.cpp` — CI builds and runs it.
 */
export function codeSnippets(files: readonly CodeFile[], options: SnippetOptions = {}): CodeSnippet[] {
  const context = Math.max(0, options.context ?? 2);
  const maxSnippets = Math.max(1, options.maxSnippets ?? 3);
  const maxLines = Math.max(1, options.maxLines ?? 24);
  const snippets: CodeSnippet[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    const anchors: number[] = [];
    lines.forEach((text, index) => {
      if (IMPORT_LINE.test(text) || INCLUDE_LINE.test(text)) {
        anchors.push(index);
      }
    });
    for (const anchor of anchors) {
      const from = Math.max(0, anchor - context);
      const to = Math.min(lines.length, anchor + context + 1);
      const last = snippets[snippets.length - 1];
      if (last !== undefined && last.file === file.path && from <= last.startLine - 1 + last.lines.length) {
        // Overlaps or touches the previous window: extend it instead of
        // repeating its lines.
        const merged = lines.slice(last.startLine - 1, to);
        last.lines = merged.slice(0, maxLines);
        continue;
      }
      snippets.push({
        file: file.path,
        startLine: from + 1,
        lines: lines.slice(from, Math.min(to, from + maxLines)),
        usageLine: anchor + 1,
      });
      if (snippets.length >= maxSnippets) {
        return snippets;
      }
    }
  }
  return snippets;
}

// ─────────────────────────────────────────────────────────── highlighting ──

export type TokenKind = "plain" | "comment" | "string" | "preprocessor" | "keyword" | "punctuation";

export interface Token {
  kind: TokenKind;
  text: string;
}

/**
 * A deliberately small C++ tokenizer for the example block: enough for token
 * *colours*, not a parser. Comments, string and character literals, the
 * preprocessor directive, a short keyword list and punctuation; everything else
 * is plain text. The renderer escapes each token, so no token can become markup.
 */
const KEYWORDS = new Set([
  "import", "export", "module", "include", "define", "ifdef", "ifndef", "endif",
  "namespace", "using", "template", "typename", "class", "struct", "enum", "public",
  "private", "protected", "static", "inline", "const", "constexpr", "consteval",
  "auto", "void", "bool", "char", "int", "long", "short", "unsigned", "signed",
  "float", "double", "return", "if", "else", "for", "while", "switch", "case",
  "break", "continue", "true", "false", "nullptr", "new", "delete", "try", "catch",
  "throw", "this", "operator", "noexcept", "override", "final", "co_await",
  "co_return", "co_yield", "requires", "concept", "friend", "virtual", "explicit",
]);

const PUNCTUATION = new Set([";", "(", ")", "{", "}", "[", "]", ",", "<", ">", ":", "*", "&", "=", "#", ".", "+", "-", "/", "!", "|", "%", "^", "~", "?"]);

export function tokenizeCppLine(line: string): Token[] {
  const tokens: Token[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain.length > 0) {
      tokens.push({ kind: "plain", text: plain });
      plain = "";
    }
  };
  const push = (kind: TokenKind, text: string): void => {
    flush();
    tokens.push({ kind, text });
  };
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "/" && line[index + 1] === "/") {
      push("comment", line.slice(index));
      break;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let end = index + 1;
      while (end < line.length) {
        if (line[end] === "\\") {
          end += 2;
          continue;
        }
        if (line[end] === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      push("string", line.slice(index, Math.min(end, line.length)));
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < line.length && /[\w]/.test(line[end])) {
        end += 1;
      }
      const word = line.slice(index, end);
      if (KEYWORDS.has(word)) {
        push("keyword", word);
      } else {
        plain += word;
      }
      index = end;
      continue;
    }
    if (PUNCTUATION.has(char)) {
      push("punctuation", char);
      index += 1;
      continue;
    }
    plain += char;
    index += 1;
  }
  flush();
  return tokens;
}

// ────────────────────────────────────────────────────────────── openkal ──

export interface OpenkalTarget {
  kind?: string;
  status?: string;
}

export interface OpenkalMember {
  packages: string[];
  portable: boolean;
  targets: Record<string, OpenkalTarget>;
}

export interface OpenkalIndex {
  members: Record<string, OpenkalMember>;
  measured?: string;
}

/**
 * `.xpkgindex/openkal-compat.json`, decoded. The file is a *measurement* log
 * (`tests/openkal/compat.py` writes it), not a descriptor field, which is why
 * nothing about it is inferred from the Lua text. A missing or malformed file
 * yields `undefined`, and the view then shows no openkal badge at all.
 */
export function parseOpenkalJson(text: string): OpenkalIndex | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.members)) {
    return undefined;
  }
  const members: Record<string, OpenkalMember> = {};
  for (const [name, raw] of Object.entries(value.members)) {
    if (!isRecord(raw)) {
      continue;
    }
    const targets: Record<string, OpenkalTarget> = {};
    if (isRecord(raw.targets)) {
      for (const [target, entry] of Object.entries(raw.targets)) {
        if (!isRecord(entry)) {
          continue;
        }
        targets[target] = {
          ...(typeof entry.kind === "string" ? { kind: entry.kind } : {}),
          ...(typeof entry.status === "string" ? { status: entry.status } : {}),
        };
      }
    }
    members[name] = {
      packages: Array.isArray(raw.packages) ? raw.packages.filter((id): id is string => typeof id === "string") : [],
      portable: raw.portable !== false,
      targets,
    };
  }
  return {
    members,
    ...(typeof value.measured === "string" ? { measured: value.measured } : {}),
  };
}

const OPENKAL_RANK: Readonly<Record<string, number>> = { fails: 0, builds: 1, runs: 2 };

/** The openkal facet a package is filed under, or nothing. */
export interface OpenkalFacet {
  level?: "ecosystem" | "compat";
  kind?: "posix" | "platform";
}

/**
 * The facet for one package id, mirroring the generator's `_openkal_level` /
 * `_openkal_kind`:
 *
 * - `openkal-ecosystem` from the family list;
 * - `openkal-compat` only when some measured target **runs** (a package measured
 *   only to build, or to fail, is filed under neither — the site says so in as
 *   many words);
 * - `platform` wins over `posix`, because the package-level kind is the
 *   strictest measured target's answer, not a claim about every target.
 */
export function openkalFacetFor(index: OpenkalIndex | undefined, id: string): OpenkalFacet | undefined {
  if (index === undefined) {
    return undefined;
  }
  const facet: OpenkalFacet = {};
  if (OPENKAL_FAMILY.includes(id)) {
    facet.level = "ecosystem";
  }
  const targets: OpenkalTarget[] = [];
  let best = -1;
  for (const member of Object.values(index.members)) {
    if (!member.packages.includes(id)) {
      continue;
    }
    for (const target of Object.values(member.targets)) {
      targets.push(target);
      const rank = OPENKAL_RANK[target.status ?? ""] ?? -1;
      if (rank > best) {
        best = rank;
      }
    }
  }
  if (facet.level === undefined && best === 2) {
    facet.level = "compat";
  }
  if (targets.some((target) => target.kind === "platform")) {
    facet.kind = "platform";
  } else if (targets.some((target) => target.kind === "posix")) {
    facet.kind = "posix";
  }
  if (facet.level === undefined && facet.kind === undefined) {
    return undefined;
  }
  return facet;
}

/** The badges one entry earns, in the site's order (§12.5). */
export function badgesOf(input: {
  hasExamples?: boolean;
  hasCnMirror?: boolean;
  openkal?: OpenkalFacet;
}): BadgeKey[] {
  const out: BadgeKey[] = [];
  if (input.hasExamples === true) {
    out.push("examples");
  }
  if (input.hasCnMirror === true) {
    out.push("cn");
  }
  if (input.openkal?.level === "ecosystem") {
    out.push("openkal-ecosystem");
  } else if (input.openkal?.level === "compat") {
    out.push("openkal-compat");
  }
  if (input.openkal?.kind === "posix") {
    out.push("openkal-posix");
  } else if (input.openkal?.kind === "platform") {
    out.push("openkal-platform");
  }
  return out;
}

/** One dependency a descriptor declares for itself. */
export interface DescriptorDependency {
  id: string;
  version?: string;
}

/**
 * The dependencies a descriptor's own inline manifest names.
 *
 * Two shapes occur in this index: a table keyed by package id
 * (`deps = { ["compat.vulkan"] = "1.4.357.3" }`) and, in the xlings-style
 * descriptors, a list of `ns:name@version` strings. Only the **declared** edge is
 * read — the resolved version lives in a project's `mcpp.lock`, which is not this
 * package's file, so it is never invented here.
 */
export function descriptorDependencies(text: string): DescriptorDependency[] {
  const clean = stripLuaComments(text);
  const body = keyBlock(clean, "deps");
  if (body === undefined) {
    return [];
  }
  const out: DescriptorDependency[] = [];
  const seen = new Set<string>();
  const push = (id: string, version: string | undefined): void => {
    const key = id.trim();
    if (key.length === 0 || seen.has(key) || out.length >= 100) {
      return;
    }
    seen.add(key);
    out.push(version === undefined || version.length === 0 ? { id: key } : { id: key, version });
  };
  for (const entry of topLevelEntries(body)) {
    if (entry.value !== undefined) {
      push(entry.key, entry.value);
      continue;
    }
    const version = entry.body === undefined ? null : /\bversion\s*=\s*"([^"]*)"/.exec(entry.body);
    push(entry.key, version === null ? undefined : version[1]);
  }
  if (out.length === 0) {
    // The xlings-style list form: `deps = { "xim:gtk4@4.16.13" }`. Only entries
    // that carry the `ns:name@version` shape count; a bare string is not a
    // dependency id in this index.
    for (const literal of stringLiterals(body)) {
      const at = literal.lastIndexOf("@");
      if (at > 0 && literal.slice(0, at).includes(":")) {
        push(literal.slice(0, at), literal.slice(at + 1));
      } else if (literal.includes(":")) {
        push(literal, undefined);
      }
    }
  }
  return out;
}

// ──────────────────────────────────────────────────── cross-registry search ──

/** One hit from `mcpp search <keyword>`. */
export interface SearchHit {
  id: string;
  description?: string;
  version?: string;
}

/**
 * The one place this extension reads **human** output, and it is behind a
 * setting that is off by default (plan §10.2, risk table "第二处解析人类输出",
 * upstream request U.8 `mcpp search --format json`).
 *
 * `mcpp search argparse` prints one hit per line:
 *
 * ```text
 *   compat:argparse       argparse — header-only argument parser for modern C++  (3.2)
 * ```
 *
 * The reader is deliberately forgiving — a line that does not match is dropped,
 * and an empty result is an empty list, never an error. The caller keeps the
 * local index results either way, so a change in this format degrades to "no
 * extra hits" instead of to a broken view.
 */
export function parseSearchOutput(text: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^([A-Za-z0-9_.\-]+)[:.]([A-Za-z0-9_.\-]+)\s+(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const id = `${match[1]}.${match[2]}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const tail = match[3].trim();
    const version = /\(([^()]*)\)\s*$/.exec(tail);
    const description = (version === null ? tail : tail.slice(0, version.index)).trim();
    hits.push({
      id,
      ...(description.length === 0 ? {} : { description }),
      ...(version === null || version[1].trim().length === 0 ? {} : { version: version[1].trim() }),
    });
    if (hits.length >= 100) {
      break;
    }
  }
  return hits;
}

// ─────────────────────────────────────────────────────── mcpp self env ──

/** The shape of `mcpp self env --format json`, as far as this extension reads it. */
export interface SelfEnv {
  /** `$MCPP_HOME`, the directory everything else hangs off. */
  mcppHome?: string;
  /** `<mcppHome>/registry`, when mcpp states it. */
  registry?: string;
}

/**
 * `mcpp self env --format json`, read for the one field that matters.
 *
 * This is a **machine** shape, not human text, so it is held to the detection
 * rule `src/cli/protocol.ts` states — presence *and* type of `schemaVersion`,
 * plus the `kind` this reader owns — and anything else is refused rather than
 * guessed at. The library view falls back to its own globs when this returns
 * `undefined`, so a version of mcpp that renames a field costs a fallback and
 * never a crash.
 */
export function parseSelfEnv(text: string): SelfEnv | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.schemaVersion !== "number" || parsed.kind !== "mcpp.env") {
    return undefined;
  }
  const data = parsed.data;
  if (!isRecord(data)) {
    return undefined;
  }
  const home = data.mcppHome;
  const registry = data.registry;
  return {
    ...(typeof home === "string" && home.trim().length > 0 ? { mcppHome: home.trim() } : {}),
    ...(typeof registry === "string" && registry.trim().length > 0 ? { registry: registry.trim() } : {}),
  };
}

// ───────────────────────────────────────────────────────────────── search ──

/** The fields a search looks at — never the whole Lua text. */
export function searchText(entry: LibraryEntry): string {
  return [entry.id, entry.description ?? "", entry.licenses.join(" "), entry.repo ?? "", entry.registry].join(" ").toLowerCase();
}

export function matchesQuery(entry: LibraryEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  const haystack = searchText(entry);
  return needle.split(/\s+/).every((part) => haystack.includes(part));
}

/** The surface's label, localized by the caller and falling back to the vocabulary. */
export function surfaceLabel(surface: Surface, label: (key: string) => string): string {
  const text = SURFACE_TEXT[surface];
  if (text.uiKey === undefined) {
    return text.label;
  }
  const localized = label(text.uiKey);
  return localized === undefined || localized.length === 0 || localized === text.uiKey ? text.label : localized;
}

/**
 * Decode `mcpp xpkg parse --json` output for a caller that has the descriptor's
 * text too. Kept here so the vscode halves import one library module; the
 * parsing itself lives in `xpkg.ts`.
 */
export { parseXpkgJson, versionGroups, versionsFor, surfacesOf, SURFACE_TEXT, SURFACES };
export type { Surface, XpkgInfo };
