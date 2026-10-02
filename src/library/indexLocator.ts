/**
 * Where the index lives, and how it is read **cheaply**.
 *
 * The catalog is a directory of Lua descriptors:
 * `<home>/.mcpp/registry/data/<registry>/pkgs/<letter>/<file>.lua`. Three
 * registries are installed on the reference machine (`mcpplibs` with 239
 * descriptors, `xim-pkgindex`, `xim-pkgindex-local`), and `mcpp index status`
 * prints a table of them — which is deliberately **not** parsed: `--format json`
 * is an unknown option there, and a second human-output parser is exactly what
 * this project forbids. Globbing the data directory under `<home>/.mcpp/registry/data` gives the
 * same answer without parsing anything.
 *
 * Two budgets shape this file:
 *
 * - **No process per package.** The list is read from the descriptor text
 *   (`src/library/indexModel.ts`); `mcpp xpkg parse --json` runs on demand, from
 *   the detail panel, never here.
 * - **One read per index revision.** A snapshot is cached and invalidated by a
 *   cheap revision key (the `pkgs` directory's mtime, the `.mcpp-index-updated`
 *   marker and the descriptor count), so re-rendering the view after a filter
 *   change costs a few stats, not 239 file reads.
 *
 * A missing index is **not** an error: `locateIndexRoots()` returns `[]` and the
 * caller renders the message this module hands it.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { read } from "../config/access";
import {
  descriptorEntry,
  descriptorId,
  declaredDependencies,
  exampleCatalog,
  openkalFacetFor,
  parseDescriptorLua,
  parseOpenkalJson,
  platformKey,
  type CodeFile,
  type ExampleInput,
  type ExampleRef,
  type LibraryEntry,
  type OpenkalIndex,
} from "./indexModel";

/** How many descriptor files a walk will read before it says the index is wrong. */
const MAX_DESCRIPTORS = 20_000;

/** A directory that holds `pkgs/`, and the shared metadata beside it. */
export interface IndexRoot {
  /** The directory name, e.g. `mcpplibs`. */
  registry: string;
  /** The index root: it contains `pkgs`, and may contain `tests/` and `.xpkgindex/`. */
  path: string;
  /** `<root>/pkgs`. */
  pkgs: string;
  /** `<root>/tests/examples` exists, so the example code can be shown. */
  hasExamples: boolean;
  /** `<root>/.xpkgindex/openkal-compat.json` exists. */
  hasOpenkal: boolean;
}

/** Everything the view renders, read once per revision. */
export interface LibrarySnapshot {
  entries: LibraryEntry[];
  roots: IndexRoot[];
  revision: string;
}

/** `~` is what a user types; the file system wants the home directory. */
function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

/** One index root, or `undefined` when the directory is not one. */
async function rootAt(directory: string): Promise<IndexRoot | undefined> {
  const pkgs = path.join(directory, "pkgs");
  if (!(await isDirectory(pkgs))) {
    return undefined;
  }
  return {
    registry: path.basename(directory),
    path: directory,
    pkgs,
    hasExamples: await isDirectory(path.join(directory, "tests", "examples")),
    hasOpenkal: await isFile(path.join(directory, ".xpkgindex", "openkal-compat.json")),
  };
}

/**
 * The index roots to read.
 *
 * `mcpp.library.indexPath` wins when the user set it — it may name one index
 * root (a directory with `pkgs/`), a `pkgs` directory itself, or a whole
 * `<home>/.mcpp/registry/data` directory of registries. With no setting, the
 * default glob is the data directory under `<home>/.mcpp/registry/data`.
 *
 * `[]` means "no index found"; the caller turns that into the message rather
 * than into an error, because a machine without the index is a normal machine.
 *
 * (`locateIndexRoots` is kept as an alias: the name reads better at the call
 * site, the exported name is the one `extension.ts` uses.)
 */
