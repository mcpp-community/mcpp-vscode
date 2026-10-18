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
export function moduleEntries(root: string, manifest: string, packageName: string): Map<string, string> {
  const entries = new Map<string, string>();
  let hasTargets = false;
  let section: string[] = [], target: string | undefined, kind: string | undefined, main: string | undefined;
  const flush = (): void => {
    if (target && (!kind || kind === "bin")) { entries.set(path.resolve(root, main ?? "src/main.cpp"), target); }
    target = kind = main = undefined;
  };
  for (const node of parseMcppToml(manifest.split(/\r?\n/)).nodes) {
    if (node.type === "section") {
      flush(); section = node.segments.map(segment => segment.name);
      if (section.length === 2 && section[0] === "targets") { target = section[1]; hasTargets = true; }
    } else if (node.value?.kind === "string") {
      const key = node.keyPath.map(part => part.name).join(".");
      if (section.length === 1 && section[0] === "lib" && key === "path") { entries.set(path.resolve(root, node.value.text!), "lib"); }
      if (target && key === "kind") { kind = node.value.text; }
      if (target && key === "main") { main = node.value.text; }
    }
  }
  flush();
  if (![...entries.values()].includes("lib")) { entries.set(path.resolve(root, `src/${packageName.split(".").at(-1)}.cppm`), "lib · default"); }
  if (!hasTargets) { entries.set(path.resolve(root, "src/main.cpp"), "default"); }
  return entries;
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
  for (const [file, entry] of entries) {
    if (!owned.has(file) || [...nodes.values()].some(node => node.files?.includes(file))) { continue; }
    const id = path.relative(root, file);
    nodes.set(id, { id, label: id, lines: [`entry · ${entry}`], kind: "project", files: [file], entry: true });
    internal.add(id);
  }
  const edges = raw.imports.filter(edge => internal.has(edge.from)).map(edge => ({ from: edge.from, to: edge.to, label: "import" }));
  for (const edge of edges) { if (!nodes.has(edge.to)) { nodes.set(edge.to, { id: edge.to, label: edge.to, lines: ["unavailable"], kind: "unknown" }); } }
  const needed = new Set([...internal, ...edges.map(edge => edge.to)]);
  const retained = [...nodes.values()].filter(node => needed.has(node.id));
  // Entries without imports still deserve a visible node when mcppls supplied their file.
  const counts = new Map<string, Set<string>>();
  for (const edge of edges) { const targets = counts.get(edge.from) ?? new Set(); targets.add(edge.to); counts.set(edge.from, targets); }
  for (const node of retained) { node.lines.push(`imports ${counts.get(node.id)?.size ?? 0}`); }
  return { nodes: retained, edges, roots: graphRoots(retained, edges, retained.filter(node => node.entry).map(node => node.id)), truncated: !!raw.truncated || !!raw.snapshot?.indexing || !!raw.snapshot?.preparing };
}
