/**
 * Static analysis for `build.mcpp`, built on the snapshot in `api.ts` and on
 * nothing else. No compiler runs, nothing is executed, no workspace is read, so
 * this is usable in an untrusted workspace and cannot disagree with the build
 * because of a stale compilation database.
 *
 * ## What this deliberately cannot see
 *
 * It is **line-oriented, not a parser**. There is no preprocessor, no macro
 * expansion, no `#include` graph, no type information, and no evaluation of a
 * condition that guards a call. A string built by concatenation or format is
 * invisible. Positions are exact for the spellings below and approximate (the
 * whole string literal) when escapes make the offset ambiguous.
 *
 * The one cross-line heuristic is the action block: from a `mcpp::action` line
 * forward to `.submit(`, up to 40 lines. A role or `output_dir` set outside that
 * window is not seen.
 *
 * Every rule is kept conservative on purpose: a false positive erodes trust
 * faster than a missed hint. When a spelling is uncertain — a role held in a
 * variable, a flag built at run time, a payload that does not parse — the rule
 * says nothing rather than guessing.
 *
 * ## Positions
 *
 * `line` is 1-based, and `startCharacter` / `endCharacter` are 1-based columns
 * (the first character of a line is column 1), so a diagnostic prints directly
 * as `file:line:column`.
 *
 * ## Severity
 *
 * The engine does not distinguish here; the caller's setting picks one severity
 * for the whole file (`mcpp.buildScript.diagnostics.severity`).
 */
import { ACTION_ROLES, API } from "./api";

export type Severity = "error" | "warning" | "info" | "off";

export interface BuildScriptDiagnostic {
  code: string;
  message: string;
  severity: Exclude<Severity, "off">;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first character. */
  startCharacter: number;
  /** 1-based column one past the last character. */
  endCharacter: number;
}

/** The seven rule ids, as language-server code strings. */
export const DIAGNOSTIC_CODES = {
  unknownSymbol: "mcpp.buildscript.unknownSymbol",
  roleLiteral: "mcpp.buildscript.roleLiteral",
  prepareNeedsOutputDir: "mcpp.buildscript.prepareNeedsOutputDir",
  rpathInLinkFlag: "mcpp.buildscript.rpathInLinkFlag",
  rawPathFlag: "mcpp.buildscript.rawPathFlag",
  shellSyntaxInAction: "mcpp.buildscript.shellSyntaxInAction",
  actionNeedsRole: "mcpp.buildscript.actionNeedsRole",
} as const;

/**
 * The typed-API names `docs/30-build-mcpp.md` lists (its `import mcpp;` table,
 * the accessor tables, and the `mcpp::action` members). Used only to *not*
 * flag a `mcpp::` name: when a name here is wrong the cost is a missed hint,
 * never a false one, which is why the list errs towards inclusion. Directive
 * wire names are added from the snapshot separately (`link-lib` -> `link_lib`),
 * so a directive that reaches the typed surface is known without being listed.
 */
export const TYPED_API_NAMES: readonly string[] = [
  "abi_tool",
  "accel",
  "action",
  "cflag",
  "cxx_runtime",
  "cxx_stdlib",
  "cxxflag",
  "decision",
  "define",
  "dep_bin",
  "dep_dir",
  "dep_linkage",
  "deploy",
  "device_sources",
  "fact",
  "floor",
  "generated",
  "graph_file",
  "has_feature",
  "host",
  "include_dir",
  "include_dir_after",
  "link_flag",
  "link_lib",
  "link_script",
  "link_search",
  "manifest_dir",
  "min_platform_version",
  "msvc_crt_linkage",
  "msvc_instance_dir",
  "ninja_program",
  "out_dir",
  "pack_debug_symbols_dir",
  "pack_format",
  "pack_stage_dir",
  "pack_strip",
  "package_authors",
  "package_description",
  "package_license",
  "package_repo",
  "package_version",
  "phase",
  "pkg_config_libdir",
  "plugins",
  "profile",
  "provision",
  "provides_pack_format",
  "report",
  "rerun_if_changed",
  "rerun_if_changed_glob",
  "rerun_if_env_changed",
  "roles",
  "runner",
  "runtime_search_dir",
  "source",
  "stage_dir",
  "sysroot_dir",
  "target",
  "target_arch",
  "target_env",
  "target_os",
  "tool",
  "tool_env",
  "toolchain",
  "toolchain_binutils_dir",
  "toolchain_dir",
  "toolchain_sysroot",
  "tools",
  "toolset_identity",
  "warning",
  "windows_entry",
  "windows_subsystem",
  "xpkg_dir",
  "xpkg_pending",
  "xpkg_program",
  "xpkg_request",
  "xpkg_source",
];

