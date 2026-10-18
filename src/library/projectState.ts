import type { DeclaredDependencyEntry, LockPackage } from "./indexModel";
import { parseMcppToml, type TomlValueNode, type TomlKeyValueNode } from "../toml/parser";

export type DependencyKind = "normal" | "dev" | "build";

export interface ProjectDeclaration extends DeclaredDependencyEntry {
  kind?: DependencyKind;
  source?: boolean;
  conditional?: boolean;
  path?: string;
}

/** Reuse the editor's TOML parser so quoted keys, comments and source+version tables keep their meaning. */
export function readProjectDeclarations(text: string): ProjectDeclaration[] {
  const out: ProjectDeclaration[] = [];
  const collect = (id: string, value: TomlValueNode | undefined, kind: DependencyKind, conditional: boolean): void => {
    const dev = kind === "dev";
    if (!value) { return; }
    if (value.kind === "string") { out.push({ id, version: value.text, dev, kind, conditional }); return; }
    const entries = value.entries ?? [];
    const source = entries.some((entry) => ["path", "git", "url"].includes(entry.keyPath[0]?.name));
    const version = entries.find((entry) => entry.keyPath[0]?.name === "version")?.value?.text;
    const specKeys = new Set(["version", "path", "git", "url", "branch", "rev", "tag", "features", "backend", "tools", "host-module", "reexport", "workspace"]);
    if (source || entries.some((entry) => specKeys.has(entry.keyPath[0]?.name))) {
      const localPath = entries.find((entry) => entry.keyPath[0]?.name === "path")?.value?.text;
      out.push({ id, version, dev, kind, source, conditional, ...(localPath ? { path: localPath } : {}) });
    } else if (entries.length) {
      for (const entry of entries) { collect(`${id}.${entry.keyPath.map((key) => key.name).join(".")}`, entry.value, kind, conditional); }
    } else { out.push({ id, dev, kind, conditional }); }
  };
  const groups: Array<{ section: string[]; entries: TomlKeyValueNode[] }> = [{ section: [], entries: [] }];
  for (const node of parseMcppToml(text.split(/\r?\n/)).nodes) {
    if (node.type === "section") { groups.push({ section: node.segments.map((segment) => segment.name), entries: [] }); }
    else { groups[groups.length - 1].entries.push(node); }
  }
  for (const { section, entries } of groups) {
    const index = section.findIndex((part) => part === "dependencies" || part === "dev-dependencies" || part === "build-dependencies");
    if (index < 0 || section[0] === "workspace") { continue; }
    const kind = section[index] === "dev-dependencies" ? "dev" : section[index] === "build-dependencies" ? "build" : "normal";
    if (section.length > index + 1 && entries.some((entry) => entry.keyPath.length === 1 && ["version", "path", "git", "url", "workspace"].includes(entry.keyPath[0].name))) {
      collect(section.slice(index + 1).join("."), { kind: "inlineTable", open: false, range: entries[0].range, entries }, kind, index !== 0);
    } else {
      for (const node of entries) {
        const id = [...section.slice(index + 1), ...node.keyPath.map((key) => key.name)].join(".");
        collect(id, node.value, kind, index !== 0);
      }
    }
  }
  return out;
}

export interface ProjectDependencyState {
  declared: boolean;
  declaredVersion?: string;
  resolvedVersion?: string;
  dev: boolean;
  sourceType: "registry" | "path-or-git" | "none";
  ambiguous: boolean;
}

/** Qualified coordinates win. A short name is usable only when the catalog is unambiguous. */
export function projectDependencyState(
  id: string,
  declarations: readonly ProjectDeclaration[],
  locked: readonly LockPackage[],
  catalog: readonly string[],
  kind?: DependencyKind,
): ProjectDependencyState {
  declarations = declarations.filter((entry) => kind === undefined ? entry.kind !== "build" : (entry.kind ?? (entry.dev ? "dev" : "normal")) === kind);
  const short = id.slice(id.lastIndexOf(".") + 1);
  const unique = new Set(catalog.filter((candidate) => candidate.slice(candidate.lastIndexOf(".") + 1) === short)).size === 1;
  const exact = declarations.filter((entry) => entry.id === id);
  const matches = exact.length ? exact : unique ? declarations.filter((entry) => entry.id === short) : [];
  const entry = matches[0];
  const resolved = locked.find((entry) => entry.id === id) ?? (unique ? locked.find((entry) => entry.id === short) : undefined);
  return {
    declared: entry !== undefined,
    ...(entry?.version === undefined ? {} : { declaredVersion: entry.version }),
    ...(resolved === undefined ? {} : { resolvedVersion: resolved.version }),
    dev: entry?.dev ?? false,
    sourceType: entry === undefined ? "none" : entry.source || entry.version === undefined ? "path-or-git" : "registry",
    ambiguous: matches.length > 1 || !!entry?.conditional || (!unique && exact.length === 0 && declarations.some((entry) => entry.id === short)),
  };
}

/** Every asynchronous result belongs to both an operation and a rendered page. */
export function operationMatches(
  operation: { key: string; projectRoot?: string; generation: number },
  page: { key: string; projectRoot?: string; generation: number },
): boolean {
  return operation.key === page.key && operation.projectRoot === page.projectRoot && operation.generation === page.generation;
}


/** TOML preview only. The CLI currently cannot add build dependencies or migrate groups. */
export function dependencyLocation(id: string, kind: DependencyKind): { table: string; name: string } {
  const at = id.lastIndexOf(".");
  const namespace = at < 0 ? "" : id.slice(0, at);
  const name = at < 0 ? id : id.slice(at + 1);
  const quote = (value: string) => /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
  const section = kind === "build" ? "build-dependencies" : kind === "dev" ? "dev-dependencies" : "dependencies";
  return { table: !namespace || namespace === "mcpplibs" ? section : `${section}.${quote(namespace)}`, name: quote(name) };
}
