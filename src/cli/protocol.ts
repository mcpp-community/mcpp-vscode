/**
 * mcpp's machine-output protocol (`docs/50-machine-output.md`).
 *
 * **Detection rule**: parse stdout and require `schemaVersion` **and** `kind`.
 * The exit code is never the signal — an older mcpp answers
 * `mcpp --protocol-version` with human text on stdout and exit 1, and a
 * *failing* command can still emit a perfectly good envelope
 * (`mcpp emit build-database` on partial failure). Everything here is a pure
 * string function: no child process, no `vscode`.
 *
 * `mcpp --protocol-version` prints an envelope with a `mcpp.protocol` kind:
 *
 * ```jsonc
 * { "schemaVersion": 1, "kind": "mcpp.protocol",
 *   "envelope": { "min": 1, "max": 1 },
 *   "kinds": { "mcpp.env": 1, "mcpp.toolchain.list": 1 },
 *   "commands": { "toolchain list": { "effects": ["read"] } },
 *   "mcpp": { "version": "2026.9.30.2", "protocol": { "min": 1, "max": 1 } } }
 * ```
 *
 * `kinds` is the answer to "which `--format json` commands are safe to use" —
 * see {@link supportsKind}.
 */

export interface ProtocolEnvelope<T = unknown> {
  schemaVersion: number;
  kind: string;
  kindVersion?: number;
  data?: T;
  diagnostics?: ProtocolDiagnostic[];
  effects?: string[];
  mcpp?: { version?: string; protocol?: { min?: number; max?: number } };
}

export interface ProtocolDiagnostic {
  code: string;
  severity: "error" | "warning" | "note";
  source?: string;
  message: string;
  path?: string;
  range?: unknown;
}

export interface ProtocolInfo {
  mcppVersion?: string;
  envelopeMax?: number;
  kinds: Record<string, number>;
  /** command name -> the effects it may have, from `mcpp --protocol-version`. */
  effects: Record<string, string[]>;
}

const PROTOCOL_KIND = "mcpp.protocol";

/**
 * Upper bound on the number of substrings we are willing to try when a document
 * is not pure JSON. Only reached for malformed input, and it keeps the scan
 * linear-ish on a 16 MiB capture.
 */
const MAX_JSON_CANDIDATES = 64;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Candidate object substrings for a text that is **not** pure JSON: every `{…}`
 * span between the brace positions. Narration before or after the document (a
 * `warning:` line, a blank line, an old-mcpp banner) therefore cannot hide it,
 * and a stray `}` in trailing narration does not either.
 */
function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];

  const starts: number[] = [];
  for (let index = text.indexOf("{"); index >= 0; index = text.indexOf("{", index + 1)) {
    starts.push(index);
    if (starts.length >= MAX_JSON_CANDIDATES) {
      break;
    }
  }
  const ends: number[] = [];
  for (let index = text.lastIndexOf("}"); index >= 0; index = text.lastIndexOf("}", index - 1)) {
    ends.push(index);
    if (ends.length >= MAX_JSON_CANDIDATES) {
      break;
    }
  }

  for (const start of starts) {
    // `ends` is descending: the first entry is the outermost closing brace.
    for (const end of ends) {
      if (end <= start) {
        break;
      }
      candidates.push(text.slice(start, end + 1));
      if (candidates.length >= MAX_JSON_CANDIDATES) {
        return candidates;
      }
    }
  }
  return candidates;
}

/** The first JSON object found in `stdout`; `undefined` for anything else. */
function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  if (text.length === 0) {
    return undefined;
  }
  try {
    // The trimmed text is one complete JSON value, so it *is* the document.
    // An array or a scalar is not an envelope, and we must not dig an object
    // out of it.
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    // Narration around the document: fall through to the outermost object.
  }
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record !== undefined) {
      return record;
    }
  }
  return undefined;
}

