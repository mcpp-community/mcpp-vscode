/**
 * The modules a `build.mcpp` can legitimately `import`, and a scanner that finds
 * the import sites in one.
 *
 * §3.2.2 of the plugin-optimisation plan: `build.mcpp` keeps its own
 * `mcpp-build` language id and the C++ language service never sees it, so this
 * extension is the only thing that can explain what an import means. The rule is
 * absolute — **we never report "module not found"**. This module therefore only
 * *recognises*; it never validates, because a build program's imports are
 * resolved by mcpp's own module graph (`docs/specs/build-plugins.md` §9,
 * `docs/30-build-mcpp.md` "The names of a plugin's modules"), not by clangd.
 *
 * The layer table of §9 is what the descriptions below name:
 *   L1 `mcpp.core`      the engine interface; `mcpp` is its permanent equivalent spelling;
 *   L2 `mcpp.plugins.*` the official general-purpose library, provided by `plugins-core`;
 *   L3 `mcpp.deps.*` / `mcpp.rules.*` / `mcpp.dist.*` / `mcpp.tools.*` official plugins,
 *      and `mcpp.<namespace>.*` for a third party in namespace `mcpp`.
 *
 * The third-party form is deliberately *not* claimed by `isKnownModule`: it is
 * indistinguishable from a file name (`mcpp.toml`), and the contract here is the
 * explicit list (`std`, `std.compat`, `mcpp`, `mcpp.core`, `mcpp.plugins.*`).
 * Not claiming a name costs a hover; claiming a wrong one would cost trust.
 */

/** One `import` site. Positions are 0-based, matching `vscode.Position`. */
export interface ImportSite {
  /** The module name exactly as written, e.g. `mcpp.plugins.tool`. */
  module: string;
  /** 0-based line index. */
  line: number;
  /** 0-based column of the module name's first character. */
  startCharacter: number;
  /** 0-based column one past the module name's last character. */
  endCharacter: number;
}

export interface KnownModule {
  name: string;
  description: string;
  docsUrl?: string;
}

const MCPP_DOCS = "https://github.com/mcpp-community/mcpp/blob/main/docs/30-build-mcpp.md";
const STD_DOCS = `${MCPP_DOCS}#import-std-mcpp-2026821`;
const CORE_DOCS = `${MCPP_DOCS}#the-interfaces-name-mcppcore-protocol-14`;
const PLUGIN_DOCS = `${MCPP_DOCS}#the-names-of-a-plugins-modules`;

/**
 * Exact module names plus `prefix.*` patterns. Order is the order a completion
 * list should show: the standard library, the engine, then the libraries built
 * on it. `mcpp.plugins.*` is the one the plan names; the other reserved second
 * segments are SPEC-007 R9.6's official namespaces.
 */
export const KNOWN_MODULES: readonly KnownModule[] = [
  {
    name: "std",
    description:
      "The C++ standard library module. mcpp stages the same `std` its own build uses, " +
      "keyed on toolchain × standard × dialect (`docs/30-build-mcpp.md`, 2026.8.2.1+).",
    docsUrl: STD_DOCS,
  },
  {
    name: "std.compat",
    description:
      "The C++ standard library plus the C library names in the global namespace; " +
      "`import std;` and `import std.compat;` may be used together.",
    docsUrl: STD_DOCS,
  },
  {
    name: "mcpp",
    description:
      "The mcpp engine interface, bundled in the mcpp binary so it always matches that " +
      "engine's protocol. The permanent equivalent spelling of `mcpp.core` (SPEC-007 R9.1).",
    docsUrl: CORE_DOCS,
  },
  {
    name: "mcpp.core",
    description:
      "The mcpp engine interface (L1). Only grows; a symbol leaves only after six months " +
      "of deprecation, and a meaning change is a new symbol (SPEC-007 R9.2).",
    docsUrl: CORE_DOCS,
  },
  {
    name: "mcpp.plugins.*",
    description:
      "The official general-purpose library (L2), provided by the `plugins-core` feature " +
      "and built only on the L1 engine interface, e.g. `mcpp.plugins.tool` (SPEC-007 §9).",
    docsUrl: PLUGIN_DOCS,
  },
  {
    name: "mcpp.deps.*",
    description:
      "Official dependency-adapter plugins (L3), e.g. a package manager or external build " +
      "system brought into the graph (SPEC-007 §0, §9).",
    docsUrl: PLUGIN_DOCS,
  },
  {
    name: "mcpp.rules.*",
    description:
      "Official rule packages (L3): code generation and device-language toolchains " +
      "(SPEC-007 §0, §9).",
    docsUrl: PLUGIN_DOCS,
  },
  {
    name: "mcpp.dist.*",
    description:
      "Official distribution members (L3): they turn a link artifact into something " +
      "installable, e.g. a WiX or APK payload (SPEC-007 §0, §9).",
    docsUrl: PLUGIN_DOCS,
  },
  {
    name: "mcpp.tools.*",
    description:
      "Official tool namespaces (L3), e.g. `mcpp.tools.island` helpers described in " +
      "docs/31 (SPEC-007 §9).",
    docsUrl: PLUGIN_DOCS,
  },
];

