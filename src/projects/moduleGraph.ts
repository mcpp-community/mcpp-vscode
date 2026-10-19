import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMcppToml } from "../toml/parser";
import { graphRoots, type VisualGraph, type VisualNode } from "../graphs/model";

export interface ModuleGraphJson {
  modules: Array<{ name: string; files: string[]; external: boolean }>;
  imports: Array<{ from: string; to: string }>;
  truncated?: boolean;
  snapshot?: { indexing?: boolean; preparing?: boolean };
}
/** Reject incompatible output instead of presenting an empty, apparently successful graph. */
export function parseModuleGraph(text: string): ModuleGraphJson {
  const value = JSON.parse(text) as ModuleGraphJson;
  if (!value || !Array.isArray(value.modules) || !Array.isArray(value.imports)
    || value.modules.some(node => typeof node.name !== "string" || !node.name || !Array.isArray(node.files) || node.files.some(file => typeof file !== "string") || typeof node.external !== "boolean")
    || value.imports.some(edge => typeof edge.from !== "string" || typeof edge.to !== "string")) {
    throw new Error("Unsupported mcppls module graph format");
  }
  return value;
}
export function sourcePath(root: string, file: string): string {
  return file.startsWith("file:") ? fileURLToPath(file) : path.resolve(root, file);
}
/** Read entry configuration only; C++ syntax and module resolution remain owned by mcppls. */
export interface ModuleEntries extends Map<string, string> { roles: Map<string, "main" | "library" | "test">; }
export function moduleEntries(root: string, manifest: string, packageName: string, candidates: readonly string[] = []): ModuleEntries {
  const entries = new Map<string, string>() as ModuleEntries; entries.roles = new Map();
  let explicitLib = false;
  const add = (file: string, label: string, role: "main" | "library" | "test"): void => {
    const previous = entries.get(file);
    entries.set(file, previous && previous !== label ? `${previous} / ${label}` : label); entries.roles.set(file, role);
  };
  let hasTargets = false;
  let section: string[] = [], target: string | undefined, kind: string | undefined, main: string | undefined;
  const flush = (): void => {
    if (target && (!kind || kind === "bin")) { add(path.resolve(root, main ?? "src/main.cpp"), target, "main"); }
    target = kind = main = undefined;
  };
  for (const node of parseMcppToml(manifest.split(/\r?\n/)).nodes) {
    if (node.type === "section") {
      flush(); section = node.segments.map(segment => segment.name);
      if (section.length === 2 && section[0] === "targets") { target = section[1]; hasTargets = true; }
    } else if (node.value?.kind === "string") {
      const key = node.keyPath.map(part => part.name).join(".");
      if (section.length === 1 && section[0] === "lib" && key === "path") { explicitLib = true; add(path.resolve(root, node.value.text!), "lib", "library"); }
      if (target && key === "kind") { kind = node.value.text; }
      if (target && key === "main") { main = node.value.text; }
    }
  }
  flush();
  if (!explicitLib) { add(path.resolve(root, `src/${packageName.split(".").at(-1)}.cppm`), "lib · default", "library"); }
  if (!hasTargets) { add(path.resolve(root, "src/main.cpp"), "default", "main"); }
  const patterns = testDiscovery(manifest);
  for (const file of candidates) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (isTestSource(relative, patterns)) { add(file, "test · configuration", "test"); }
  }
  return entries;
}

