#!/usr/bin/env node
/**
 * `data/buildscript-api.json` <- the mcpp checkout.
 *
 * Spec: `.agents/docs/archive/2026-10-02-plugin-optimisation-plan.md` §3.2.3. `build.mcpp`
 * is deliberately kept away from clangd (§3.2.1 measured that handing it to the C++
 * language service makes both `import std` and `import mcpp` fail), so the editor
 * intelligence for `mcpp::…` names comes from this snapshot instead: the directive
 * table, the five action roles, the protocol/cache constants, the provision kinds,
 * the SPEC-007 rule ids that mention each wire name, and the docs anchor when a
 * `docs/30-build-mcpp.md` heading spells the wire name in backticks.
 *
 * Everything here is derived from the mcpp sources; no row is hardcoded. The
 * declared `std::array<Def, N>` size is checked against the number of rows actually
 * parsed, and every source is mandatory — a generator that quietly writes a partial
 * or empty table is worse than one that fails, because an empty table turns every
 * `mcpp::` name into "unknown" in the editor.
 *
 * Run:  node tools/generate-buildscript-api.mjs
 * Env:  MCPP_REPO   path to the mcpp checkout (default: ../mcpp beside this repo)
 * Exit: 0 on success; 1 on any unreadable source, parse failure or count mismatch.
 *       Nothing is written on failure.
 *
 * Output is deterministic: fixed key order, source order for arrays (the directive
 * table's own order, the declared role order, the provision table's order), no
 * timestamps. `sourceCommit` is part of the data on purpose.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcppRepo = path.resolve(process.env.MCPP_REPO ?? path.join(root, "..", "mcpp"));
const outFile = path.join(root, "data", "buildscript-api.json");

/** The upstream repository, for `docsUrl` links into the pinned revision. */
const MCPP_URL = "https://github.com/mcpp-community/mcpp";
/** The docs file directive anchors are drawn from. */
const DOCS_FILE = "docs/30-build-mcpp.md";
/** The spec that owns the rule ids. */
const SPEC_FILE = "docs/specs/build-plugins.md";

function fail(message) {
  console.error(`generate-buildscript-api: error: ${message}`);
  process.exit(1);
}

function readSource(relative) {
  const file = path.join(mcppRepo, relative);
  if (!fs.existsSync(file)) {
    fail(`${relative}: not found under ${mcppRepo} (set MCPP_REPO to the mcpp checkout)`);
  }
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) {
    fail(`${relative}: empty`);
  }
  return text;
}

/** C++ string-literal body -> the characters it denotes (enough for these tables). */
function unescapeCpp(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "\\") {
      out += value[i];
      continue;
    }
    const next = value[i + 1];
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "0") out += "\0";
    else if (next === undefined) out += "\\";
    else out += next;
    i += 1;
  }
  return out;
}

function requireInt(text, label, pattern, where) {
  const match = pattern.exec(text);
  if (match === null) {
    fail(`${where}: could not find ${label}`);
  }
  return Number.parseInt(match[1], 10);
}

// ── `[package] version` from mcpp.toml ──────────────────────────────────────

function parseSourceVersion(text) {
  const lines = text.split(/\r?\n/);
  let inPackage = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      inPackage = header[1].trim() === "package";
      continue;
    }
    if (!inPackage) continue;
    const version = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
    if (version !== null) return version[1];
  }
  fail("mcpp.toml: no [package] version");
  return "";
}