export async function readIndexRoots(): Promise<IndexRoot[]> {
  const configured = read<string>("mcpp.library.indexPath");
  const candidates: string[] = [];
  if (typeof configured === "string" && configured.trim().length > 0) {
    const configured_path = path.resolve(expandHome(configured.trim()));
    // A `pkgs` directory was named directly.
    if (path.basename(configured_path) === "pkgs" && (await isDirectory(configured_path))) {
      candidates.push(path.dirname(configured_path));
    } else {
      const own = await rootAt(configured_path);
      if (own !== undefined) {
        candidates.push(own.path);
      } else {
        // A data directory: every registry inside it.
        for (const entry of await readdirSafe(configured_path)) {
          candidates.push(path.join(configured_path, entry));
        }
      }
    }
  } else {
    const data = path.join(os.homedir(), ".mcpp", "registry", "data");
    for (const entry of await readdirSafe(data)) {
      candidates.push(path.join(data, entry));
    }
  }

  const roots: IndexRoot[] = [];
  for (const candidate of candidates) {
    const root = await rootAt(candidate);
    if (root !== undefined && !roots.some((seen) => seen.path === root.path)) {
      roots.push(root);
    }
  }
  return roots.sort((a, b) => (a.registry < b.registry ? -1 : a.registry > b.registry ? 1 : 0));
}

export { readIndexRoots as locateIndexRoots };

/** A directory listing, or nothing when it cannot be read. */
async function readdirSafe(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch {
    return [];
  }
}

/** Every `*.lua` under `<root>/pkgs`, depth first, with a hard cap. */
async function descriptorFiles(pkgs: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (out.length >= MAX_DESCRIPTORS) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_DESCRIPTORS) {
        return;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".lua")) {
        out.push(full);
      }
    }
  };
  await walk(pkgs);
  return out.sort();
}

/**
 * A cheap key that changes when the index does.
 *
 * The `pkgs` directory's own mtime catches an added or removed letter
 * directory; `.mcpp-index-updated` is written whenever mcpp refreshes the index,
 * which catches a changed descriptor body. The descriptor count is included so a
 * tree that stops being updated still costs one full read when its size changes.
 */
async function revisionOf(roots: readonly IndexRoot[]): Promise<string> {
  const parts: string[] = [];
  for (const root of roots) {
    const pkgs = await statSafe(root.pkgs);
    const marker = await statSafe(path.join(root.path, ".mcpp-index-updated"));
    const letters = await readdirSafe(root.pkgs);
    parts.push(`${root.registry}:${pkgs?.mtimeMs ?? 0}:${marker?.mtimeMs ?? 0}:${letters.length}`);
  }
  return parts.join("|");
}