/** mcpp path-glob vocabulary: * stays within a segment; ** crosses segments. */
export function matchesSourceGlob(relative: string, pattern: string): boolean {
  let positions = new Uint8Array(relative.length + 1); positions[0] = 1;
  for (let i = 0; i < pattern.length; i++) {
    const next = new Uint8Array(relative.length + 1);
    if (pattern[i] === "*") {
      const across = pattern[i + 1] === "*";
      if (across) { i++; if (pattern[i + 1] === "/") { i++; } }
      let reachable = false;
      for (let at = 0; at <= relative.length; at++) {
        reachable ||= !!positions[at];
        if (reachable) { next[at] = 1; }
        if (!across && relative[at] === "/") { reachable = false; }
      }
    } else {
      for (let at = 0; at < relative.length; at++) { if (positions[at] && relative[at] === pattern[i]) { next[at + 1] = 1; } }
    }
    positions = next;
  }
  return !!positions[relative.length];
}
/** Candidate generation must be a superset of mcpp's character-based ** semantics. */
export function testCandidateGlob(pattern: string): string {
  const wildcard = pattern.search(/[*?{\[]/);
  if (wildcard < 0) { return pattern; }
  const slash = pattern.lastIndexOf("/", wildcard);
  return (slash < 0 ? "" : pattern.slice(0, slash + 1)) + "**/*";
}
export function testDiscovery(manifest: string): string[] {
  let section = "";
  for (const node of parseMcppToml(manifest.split(/\r?\n/)).nodes) {
    if (node.type === "section") { section = node.segments.map(segment => segment.name).join("."); }
    else if (section === "test" && node.keyPath.map(part => part.name).join(".") === "discover") {
      if (node.value?.kind !== "array" || node.value.open || node.value.elements?.some(value => value.kind !== "string" || !value.text)) {
        throw new Error("Invalid test discovery patterns");
      }
      return node.value.elements?.map(value => value.text!) ?? [];
    }
  }
  return ["tests/**/*.cpp"];
}
export function isTestSource(relative: string, patterns: readonly string[]): boolean {
  return !relative.startsWith("../") && patterns.some(pattern => !pattern.startsWith("!") && matchesSourceGlob(relative, pattern))
    && !patterns.some(pattern => pattern.startsWith("!") && matchesSourceGlob(relative, pattern.slice(1)));
}

/** Map already-resolved source paths to project ownership, including nested path packages. */
export async function moduleOwnership(root: string, files: readonly string[], exists: (file: string) => Promise<boolean>): Promise<Set<string>> {
  const owned = new Set<string>(), cache = new Map<string, Promise<boolean>>();
  const inside = (file: string): boolean => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  const directoryOwned = (directory: string): Promise<boolean> => {
    if (directory === root) { return Promise.resolve(true); }
    if (!inside(directory)) { return Promise.resolve(false); }
    let result = cache.get(directory);
    if (!result) {
      result = exists(path.join(directory, "mcpp.toml")).then(nested => nested ? false : directoryOwned(path.dirname(directory)));
      cache.set(directory, result);
    }
    return result;
  };
  for (const file of files) { if (await directoryOwned(path.dirname(file))) { owned.add(file); } }
  return owned;
}

/** Keep all internal relationships and just one outgoing hop into dependency modules. */
export function buildModuleGraph(root: string, raw: ModuleGraphJson, owned: ReadonlySet<string>, entries: ReadonlyMap<string, string>): VisualGraph {
  const nodes = new Map<string, VisualNode>(), internal = new Set<string>();
  for (const module of raw.modules) {
    const files = module.files.map(file => sourcePath(root, file));
    const local = !module.external && files.some(file => owned.has(file));
    const entry = files.map(file => entries.get(file)).find(Boolean);
    const declared = local ? (module.name.includes(":") ? "partition" : "export module") : "external";
    nodes.set(module.name, { id: module.name, label: module.name, kind: local ? (module.name.includes(":") ? "manifest" : "project") : "index",
      lines: [entry ? `entry · ${entry} · ${declared}` : declared, ...(files[0] ? [local ? path.relative(root, files[0]) : path.basename(files[0])] : [])], files, entry: !!entry });
    if (local) { internal.add(module.name); }
  }
  // Ordinary source files (including executable entry points) are first-class importers.
  for (const edge of raw.imports) {
    if (nodes.has(edge.from)) { continue; }
    const file = sourcePath(root, edge.from);
    if (!owned.has(file)) { continue; }
    const entry = entries.get(file);
    nodes.set(edge.from, { id: edge.from, label: path.relative(root, file), lines: [entry ? `entry · ${entry}` : "source"], kind: "project", files: [file], entry: !!entry });
    internal.add(edge.from);
  }
  const representedFiles = new Set([...nodes.values()].flatMap(node => node.files ?? []));
  for (const [file, entry] of entries) {
    if (!owned.has(file) || representedFiles.has(file)) { continue; }
    const id = path.relative(root, file);
    nodes.set(id, { id, label: id, lines: [`entry · ${entry}`], kind: "project", files: [file], entry: true });
    internal.add(id);
  }
  const edges = raw.imports.filter(edge => internal.has(edge.from)).map(edge => ({ from: edge.from, to: edge.to }));
  for (const edge of edges) { if (!nodes.has(edge.to)) { nodes.set(edge.to, { id: edge.to, label: edge.to, lines: ["unavailable"], kind: "unknown" }); } }
  const needed = new Set([...internal, ...edges.map(edge => edge.to)]);
  const retained = [...nodes.values()].filter(node => needed.has(node.id));
  // Entries without imports still deserve a visible node when mcppls supplied their file.
  const counts = new Map<string, Set<string>>();
  for (const edge of edges) { const targets = counts.get(edge.from) ?? new Set(); targets.add(edge.to); counts.set(edge.from, targets); }
  for (const node of retained) { node.lines.push(`imports ${counts.get(node.id)?.size ?? 0}`); }
  const buckets = new Map<string, string[]>([["Main", []], ["Library", []], ["Tests", []], ["Other", []]]);
  for (const node of retained) {
    const entry = node.files?.map(file => entries.get(file)).find(Boolean);
    if (entry) {
      const role = node.files?.map(file => (entries as Partial<ModuleEntries>).roles?.get(file)).find(Boolean);
      buckets.get(role === "test" || (!role && entry.startsWith("test ·")) ? "Tests" : role === "library" || (!role && (entry === "lib" || entry === "lib · default")) ? "Library" : "Main")!.push(node.id);
    }
  }
  const roots = graphRoots(retained, edges, retained.filter(node => node.entry).map(node => node.id));
  const classified = new Set([...buckets.values()].flat());
  buckets.set("Other", roots.filter(id => !classified.has(id)));
  const groups = [...buckets].filter(([, ids]) => ids.length).map(([label, ids]) => ({ id: `@group/${label.toLowerCase()}`, label, nodes: ids.sort() }));
  return { nodes: retained, edges, roots, groups, truncated: !!raw.truncated || !!raw.snapshot?.indexing || !!raw.snapshot?.preparing };
}
