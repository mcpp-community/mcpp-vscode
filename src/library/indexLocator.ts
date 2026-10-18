/** Local package discovery. Official indexes are separate from the xlings tool registry.
 * Descriptor contents are cached independently from the project's dependency state.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { runMcpp } from "../cli/process";
import { read } from "../config/access";
import { projectDependencyState, readProjectDeclarations } from "./projectState";
import {
  descriptorEntry,
  descriptorId,
  exampleCatalog,
  openkalFacetFor,
  parseDescriptorLua,
  parseOpenkalJson,
  parseSelfEnv,
  platformKey,
  type CodeFile,
  type ExampleInput,
  type ExampleRef,
  type LibraryEntry,
  type OpenkalIndex,
} from "./indexModel";

/** How many descriptor files a walk will read before it says the index is wrong. */
const MAX_DESCRIPTORS = 20_000;

/**
 * How long `mcpp self env --format json` may take. It only runs when the cheap
 * globs found nothing, and a hang there must not hold the view hostage.
 */
const SELF_ENV_TIMEOUT_MS = 15_000;

/** The index site of the official C++ library index, and its package pages. */
export const INDEX_SITE = "https://mcpplibs.github.io/mcpp-index/packages";

/** A directory that holds `pkgs/`, and the shared metadata beside it. */
export interface IndexRoot {
  /** The directory name, e.g. `mcpplibs`. */
  registry: string;
  kind: "official" | "custom";
  updatedAt?: number;
  /** The index root: it contains `pkgs`, and may contain `tests/` and `.xpkgindex/`. */
  path: string;
  /** `<root>/pkgs`. */
  pkgs: string;
  /** `<root>/tests/examples` exists, so the example code can be shown. */
  hasExamples: boolean;
  /** `<root>/.xpkgindex/openkal-compat.json` exists. */
  hasOpenkal: boolean;
  /**
   * The package page base URL of the index site, when this root is the official
   * index.
   *
   * Two shapes of the same index occur: the packed copy mcpp installs into
   * `<home>/.mcpp/registry/data/mcpplibs`, and a git checkout of `mcpp-index`
   * (whose directory is named after the repository). The generator itself —
   * `.xpkgindex/plugins/mcpp.py`, which only that repository carries — is the
   * signal that this root is that index, so a checkout gets the deep link too.
   */
  site?: string;
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
async function rootAt(directory: string, official = false): Promise<IndexRoot | undefined> {
  const pkgs = path.join(directory, "pkgs");
  if (!(await isDirectory(pkgs))) {
    return undefined;
  }
  directory = await fs.realpath(directory);
  const registry = path.basename(directory);
  const updated = await statSafe(path.join(directory, ".mcpp-index-updated"));
  const generator = await isFile(path.join(directory, ".xpkgindex", "plugins", "mcpp.py"));
  return {
    registry,
    kind: official ? "official" : "custom",
    ...(updated === undefined ? {} : { updatedAt: updated.mtimeMs }),
    path: directory,
    pkgs: path.join(directory, "pkgs"),
    hasExamples: await isDirectory(path.join(directory, "tests", "examples")),
    hasOpenkal: await isFile(path.join(directory, ".xpkgindex", "openkal-compat.json")),
    ...(official || generator ? { site: INDEX_SITE } : {}),
  };
}

/** Explicit paths never silently fall back. Only the official library source is auto-discovered. */
export async function readIndexRoots(projectRoot?: string): Promise<IndexRoot[]> {
  const configured = read<string>("mcpp.library.indexPath");
  return discoverIndexRoots(configured, configured.trim() ? path.join(os.homedir(), ".mcpp") : await activeHome(projectRoot));
}

/** Filesystem seam used by the extension and fixture-based tests. */
export async function discoverIndexRoots(configured: string, home: string): Promise<IndexRoot[]> {
  if (configured.trim()) {
    const target = path.resolve(expandHome(configured.trim()));
    const own = await rootAt(path.basename(target) === "pkgs" ? path.dirname(target) : target);
    const roots = own === undefined
      ? (await Promise.all((await readdirSafe(target)).sort().map((name) => rootAt(path.join(target, name)))))
          .filter((root): root is IndexRoot => root !== undefined)
      : [own];
    if (roots.length === 0) {
      throw new Error(`No package index (pkgs/) at ${target}`);
    }
    return roots.filter((root, index) => roots.findIndex((other) => other.path === root.path) === index);
  }
  for (const directory of [path.join(home, "indices", "mcpplibs"), path.join(home, "registry", "data", "mcpplibs")]) {
    const root = await rootAt(directory, true);
    if (root !== undefined) { return [root]; }
  }
  return [];
}

let homeProbe: { key: string; promise: Promise<string | undefined> } | undefined;

/** CLI also supports self-contained installs: ask it once rather than merge unrelated homes. */
async function activeHome(projectRoot?: string): Promise<string> {
  const explicit = process.env.MCPP_HOME?.trim();
  if (explicit) { return path.resolve(expandHome(explicit)); }
  return (await mcppHomeFromCli(projectRoot)) ?? path.join(os.homedir(), ".mcpp");
}

export function invalidateIndexCache(): void {
  cache = undefined;
  homeProbe = undefined;
}

/** Share concurrent probes, with separate answers for different configured executables/projects. */
async function mcppHomeFromCli(projectRoot?: string): Promise<string | undefined> {
  const resource = projectRoot === undefined ? undefined : vscode.Uri.file(projectRoot);
  const executable = read<string>("mcpp.path", resource).trim() || "mcpp";
  const key = `${executable}\u0000${projectRoot ?? ""}\u0000${vscode.workspace.isTrusted}`;
  if (homeProbe?.key === key) { return homeProbe.promise; }
  const promise = (async () => {
    const result = await runMcpp(vscode.workspace.isTrusted, executable, ["self", "env", "--format", "json"], projectRoot,
      { timeoutMs: SELF_ENV_TIMEOUT_MS, maxBufferMiB: 1 });
    if (result === undefined || result.exitCode !== 0) { return undefined; }
    const env = parseSelfEnv(result.stdout);
    return env?.mcppHome ?? (env?.registry === undefined ? undefined : path.dirname(env.registry));
  })();
  homeProbe = { key, promise };
  return promise;
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

/** Include source identity and every descriptor stat, including checkout edits without a marker. */
async function revisionOf(roots: readonly IndexRoot[]): Promise<string> {
  const parts: string[] = [];
  for (const root of roots) {
    const files = await descriptorFiles(root.pkgs);
    const stats = await Promise.all(files.map(async (file) => `${file}:${JSON.stringify(await statSafe(file))}`));
    parts.push(`${root.path}:${root.kind}:${root.updatedAt ?? ""}:${stats.join(";")}`);
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
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

/** Project overlay is always fresh and never changes the descriptor cache. */
async function withProject(snapshot: LibrarySnapshot, projectRoot?: string): Promise<LibrarySnapshot> {
  const text = projectRoot === undefined ? "" : await fs.readFile(path.join(projectRoot, "mcpp.toml"), "utf8").catch(() => "");
  const declarations = readProjectDeclarations(text);
  const ids = snapshot.entries.map((entry) => entry.id);
  return { ...snapshot, entries: snapshot.entries.map((entry) => ({
    ...entry, added: (["normal", "dev", "build"] as const).some((kind) => projectDependencyState(entry.id, declarations, [], ids, kind).declared),
  })) };
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
 * Only descriptor contents are cached. Project declarations are reapplied on
 * every read, so disk writes and project switches cannot reuse old badges.
 */
export async function loadSnapshot(options: { projectRoot?: string; platform?: string } = {}): Promise<LibrarySnapshot> {
  const roots = await readIndexRoots(options.projectRoot);
  const revision = `${await revisionOf(roots)}|${options.platform ?? platformKey(process.platform)}`;
  if (cache !== undefined && cache.revision === revision) {
    return withProject(cache.snapshot, options.projectRoot);
  }
  if (roots.length === 0) {
    const empty: LibrarySnapshot = { entries: [], roots, revision };
    cache = { revision, snapshot: empty, texts: new Map() };
    return empty;
  }

  const platform = options.platform ?? platformKey(process.platform);
  const entries: LibraryEntry[] = [];
  const texts = new Map<string, string>();
  /** Example refs, keyed by package id, from every root that has examples. */
  const exampleRefs = new Map<string, ExampleRef>();
  for (const root of roots) {
    for (const [id, ref] of exampleCatalog(await readExamples(root))) {
      exampleRefs.set(`${root.path}\u0000${id}`, ref);
    }
  }

  for (const root of roots) {
    const openkal = await readOpenkal([root]);
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
      const example = exampleRefs.get(`${root.path}\u0000${id}`);
      const facet = openkalFacetFor(openkal, id);
      const entry = descriptorEntry({
        fileName,
        registry: root.registry,
        file,
        text,
        platform,
        added: false,
        ...(example === undefined ? {} : { example }),
        ...(facet === undefined ? {} : { openkal: facet }),
      });
      entries.push(entry);
      texts.set(entry.file, text);
    }
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const snapshot: LibrarySnapshot = { entries, roots, revision };
  cache = { revision, snapshot, texts };
  return withProject(snapshot, options.projectRoot);
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
export function cachedDescriptorText(file: string): string | undefined {
  return cache?.texts.get(file);
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
      if (path.relative(root.path, absolute).startsWith("..") || path.isAbsolute(path.relative(root.path, absolute))) {
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