async function statSafe(target: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const stat = await fs.stat(target);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

/**
 * The example projects of one index root, read as manifests plus the *names* of
 * their test files. The file contents are read later, only for the package the
 * reader actually opened.
 */
async function readExamples(root: IndexRoot): Promise<ExampleInput[]> {
  if (!root.hasExamples) {
    return [];
  }
  const base = path.join(root.path, "tests", "examples");
  const out: ExampleInput[] = [];
  for (const project of await readdirSafe(base)) {
    const directory = path.join(base, project);
    const manifest = path.join(directory, "mcpp.toml");
    let text: string;
    try {
      text = await fs.readFile(manifest, "utf8");
    } catch {
      continue;
    }
    const tests = path.join(directory, "tests");
    const sources: string[] = [];
    for (const file of (await readdirSafe(tests)).sort()) {
      if (file.endsWith(".cpp") || file.endsWith(".cppm") || file.endsWith(".cc")) {
        sources.push(path.relative(root.path, path.join(tests, file)).split(path.sep).join("/"));
      }
    }
    if (sources.length > 0) {
      out.push({ project, text, sources });
    }
  }
  return out;
}

/** The openkal measurement, merged across roots; the first one wins per member. */
async function readOpenkal(roots: readonly IndexRoot[]): Promise<OpenkalIndex | undefined> {
  const members: OpenkalIndex["members"] = {};
  let measured: string | undefined;
  let found = false;
  for (const root of roots) {
    if (!root.hasOpenkal) {
      continue;
    }
    let text: string;
    try {
      text = await fs.readFile(path.join(root.path, ".xpkgindex", "openkal-compat.json"), "utf8");
    } catch {
      continue;
    }
    const parsed = parseOpenkalJson(text);
    if (parsed === undefined) {
      continue;
    }
    found = true;
    measured = measured ?? parsed.measured;
    for (const [name, member] of Object.entries(parsed.members)) {
      if (members[name] === undefined) {
        members[name] = member;
      }
    }
  }
  return found ? { members, ...(measured === undefined ? {} : { measured }) } : undefined;
}

/** The package ids the workspace's own `mcpp.toml` declares. */
async function readAdded(projectRoot: string | undefined): Promise<Set<string>> {
  if (projectRoot === undefined) {
    return new Set();
  }
  try {
    const text = await fs.readFile(path.join(projectRoot, "mcpp.toml"), "utf8");
    return new Set(declaredDependencies(text));
  } catch {
    return new Set();
  }
}

interface Cache {
  revision: string;
  snapshot: LibrarySnapshot;
  /** Descriptor text, kept so the detail page does not re-read what the list did. */
  texts: Map<string, string>;
}

let cache: Cache | undefined;

/**
 * The list, read from disk only when the revision changed.
 *
 * `projectRoot` is the workspace folder whose `mcpp.toml` decides the "already
 * declared" state; it is part of the cache key, because switching workspaces
 * changes the answer without changing the index.
 */
export async function loadSnapshot(options: { projectRoot?: string; platform?: string } = {}): Promise<LibrarySnapshot> {
  const roots = await readIndexRoots();
  const revision = `${await revisionOf(roots)}|${options.projectRoot ?? ""}`;
  if (cache !== undefined && cache.revision === revision) {
    return cache.snapshot;
  }
  if (roots.length === 0) {
    const empty: LibrarySnapshot = { entries: [], roots, revision };
    cache = { revision, snapshot: empty, texts: new Map() };
    return empty;
  }

  const platform = options.platform ?? platformKey(process.platform);
  const added = await readAdded(options.projectRoot);
  const entries: LibraryEntry[] = [];
  const texts = new Map<string, string>();
  /** Example refs, keyed by package id, from every root that has examples. */
  const exampleRefs = new Map<string, ExampleRef>();
  for (const root of roots) {
    for (const [id, ref] of exampleCatalog(await readExamples(root))) {
      if (!exampleRefs.has(id)) {
        exampleRefs.set(id, ref);
      }
    }
  }
  const openkal = await readOpenkal(roots);

  for (const root of roots) {
    for (const file of await descriptorFiles(root.pkgs)) {
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const fileName = path.basename(file);
      const fields = parseDescriptorLua(text);
      // `descriptorEntry` decides the identity; the example and openkal lookups
      // below must use that same id, so it is computed the same way here.
      const id = descriptorId(fields, fileName).id;
      const example = exampleRefs.get(id);
      const facet = openkalFacetFor(openkal, id);
      const entry = descriptorEntry({
        fileName,
        registry: root.registry,
        file,
        text,
        platform,
        added: added.has(id),
        ...(example === undefined ? {} : { example }),
        ...(facet === undefined ? {} : { openkal: facet }),
      });
      entries.push(entry);
      texts.set(entry.id, text);
    }
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const snapshot: LibrarySnapshot = { entries, roots, revision };
  cache = { revision, snapshot, texts };
  return snapshot;
}

/** The descriptor text of one package, from the cache when possible. */
export async function readDescriptorText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The cached text for a package id, when the last snapshot read it. */
export function cachedDescriptorText(id: string): string | undefined {
  return cache?.texts.get(id);
}

/**
 * The example files behind a package: real code from
 * `tests/examples/<project>/tests`, which CI builds and runs.
 *
 * The ref's `paths` are relative to the index root, so the root is found by
 * matching the prefix. Missing files are skipped, never invented.
 */
export async function readExampleFiles(roots: readonly IndexRoot[], example: ExampleRef): Promise<CodeFile[]> {
  const files: CodeFile[] = [];
  for (const root of roots) {
    if (!root.hasExamples) {
      continue;
    }
    for (const relative of example.paths) {
      const absolute = path.join(root.path, relative);
      if (!absolute.startsWith(root.path)) {
        continue;
      }
      try {
        files.push({ path: relative, text: await fs.readFile(absolute, "utf8") });
      } catch {
        // A file that disappeared between the listing and the read.
      }
    }
    if (files.length > 0) {
      return files;
    }
  }
  return files;
}

/** Test seam: forget the cached snapshot. */
export function resetSnapshotCache(): void {
  cache = undefined;
}