/** The five action roles. Constant, so a malformed snapshot cannot disable a rule. */
const ROLE_NAMES: ReadonlySet<string> = new Set(ACTION_ROLES);

const KNOWN_SYMBOLS: ReadonlySet<string> = (() => {
  const names = new Set<string>(TYPED_API_NAMES);
  for (const role of ACTION_ROLES) {
    names.add(role);
  }
  for (const entry of API.directives) {
    names.add(entry.wire);
    names.add(entry.wire.replace(/-/g, "_"));
  }
  return names;
})();

/** How far past `mcpp::action` a role or `output_dir` may appear. */
const ACTION_WINDOW = 40;

const RAWPATH = /(?:^|\s)(-[IL]\S*)/;
const RPATH = "-Wl,-rpath";
const SHELL_ENV = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*=\S*)/;
const SHELL_CD = /(?:^|\s)(cd\s+\S+\s*&&)/;
const IMPORT_ACTION = "mcpp:action=";

interface StringLiteral {
  /** The characters the literal denotes. */
  value: string;
  /** 0-based column of the opening quote. */
  start: number;
  /** 0-based column one past the closing quote. */
  end: number;
  /** The source text including quotes, escape sequences intact. */
  raw: string;
}

interface MaskedLine {
  /** The source line with comment and string-literal characters blanked. */
  code: string;
  strings: StringLiteral[];
}

interface ScanState {
  blockComment: boolean;
  rawDelim: string | null;
}

function unescape(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== "\\") {
      out += raw[i];
      continue;
    }
    const next = raw[i + 1];
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === undefined) out += "\\";
    else out += next;
    i += 1;
  }
  return out;
}

/**
 * Split one line into real code plus the string literals it contains: every
 * character inside a comment or a literal becomes a space in `code`, so a match
 * on `code` is a match on code. Indices are preserved. `state` carries the two
 * constructs that outlive a line, a block comment and a raw string.
 */
function maskLine(line: string, state: ScanState): MaskedLine {
  const out = line.split("");
  const strings: StringLiteral[] = [];
  const blank = (from: number, to: number): void => {
    for (let i = Math.max(0, from); i < Math.min(to, line.length); i += 1) {
      out[i] = " ";
    }
  };

  let i = 0;
  if (state.rawDelim !== null) {
    const terminator = `)${state.rawDelim}"`;
    const end = line.indexOf(terminator);
    if (end < 0) {
      return { code: " ".repeat(line.length), strings };
    }
    blank(0, end + terminator.length);
    i = end + terminator.length;
    state.rawDelim = null;
  }

  while (i < line.length) {
    if (state.blockComment) {
      const end = line.indexOf("*/", i);
      if (end < 0) {
        blank(i, line.length);
        break;
      }
      blank(i, end + 2);
      i = end + 2;
      state.blockComment = false;
      continue;
    }
    const pair = line.slice(i, i + 2);
    if (pair === "//") {
      blank(i, line.length);
      break;
    }
    if (pair === "/*") {
      state.blockComment = true;
      i += 2;
      continue;
    }
    if (line[i] === "R" && line[i + 1] === '"') {
      const open = /^R"([^(\s]{0,16})\(/.exec(line.slice(i));
      if (open !== null) {
        const terminator = `)${open[1]}"`;
        const end = line.indexOf(terminator, i + open[0].length);
        if (end < 0) {
          state.rawDelim = open[1];
          blank(i, line.length);
          break;
        }
        blank(i, end + terminator.length);
        i = end + terminator.length;
        continue;
      }
    }
    if (line[i] === "'" && /[A-Za-z0-9_]/.test(line[i - 1] ?? "")) {
      // A `'` right after an identifier character is a digit separator (1'000),
      // not the start of a character literal; scanning for a closing quote would
      // swallow the rest of the line.
      i += 1;
      continue;
    }
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i];
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      const stop = Math.min(j, line.length);
      strings.push({
        value: unescape(line.slice(i + 1, Math.max(i + 1, stop - 1))),
        start: i,
        end: stop,
        raw: line.slice(i, stop),
      });
      blank(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }

  return { code: out.join(""), strings };
}