function sourceCommit() {
  try {
    // The **full** hash, never `--short`: git shortens to the shortest unique
    // prefix *for this clone*, so a fresh CI checkout (7 characters) and a
    // developer's clone with more objects (8) produced two different files for
    // the same mcpp — the drift gate went red on an unchanged API.
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: mcppRepo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// ── `modules/buildmcpp/src/directives.cppm` ─────────────────────────────────

/**
 * One row of `kTable`. The comments between rows are ignored; a line that looks
 * like a row but does not parse makes the count fall short, which is a failure.
 */
const DIRECTIVE_ROW =
  /^\s*\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*Slot::([A-Za-z_]\w*)\s*,\s*Scope::([A-Za-z_]\w*)\s*,\s*Transform::([A-Za-z_]\w*)\s*,\s*(true|false)\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*\}\s*,?\s*$/;

function parseDirectives(text) {
  const declared = requireInt(
    text,
    "the kTable array size",
    /inline constexpr\s+std::array<Def,\s*(\d+)>\s+kTable\{\{/,
    "directives.cppm",
  );
  const start = text.indexOf("inline constexpr std::array<Def,");
  const open = text.indexOf("kTable{{", start);
  const end = text.indexOf("}};", open);
  if (start < 0 || open < 0 || end < 0) {
    fail("directives.cppm: could not delimit the kTable block");
  }
  const body = text.slice(open, end);

  const rows = [];
  for (const line of body.split(/\r?\n/)) {
    const match = DIRECTIVE_ROW.exec(line);
    if (match === null) continue;
    rows.push({
      wire: unescapeCpp(match[1]),
      tag: unescapeCpp(match[2]),
      slot: match[3],
      scope: match[4],
      transform: match[5],
      mustExist: match[6] === "true",
      missingPrefix: unescapeCpp(match[7]),
      missingSuffix: unescapeCpp(match[8]),
      since: Number.parseInt(match[9], 10),
    });
  }

  if (rows.length === 0) {
    fail("directives.cppm: kTable parsed to zero rows");
  }
  if (rows.length !== declared) {
    fail(
      `directives.cppm: declared ${declared} rows but parsed ${rows.length}` +
        " — a row changed shape or moved across lines",
    );
  }
  const wires = new Set();
  for (const row of rows) {
    if (row.wire.length === 0) fail("directives.cppm: a row has an empty wire name");
    if (wires.has(row.wire)) fail(`directives.cppm: duplicate wire name ${row.wire}`);
    wires.add(row.wire);
  }
  return rows;
}

/** The five roles, from the `mcpp::roles::{…}` comment above `kActionRoles`. */
function parseRoles(text) {
  const match = /mcpp::roles::\{([^}]*)\}/.exec(text);
  if (match === null) {
    fail("directives.cppm: could not find the mcpp::roles::{…} comment");
  }
  const roles = match[1]
    .replace(/\/\//g, " ")
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
  if (roles.length !== 5) {
    fail(`directives.cppm: expected 5 roles, found ${roles.length}`);
  }
  return roles;
}

// ── `modules/buildmcpp/src/program_protocol.cppm` ───────────────────────────

function parseProtocol(text) {
  return {
    protocolVersion: requireInt(
      text,
      "kProtocolVersion",
      /kProtocolVersion\s*=\s*(\d+)/,
      "program_protocol.cppm",
    ),
    cacheEpoch: requireInt(text, "kCacheEpoch", /kCacheEpoch\s*=\s*(\d+)/, "program_protocol.cppm"),
  };
}

// ── `modules/buildmcpp/src/provisions.cppm` ─────────────────────────────────

const PROVISION_ROW = /^\s*\{\s*Kind::([A-Za-z_]\w*)\s*,\s*"([^"]*)"\s*,/;

/** `HostModule` -> `host-module`; the wire string is part of the same table. */
function kebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function parseProvisions(text) {
  const start = text.indexOf("inline constexpr Def kTable[]");
  const end = text.indexOf("};", start);
  if (start < 0 || end < 0) {
    fail("provisions.cppm: could not delimit the kTable block");
  }
  const rows = [];
  for (const line of text.slice(start, end).split(/\r?\n/)) {
    const match = PROVISION_ROW.exec(line);
    if (match === null) continue;
    rows.push({ kind: kebab(match[1]), wire: match[2] });
  }
  if (rows.length === 0) {
    fail("provisions.cppm: kTable parsed to zero rows");
  }
  return rows;
}

// ── `docs/specs/build-plugins.md` rule ids ──────────────────────────────────

/**
 * A rule is `- **R2.1** …` up to the next rule or the next heading; R2.1's own
 * block contains the directive/`C++ 接口`/wire table, so a wire name mentioned
 * only in that table still credits R2.1.
 */
function parseRuleBlocks(text) {
  const blocks = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    const rule = /^-\s+\*\*(R\d+(?:\.\d+)?)\*\*/.exec(line);
    if (rule !== null) {
      current = { id: rule[1], text: line };
      blocks.push(current);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      current = undefined;
      continue;
    }
    if (current !== undefined) current.text += `\n${line}`;
  }
  return blocks;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rulesForWire(blocks, wire) {
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(wire)}(?![A-Za-z0-9_-])`);
  const rules = [];
  for (const block of blocks) {
    if (pattern.test(block.text) && !rules.includes(block.id)) {
      rules.push(block.id);
    }
  }
  return rules;
}

// ── `docs/30-build-mcpp.md` anchors ─────────────────────────────────────────

function githubSlug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Headings whose backticked text is exactly a wire name, outside code fences. */
function docAnchors(text) {
  const anchors = new Map();
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading === null) continue;
    for (const token of heading[1].matchAll(/`([^`]+)`/g)) {
      const name = token[1].trim();
      if (!anchors.has(name)) anchors.set(name, githubSlug(heading[1]));
    }
  }
  return anchors;
}

