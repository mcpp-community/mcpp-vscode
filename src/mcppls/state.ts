/**
 * What the C++ Modules extension reports about itself, normalised.
 *
 * Pure: it takes the object mcppls's `activate()` returned and answers with a
 * shape this extension can render, or with `available: false`.
 *
 * **This is a best-effort channel, not a contract.** mcppls's own name for that
 * object is `TestApi`; the *contents* we read (`CxxModulesStatus`) are specified
 * by S3, but whether the object is exposed at all is not promised. So every read
 * is defensive: a missing function, a thrown error, an unknown `state` or a
 * field of the wrong type all end in `available: false` and the view simply
 * shows less. Nothing here may throw.
 *
 * The one thing worth calling out: an issue carries an optional `command` — S3's
 * own fix for it. We surface that rather than guessing a remedy.
 */

export interface McpplsIssue {
  code: string;
  message: string;
  /** S3's own remedy, when it offers one. */
  command?: { command: string; arguments?: unknown[]; title?: string };
}

export interface McpplsEngineStatus {
  name: string;
  version: string;
  role: string;
  state: string;
}

export interface McpplsStateView {
  available: boolean;
  /** Why it is unavailable, for the log; never shown as an error. */
  reason?: string;
  version?: string;
  active?: boolean;
  enabled?: boolean;
  state?: McpplsState;
  project?: { root: string; source: string; level?: number; tier?: number };
  profile?: { kind: string; compiler?: string; stdlib: string; target: string; standard?: string };
  engine?: { name: string; version: string };
  engines?: McpplsEngineStatus[];
  progress?: { done: number; total: number };
  issues?: McpplsIssue[];
  notices?: McpplsIssue[];
  onlineRun?: { outcome: string; message: string; at: string };
}

export const MCPPLS_STATES = ["starting", "loading", "preparing", "ready", "degraded", "error"] as const;
export type McpplsState = (typeof MCPPLS_STATES)[number];

export interface McpplsMeta {
  version?: string;
  active?: boolean;
  enabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function knownState(value: unknown): McpplsState | undefined {
  return typeof value === "string" && (MCPPLS_STATES as readonly string[]).includes(value)
    ? (value as McpplsState)
    : undefined;
}

function issue(value: unknown): McpplsIssue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const code = text(value.code);
  const message = text(value.message);
  if (code === undefined || message === undefined) {
    return undefined;
  }
  const rawCommand = value.command;
  const command =
    isRecord(rawCommand) && text(rawCommand.command) !== undefined
      ? {
          command: text(rawCommand.command) as string,
          arguments: Array.isArray(rawCommand.arguments) ? rawCommand.arguments : undefined,
          title: text(rawCommand.title),
        }
      : undefined;
  return { code, message, command };
}

function issues(value: unknown): McpplsIssue[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value.map(issue).filter((entry): entry is McpplsIssue => entry !== undefined);
  return parsed.length === 0 ? undefined : parsed;
}

/**
 * Normalise the object mcppls's `activate()` returned.
 *
 * `lastStatus()` is read through `Function.prototype.call` on the object itself
 * so a getter or a prototype method behaves the same way.
 */
export function readStateFromExports(exports: unknown, meta: McpplsMeta = {}): McpplsStateView {
  const base: McpplsStateView = {
    available: false,
    version: meta.version,
    active: meta.active,
    enabled: meta.enabled,
  };
  if (!isRecord(exports)) {
    return { ...base, reason: "mcppls exposes no API object" };
  }
  const reader = (exports as Record<string, unknown>).lastStatus;
  if (typeof reader !== "function") {
    return { ...base, reason: "mcppls's API object has no lastStatus()" };
  }
  let raw: unknown;
  try {
    raw = (reader as () => unknown).call(exports);
  } catch (error) {
    return { ...base, reason: `lastStatus() threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(raw)) {
    // `undefined` is normal before the first status arrives; say so, do not complain.
    return { ...base, reason: raw === undefined ? "no status yet" : "lastStatus() returned an unexpected shape" };
  }
  const state = knownState(raw.state);
  if (state === undefined) {
    return { ...base, reason: `unknown state ${JSON.stringify(raw.state)}` };
  }

  const view: McpplsStateView = { ...base, available: true, state };

  const project = raw.project;
  if (isRecord(project)) {
    const root = text(project.root);
    const source = text(project.source);
    if (root !== undefined && source !== undefined) {
      view.project = {
        root,
        source,
        level: finiteNumber(project.level),
        tier: finiteNumber(project.tier),
      };
    }
  }

  const profile = raw.profile;
  if (isRecord(profile)) {
    const kind = text(profile.kind);
    const stdlib = text(profile.stdlib);
    const target = text(profile.target);
    if (kind !== undefined && stdlib !== undefined && target !== undefined) {
      view.profile = { kind, stdlib, target, compiler: text(profile.compiler), standard: text(profile.standard) };
    }
  }

  const engine = raw.engine;
  if (isRecord(engine)) {
    const name = text(engine.name);
    const version = text(engine.version);
    if (name !== undefined && version !== undefined) {
      view.engine = { name, version };
    }
  }

  if (Array.isArray(raw.engines)) {
    const engines = raw.engines
      .map((entry): McpplsEngineStatus | undefined => {
        if (!isRecord(entry)) return undefined;
        const name = text(entry.name);
        const version = text(entry.version);
        const role = text(entry.role);
        const state = text(entry.state);
        return name !== undefined && version !== undefined && role !== undefined && state !== undefined
          ? { name, version, role, state }
          : undefined;
      })
      .filter((entry): entry is McpplsEngineStatus => entry !== undefined);
    if (engines.length > 0) {
      view.engines = engines;
    }
  }

  const progress = raw.progress;
  if (isRecord(progress)) {
    const done = finiteNumber(progress.done);
    const total = finiteNumber(progress.total);
    if (done !== undefined && total !== undefined) {
      view.progress = { done, total };
    }
  }

  view.issues = issues(raw.issues);
  view.notices = issues(raw.notices);

  const onlineRun = raw.onlineRun;
  if (isRecord(onlineRun)) {
    const outcome = text(onlineRun.outcome);
    const message = text(onlineRun.message);
    const at = text(onlineRun.at);
    if (outcome !== undefined && message !== undefined && at !== undefined) {
      view.onlineRun = { outcome, message, at };
    }
  }

  return view;
}

/** One line for the environment self-check; never throws. */
export function describeState(view: McpplsStateView): string {
  if (!view.available) {
    return `unavailable (${view.reason ?? "unknown reason"})`;
  }
  const parts = [view.state ?? "unknown"];
  if (view.project !== undefined) parts.push(`project ${view.project.source}`);
  if (view.engine !== undefined) parts.push(`engine ${view.engine.name} ${view.engine.version}`);
  if (view.issues !== undefined) parts.push(`${view.issues.length} issue(s)`);
  return parts.join(" · ");
}