/** The narrowest honest span for `needle` inside a literal, or the literal itself. */
function literalSpan(literal: StringLiteral, needle: string): { start: number; end: number } {
  if (needle.length > 0) {
    const at = literal.raw.indexOf(needle);
    if (at >= 0) {
      return { start: literal.start + at, end: literal.start + at + needle.length };
    }
  }
  return { start: literal.start, end: literal.end };
}

interface RoleSite {
  text: string;
  literal: boolean;
  line: number;
  start: number;
  end: number;
}

interface ActionBlock {
  line: number;
  actionStart: number;
  actionEnd: number;
  role: RoleSite | null;
  hasRoleField: boolean;
  hasOutputDir: boolean;
}

/** `mcpp::action` … `.submit()` windows, with the role and `output_dir` they declare. */
function findActionBlocks(masked: readonly MaskedLine[]): ActionBlock[] {
  const blocks: ActionBlock[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    const token = /\bmcpp::action\b/.exec(masked[i].code);
    if (token === null) {
      continue;
    }
    const limit = Math.min(masked.length - 1, i + ACTION_WINDOW);
    let end = limit;
    for (let j = i; j <= limit; j += 1) {
      if (/\.submit\s*\(/.test(masked[j].code)) {
        end = j;
        break;
      }
    }
    const block: ActionBlock = {
      line: i,
      actionStart: token.index,
      actionEnd: token.index + token[0].length,
      role: null,
      hasRoleField: false,
      hasOutputDir: false,
    };
    for (let j = i; j <= end; j += 1) {
      const { code, strings } = masked[j];
      if (!block.hasOutputDir && /\.output_dir\s*\(/.test(code)) {
        block.hasOutputDir = true;
      }
      const constant = /mcpp::roles::([A-Za-z_]\w*)/.exec(code);
      if (constant !== null && block.role === null) {
        block.hasRoleField = true;
        block.role = {
          text: constant[1],
          literal: false,
          line: j,
          start: constant.index,
          end: constant.index + constant[0].length,
        };
      }
      if (block.role === null) {
        const assign = /\brole\s*=/.exec(code);
        if (assign !== null) {
          block.hasRoleField = true;
          const after = assign.index + assign[0].length;
          const literal = strings.find(
            (entry) => entry.start >= after && code.slice(after, entry.start).trim() === "",
          );
          if (literal !== undefined) {
            block.role = {
              text: literal.value,
              literal: true,
              line: j,
              start: literal.start,
              end: literal.end,
            };
          }
        }
      }
    }
    blocks.push(block);
  }
  return blocks;
}

/**
 * Every diagnostic the text earns, all at `severity`, sorted by position.
 *
 * `lines` are the file's lines without their terminators (`text.split(/\r?\n/)`).
 */
export function analyseBuildScript(
  lines: readonly string[],
  severity: Exclude<Severity, "off">,
): BuildScriptDiagnostic[] {
  const masked: MaskedLine[] = [];
  const state: ScanState = { blockComment: false, rawDelim: null };
  for (const line of lines) {
    masked.push(maskLine(line, state));
  }

  const found: BuildScriptDiagnostic[] = [];
  const report = (code: string, message: string, line: number, start: number, end: number): void => {
    found.push({
      code,
      message,
      severity,
      line: line + 1,
      startCharacter: start + 1,
      endCharacter: end + 1,
    });
  };

  // 1. `mcpp::<name>` that the engine does not have.
  for (let i = 0; i < masked.length; i += 1) {
    const symbols = /\bmcpp::([A-Za-z_][A-Za-z0-9_]*)/g;
    for (let match = symbols.exec(masked[i].code); match !== null; match = symbols.exec(masked[i].code)) {
      if (KNOWN_SYMBOLS.has(match[1])) {
        continue;
      }
      report(
        DIAGNOSTIC_CODES.unknownSymbol,
        `unknown mcpp::${match[1]}: not a directive, action role or typed-API name in the ` +
          `mcpp build-script snapshot (SPEC-007 §2; docs/30-build-mcpp.md)`,
        i,
        match.index,
        match.index + match[0].length,
      );
    }
  }

  // 2. `role = "<known role>"` where the engine's constant exists (R3.6).
  const blocks = findActionBlocks(masked);
  for (let i = 0; i < masked.length; i += 1) {
    const assign = /\brole\s*=/g;
    for (let match = assign.exec(masked[i].code); match !== null; match = assign.exec(masked[i].code)) {
      const after = match.index + match[0].length;
      const literal = masked[i].strings.find(
        (entry) => entry.start >= after && masked[i].code.slice(after, entry.start).trim() === "",
      );
      if (literal === undefined) {
        continue;
      }
      if (ROLE_NAMES.has(literal.value)) {
        report(
          DIAGNOSTIC_CODES.roleLiteral,
          `role is spelled as the string "${literal.value}"; use mcpp::roles::${literal.value} ` +
            `so an engine that does not know the role refuses to compile it (SPEC-007 R3.6)`,
          i,
          literal.start,
          literal.end,
        );
      } else {
        report(
          DIAGNOSTIC_CODES.actionNeedsRole,
          `unknown action role "${literal.value}"; the five roles are ` +
            `${ACTION_ROLES.join(", ")} (SPEC-007 R3.6)`,
          i,
          literal.start,
          literal.end,
        );
      }
    }
  }

  // 3 + 7 (typed form). A block with a role this pass already reported (an unknown
  // literal) is not reported twice; a block whose role is a variable is not
  // reported at all.
  for (const block of blocks) {
    if (!block.hasRoleField) {
      report(
        DIAGNOSTIC_CODES.actionNeedsRole,
        "this mcpp::action declares no role; name one of " +
          `${ACTION_ROLES.join(", ")} (mcpp::roles::…) — a missing role is read as "source" ` +
          `(SPEC-007 R3.2, R3.6)`,
        block.line,
        block.actionStart,
        block.actionEnd,
      );
      continue;
    }
    if (block.role === null || block.role.text !== "prepare" || block.hasOutputDir) {
      continue;
    }
    report(
      DIAGNOSTIC_CODES.prepareNeedsOutputDir,
      "a prepare action must declare the directory its command fills with output_dir(…): " +
        "the engine refuses an action without one (SPEC-007 R3.3)",
      block.role.line,
      block.role.start,
      block.role.end,
    );
  }

  // 3 + 6 + 7 (raw `mcpp:action=` payload; the frozen printf surface). A payload
  // that does not parse is skipped rather than guessed at, and a role spelled as
  // a string is *not* rule 2 here: docs/30 explicitly allows the string on this
  // surface.
  for (let i = 0; i < masked.length; i += 1) {
    for (const literal of masked[i].strings) {
      const at = literal.value.indexOf(IMPORT_ACTION);
      if (at < 0) {
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(literal.value.slice(at + IMPORT_ACTION.length).trim());
      } catch {
        continue;
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        continue;
      }
      const record = payload as Record<string, unknown>;
      const role = record.role;
      if (typeof role !== "string") {
        report(
          DIAGNOSTIC_CODES.actionNeedsRole,
          `this mcpp:action payload declares no role; the five roles are ` +
            `${ACTION_ROLES.join(", ")} (SPEC-007 R3.6)`,
          i,
          literal.start,
          literal.end,
        );
      } else if (!ROLE_NAMES.has(role)) {
        report(
          DIAGNOSTIC_CODES.actionNeedsRole,
          `unknown action role "${role}"; the five roles are ${ACTION_ROLES.join(", ")} ` +
            `(SPEC-007 R3.6)`,
          i,
          literal.start,
          literal.end,
        );
      } else if (role === "prepare" && typeof record.output_dir !== "string") {
        report(
          DIAGNOSTIC_CODES.prepareNeedsOutputDir,
          "a prepare action must declare output_dir: the engine refuses an action without " +
            "one (SPEC-007 R3.3)",
          i,
          literal.start,
          literal.end,
        );
      }
      const command = record.command;
      if (Array.isArray(command)) {
        for (const entry of command) {
          if (typeof entry !== "string") {
            continue;
          }
          const needle = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*=\S*)/.exec(entry)?.[1]
            ?? /(?:^|\s)(cd\s+\S+\s*&&)/.exec(entry)?.[1];
          if (needle !== undefined) {
            report(
              DIAGNOSTIC_CODES.shellSyntaxInAction,
              `the command spells shell syntax ("${needle}"); declare it with env(…) and ` +
                `cwd(…) instead (SPEC-007 R3.8)`,
              i,
              literal.start,
              literal.end,
            );
            break;
          }
        }
      }
    }
  }

  // 4 + 5. Flags that R2.1/R4.4 send to directives.
  for (let i = 0; i < masked.length; i += 1) {
    const { code, strings } = masked[i];
    const isCxxFlagCall = /(?:^|[^\w])(?:cxxflag|cflag)\s*\(/.test(code);
    const isLinkFlagCall = /(?:^|[^\w])link_flag\s*\(/.test(code);
    for (const literal of strings) {
      const value = literal.value;
      const isLinkFlag = isLinkFlagCall || value.includes("mcpp:link-flag=");
      const isCxxFlag = isCxxFlagCall || value.includes("mcpp:cxxflag=") || value.includes("mcpp:cflag=");
      if (isLinkFlag && value.includes(RPATH)) {
        report(
          DIAGNOSTIC_CODES.rpathInLinkFlag,
          "a run path must not be spelled in link_flag; declare the directory with " +
            "mcpp::runtime_search_dir(…) (SPEC-007 R4.4)",
          i,
          literalSpan(literal, RPATH).start,
          literalSpan(literal, RPATH).end,
        );
      }
      if (isLinkFlag || isCxxFlag) {
        const token = RAWPATH.exec(value)?.[1];
        if (token !== undefined) {
          const span = literalSpan(literal, token);
          report(
            DIAGNOSTIC_CODES.rawPathFlag,
            `spelling "${token}" in a raw flag bypasses the engine's rendering; use ` +
              `mcpp::include_dir / mcpp::include_dir_after / mcpp::link_search (SPEC-007 R2.1)`,
            i,
            span.start,
            span.end,
          );
        }
      }
    }
  }

  // 6 (typed form). Only strings that are arguments of `.arg()`/`.command()` in
  // an action block, so an `env()` value or an unrelated string cannot match.
  const actionLines = new Set<number>();
  for (const block of blocks) {
    for (let i = block.line; i < masked.length; i += 1) {
      actionLines.add(i);
      if (/\.submit\s*\(/.test(masked[i].code)) {
        break;
      }
    }
  }
  for (let i = 0; i < masked.length; i += 1) {
    if (!actionLines.has(i) || !/\.(?:arg|command)\s*\(/.test(masked[i].code)) {
      continue;
    }
    for (const literal of masked[i].strings) {
      const needle = SHELL_ENV.exec(literal.value)?.[1] ?? SHELL_CD.exec(literal.value)?.[1];
      if (needle === undefined) {
        continue;
      }
      const span = literalSpan(literal, needle);
      report(
        DIAGNOSTIC_CODES.shellSyntaxInAction,
        `the command spells shell syntax ("${needle}"); declare the environment and working ` +
          `directory with env(…) and cwd(…) instead (SPEC-007 R3.8)`,
        i,
        span.start,
        span.end,
      );
    }
  }

  const seen = new Set<string>();
  const unique = found.filter((entry) => {
    const key = `${entry.code}:${entry.line}:${entry.startCharacter}:${entry.endCharacter}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  unique.sort(
    (a, b) =>
      a.line - b.line ||
      a.startCharacter - b.startCharacter ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  return unique;
}
