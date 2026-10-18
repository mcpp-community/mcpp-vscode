import type { DeclaredDependencyEntry, LockPackage } from "./indexModel";

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
  declarations: readonly DeclaredDependencyEntry[],
  locked: readonly LockPackage[],
  catalog: readonly string[],
): ProjectDependencyState {
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
    sourceType: entry === undefined ? "none" : entry.version === undefined ? "path-or-git" : "registry",
    ambiguous: matches.length > 1 || (!unique && exact.length === 0 && declarations.some((entry) => entry.id === short)),
  };
}

/** Every asynchronous result belongs to both an operation and a rendered page. */
export function operationMatches(
  operation: { key: string; projectRoot?: string; generation: number },
  page: { key: string; projectRoot?: string; generation: number },
): boolean {
  return operation.key === page.key && operation.projectRoot === page.projectRoot && operation.generation === page.generation;
}