// ── Assemble ────────────────────────────────────────────────────────────────

const version = parseSourceVersion(readSource("mcpp.toml"));
const commit = sourceCommit();
const directivesText = readSource("modules/buildmcpp/src/directives.cppm");
const directives = parseDirectives(directivesText);
const roles = parseRoles(directivesText);
const { protocolVersion, cacheEpoch } = parseProtocol(
  readSource("modules/buildmcpp/src/program_protocol.cppm"),
);
const provisions = parseProvisions(readSource("modules/buildmcpp/src/provisions.cppm"));
const ruleBlocks = parseRuleBlocks(readSource(SPEC_FILE));
const anchors = docAnchors(readSource(DOCS_FILE));

const revision = commit === "unknown" ? "main" : commit;
const docsUrl = (anchor) => `${MCPP_URL}/blob/${revision}/${DOCS_FILE}#${anchor}`;

const table = directives.map((row) => {
  const entry = {
    wire: row.wire,
    tag: row.tag,
    slot: row.slot,
    scope: row.scope,
    transform: row.transform,
    mustExist: row.mustExist,
  };
  // Empty strings are omitted: an optional field that is absent reads the same as
  // one that is empty, and keeping them out makes the snapshot diffable.
  if (row.missingPrefix.length > 0) entry.missingPrefix = row.missingPrefix;
  if (row.missingSuffix.length > 0) entry.missingSuffix = row.missingSuffix;
  entry.since = row.since;
  entry.rules = rulesForWire(ruleBlocks, row.wire);
  entry.docsUrl = anchors.has(row.wire) ? docsUrl(anchors.get(row.wire)) : null;
  return entry;
});

const api = {
  sourceVersion: version,
  sourceCommit: commit,
  protocolVersion,
  cacheEpoch,
  roles,
  provisions,
  directives: table,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(api, null, 2)}\n`);

const withRules = table.filter((entry) => entry.rules.length > 0).length;
const withDocs = table.filter((entry) => entry.docsUrl !== null).length;
console.log(
  `generate-buildscript-api: mcpp ${version} @ ${commit} (protocol ${protocolVersion}, ` +
    `cache epoch ${cacheEpoch})`,
);
console.log(
  `  ${table.length} directives (${withRules} with rule ids, ${withDocs} with docs anchors), ` +
    `${roles.length} roles, ${provisions.length} provisions`,
);
console.log(`  wrote ${path.relative(root, outFile)}`);
