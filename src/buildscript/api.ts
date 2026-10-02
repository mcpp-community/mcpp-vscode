/**
 * The mcpp build-script API snapshot: directives, roles, protocol constants and
 * provision kinds, generated from the mcpp checkout by
 * `tools/generate-buildscript-api.mjs` into `data/buildscript-api.json`.
 *
 * Why a snapshot and not the compiler: §3.2.1 of the plugin-optimisation plan
 * measured that handing `build.mcpp` to the C++ language service makes *both*
 * `import std` and `import mcpp` fail as `module not found` — mcpp deliberately
 * keeps the build program out of the compilation database. No language service
 * can describe it, so this module is the editor's substitute. It is pure data
 * and imports no `vscode`, so the analysis layer can be unit-tested and can
 * never start depending on clangd.
 *
 * `apiProblems()` is the snapshot's own invariant check: `activate()` can log one
 * line instead of failing feature by feature when the committed JSON is stale or
 * malformed.
 */
import apiJson from "../../data/buildscript-api.json";

export interface Directive {
  wire: string;
  tag: string;
  slot: string;
  scope: string;
  transform: string;
  mustExist: boolean;
  missingPrefix?: string;
  missingSuffix?: string;
  since: number;
  rules: string[];
  docsUrl?: string | null;
}

export interface BuildScriptApi {
  sourceVersion: string;
  sourceCommit: string;
  protocolVersion: number;
  cacheEpoch: number;
  roles: string[];
  provisions: Array<{ kind: string; wire: string }>;
  directives: Directive[];
}

/**
 * The five action roles the engine knows (`mcpp::roles::*`), in the order
 * `mcpp::manifest::BuildAction::Role` declares them. The generator reads the
 * same list out of `directives.cppm`; keeping the constant here is what lets a
 * snapshot whose `roles` drifted be rejected.
 */
export const ACTION_ROLES: readonly string[] = ["source", "check", "object", "artifact", "prepare"];

const api = apiJson as unknown as BuildScriptApi;

export const API: BuildScriptApi = api;

const DIRECTIVES: readonly Directive[] = api.directives;
const BY_WIRE = new Map<string, Directive>(DIRECTIVES.map((entry) => [entry.wire, entry]));

/** The directive with this wire name (`"link-search"`), or `undefined`. */
export function directive(wire: string): Directive | undefined {
  return BY_WIRE.get(wire);
}

/** Every directive, in the order the mcpp table declares them. */
export function directives(): readonly Directive[] {
  return DIRECTIVES;
}

/** The commit/version the snapshot was generated from, for provenance UIs. */
export function apiSource(): { version: string; commit: string } {
  return { version: api.sourceVersion, commit: api.sourceCommit };
}

/**
 * The snapshot's own invariants. Empty when the table is usable; every string is
 * a sentence a log line can carry. Deliberately narrow: it catches a snapshot
 * that would make the editor lie (nothing to suggest, two answers for one wire,
 * a role list the engine does not have, a protocol number that is not a
 * protocol), not cosmetic drift.
 */
export function apiProblems(): string[] {
  const problems: string[] = [];

  if (DIRECTIVES.length === 0) {
    problems.push("the buildscript-api snapshot has no directives");
  }

  const seen = new Set<string>();
  for (const entry of DIRECTIVES) {
    if (seen.has(entry.wire)) {
      problems.push(`duplicate directive wire name ${entry.wire}`);
    }
    seen.add(entry.wire);
  }

  const roles = api.roles;
  const isTheFiveKnownRoles =
    roles.length === ACTION_ROLES.length && ACTION_ROLES.every((role) => roles.includes(role));
  if (!isTheFiveKnownRoles) {
    problems.push(
      `roles are not the five the engine knows: [${roles.join(", ")}] ` +
        `(expected [${ACTION_ROLES.join(", ")}])`,
    );
  }

  if (!(api.protocolVersion >= 1)) {
    problems.push(`protocolVersion is not a protocol number: ${String(api.protocolVersion)}`);
  }

  return problems;
}