/** Parse stdout as one enveloped document; `undefined` when it is not one. */
export function parseEnvelope<T>(stdout: string): ProtocolEnvelope<T> | undefined {
  if (typeof stdout !== "string") {
    return undefined;
  }
  const record = parseJsonObject(stdout);
  if (record === undefined) {
    return undefined;
  }
  // Presence *and* type: a string `schemaVersion` is not a document we can trust.
  if (typeof record.schemaVersion !== "number") {
    return undefined;
  }
  if (typeof record.kind !== "string" || record.kind.length === 0) {
    return undefined;
  }
  return record as unknown as ProtocolEnvelope<T>;
}

function kindVersionOf(value: unknown): number | undefined {
  const direct = readNumber(value);
  if (direct !== undefined) {
    return direct;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  return readNumber(record.version) ?? readNumber(record.max);
}

function readKindVersions(source: Record<string, unknown> | undefined): Record<string, number> {
  const versions: Record<string, number> = {};
  if (source === undefined) {
    return versions;
  }
  for (const [kind, value] of Object.entries(source)) {
    const version = kindVersionOf(value);
    if (version !== undefined) {
      versions[kind] = version;
    }
  }
  return versions;
}

function readCommandEffects(source: Record<string, unknown> | undefined): Record<string, string[]> {
  const effects: Record<string, string[]> = {};
  if (source === undefined) {
    return effects;
  }
  for (const [command, value] of Object.entries(source)) {
    const entry = asRecord(value);
    if (entry === undefined || !Array.isArray(entry.effects)) {
      continue;
    }
    effects[command] = entry.effects.filter((item): item is string => typeof item === "string");
  }
  return effects;
}

/**
 * Parse `mcpp --protocol-version`. Returns `undefined` for older mcpp (human
 * text on stdout, exit 1) and for any document that is not the protocol
 * envelope, so the caller can fall back to the legacy text path.
 *
 * The fields sit at the envelope's top level in the real output; `data` is
 * accepted as well so a future nesting cannot silently disable the probe.
 */
export function parseProtocolInfo(stdout: string): ProtocolInfo | undefined {
  const envelope = parseEnvelope(stdout) as
    | (ProtocolEnvelope & Record<string, unknown>)
    | undefined;
  if (envelope === undefined || envelope.kind !== PROTOCOL_KIND) {
    return undefined;
  }

  const data = asRecord(envelope.data);
  const mcpp = asRecord(envelope.mcpp) ?? asRecord(data?.mcpp);
  const envelopeRange = asRecord(envelope.envelope) ?? asRecord(data?.envelope);
  const protocolRange = asRecord(mcpp?.protocol);

  const info: ProtocolInfo = {
    kinds: readKindVersions(asRecord(envelope.kinds) ?? asRecord(data?.kinds)),
    effects: readCommandEffects(asRecord(envelope.commands) ?? asRecord(data?.commands)),
  };
  const mcppVersion = readString(mcpp?.version);
  if (mcppVersion !== undefined) {
    info.mcppVersion = mcppVersion;
  }
  const envelopeMax = readNumber(envelopeRange?.max) ?? readNumber(protocolRange?.max);
  if (envelopeMax !== undefined) {
    info.envelopeMax = envelopeMax;
  }
  return info;
}

/** The kinds mcpp advertised, i.e. which `--format json` commands are safe to use. */
export function supportsKind(info: ProtocolInfo | undefined, kind: string): boolean {
  if (info === undefined || typeof kind !== "string") {
    return false;
  }
  const kinds = info.kinds;
  if (typeof kinds !== "object" || kinds === null) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(kinds, kind);
}

/** `parseEnvelope` and `kind` check in one step, returning `data` or `undefined`. */
export function readData<T>(stdout: string, kind: string): T | undefined {
  const envelope = parseEnvelope<T>(stdout);
  if (envelope === undefined || envelope.kind !== kind) {
    return undefined;
  }
  return envelope.data;
}