const EXACT_MODULES = new Map(
  KNOWN_MODULES.filter((entry) => !entry.name.endsWith(".*")).map((entry) => [entry.name, entry]),
);
const PATTERN_MODULES = KNOWN_MODULES.filter((entry) => entry.name.endsWith(".*"));

/** A dotted C++ module name (no partitions, no header units). */
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** `std`, `std.compat`, `mcpp`, `mcpp.core`, `mcpp.plugins.*` (and the other reserved L3 namespaces). */
export function isKnownModule(name: string): boolean {
  return knownModule(name) !== undefined;
}

/**
 * The description of a known module, or `undefined`. A concrete name that matches
 * a `prefix.*` pattern is returned with the concrete name, so a hover can show
 * the module the user actually wrote.
 */
export function knownModule(name: string): KnownModule | undefined {
  const exact = EXACT_MODULES.get(name);
  if (exact !== undefined) {
    return exact;
  }
  for (const pattern of PATTERN_MODULES) {
    const prefix = pattern.name.slice(0, -1); // keep the trailing dot
    if (name.startsWith(prefix)) {
      const rest = name.slice(prefix.length);
      if (MODULE_NAME.test(rest)) {
        return { name, description: pattern.description, docsUrl: pattern.docsUrl };
      }
    }
  }
  return undefined;
}

/** Every recognised module (patterns included), for completion lists. */
export function knownModules(): readonly KnownModule[] {
  return KNOWN_MODULES;
}

/**
 * Whitespace/comment/string masking state that has to survive a line boundary.
 * `blockComment` and `rawDelim` are the two C++ constructs that do.
 */
interface ScanState {
  blockComment: boolean;
  rawDelim: string | null;
}

/**
 * Replace every character that is part of a comment or a string literal with a
 * space, so a match on the result is a match on real code. Indices are preserved,
 * which is what lets positions be reported straight from a match.
 */
function maskLine(line: string, state: ScanState): string {
  let out = "";
  let i = 0;

  if (state.rawDelim !== null) {
    const terminator = `)${state.rawDelim}"`;
    const end = line.indexOf(terminator, i);
    if (end < 0) {
      return " ".repeat(line.length);
    }
    out += " ".repeat(end + terminator.length);
    i = end + terminator.length;
    state.rawDelim = null;
  }

  while (i < line.length) {
    if (state.blockComment) {
      const end = line.indexOf("*/", i);
      if (end < 0) {
        return out + " ".repeat(line.length - i);
      }
      out += " ".repeat(end + 2 - i);
      i = end + 2;
      state.blockComment = false;
      continue;
    }
    const pair = line.slice(i, i + 2);
    if (pair === "//") {
      return out + " ".repeat(line.length - i);
    }
    if (pair === "/*") {
      state.blockComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (line[i] === "R" && line[i + 1] === '"') {
      // R"delim( … )delim" — may cross lines.
      const open = /^R"([^(\s]{0,16})\(/.exec(line.slice(i));
      if (open !== null) {
        const terminator = `)${open[1]}"`;
        const end = line.indexOf(terminator, i + open[0].length);
        if (end < 0) {
          state.rawDelim = open[1];
          return out + " ".repeat(line.length - i);
        }
        const stop = end + terminator.length;
        out += " ".repeat(stop - i);
        i = stop;
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
      out += " ".repeat(Math.min(j, line.length) - i);
      i = Math.min(j, line.length);
      continue;
    }
    out += line[i];
    i += 1;
  }
  return out;
}

/**
 * `import X;` / `export import X;` / `import X.Y.Z;`, with trailing whitespace or
 * a comment. The leading class keeps a member call such as `obj.import(...)` or
 * an identifier ending in `import` from matching; the trailing lookahead keeps
 * `import X` from matching when it is not the whole declaration.
 */
const IMPORT = /(?:^|[\s;{}])import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(?=;)/g;

/**
 * Every recognised import in `lines`, in source order. Header units (`import
 * <vector>;`), header imports (`import "x.h";`) and partitions (`import :part;`)
 * are ignored: they are not module names this extension has anything to say
 * about.
 *
 * Positions are 0-based and cover the module name itself, not the statement —
 * that is the range a hover or a semantic highlight wants.
 */
export function scanImports(lines: readonly string[]): ImportSite[] {
  const sites: ImportSite[] = [];
  const state: ScanState = { blockComment: false, rawDelim: null };

  for (let line = 0; line < lines.length; line += 1) {
    const code = maskLine(lines[line], state);
    IMPORT.lastIndex = 0;
    for (let match = IMPORT.exec(code); match !== null; match = IMPORT.exec(code)) {
      const name = match[1];
      const start = match.index + match[0].lastIndexOf(name);
      sites.push({
        module: name,
        line,
        startCharacter: start,
        endCharacter: start + name.length,
      });
    }
  }

  return sites;
}
