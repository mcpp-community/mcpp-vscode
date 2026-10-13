# Editing `build.mcpp`

`build.mcpp` is mcpp's build program: C++ that the engine compiles and runs to produce the
build graph. **It is an ordinary `cpp` document** (this extension declares the filename for the
`cpp` language, and C++ Modules associates `.mcpp` with `cpp` too); the module grammar
`source.cpp.mcpp-modules` is injected into `source.cpp`.

## Who answers what

C++ Modules (mcppls, 0.0.12 and later) compiles `build.mcpp` as the build program it is: against
the modules it really imports, `mcpp`, `std` and the plugins named in
`[build-dependencies]`, with the toolchain the build uses. Its completion, hover, navigation and
diagnostics are a compiler's. This extension adds what no compiler says:

| | C++ Modules serves the file | C++ Modules is disabled or switched off here |
| --- | --- | --- |
| SPEC-007 rule checks (six of the seven rules below) | this extension | this extension |
| `unknownSymbol` | off — the compiler's answer replaces it | this extension, import-aware |
| `mcpp::…` directive completion and hover, snippets | this extension | this extension |
| Module names after `import` (completion, hover) | C++ Modules | this extension |

"Serves" is read without asking anything of the language server: the C++ Modules extension is
installed and enabled, and `mcppls.enable` is not `false` for the workspace. When that changes
(the extension is enabled, disabled, or switched off for the workspace) the open `build.mcpp`
files are re-checked at once.

Up to 0.6.0 this extension gave `build.mcpp` a language id of its own, `mcpp-build`. VS Code
prefers a filename match over an extension match, so that hid the file from C++ Modules, which
selects `cpp` documents: the build program got a line-by-line text check instead of a compiler,
and `import mcpp.rules.qt;` followed by `mcpp::rules::qt::…` was reported as an unknown name.
A setting written for that language (`"[mcpp-build]": { … }`) no longer applies; write it under
`"[cpp]"`.

## What this extension provides

All of it comes from the generated snapshot (`data/buildscript-api.json`) or from
`src/buildscript/modules.ts`; nothing executes a compiler or a build program, so the providers
work in an untrusted workspace.

### Completion

Registered for `cpp` documents named `build.mcpp`, in `src/buildscript/providers.ts`.

- After `mcpp::` (or `mcpp::pre`): directive names, from the 31 entries in the snapshot's
  `directives` array, with `-` rewritten to `_` (so the wire name `link-flag` offers
  `link_flag`). Kind: function.
- After `import ` or `export import `, only while C++ Modules does not serve the file: the
  concrete module names from the known-module table (the `prefix.*` patterns are not offered as
  literal text). Kind: module, with the module's description as documentation.

### Hover

- On a known module name in an `import`, only while C++ Modules does not serve the file: the
  module name and its description (for a `prefix.*` match, the concrete name the user wrote is
  shown).
- On `mcpp::<name>`: the wire spelling (`mcpp:<wire>=`), `slot`, `scope`, `since protocol`, the
  SPEC-007 rules and a link into mcpp's `docs/30-build-mcpp.md`.

### Known modules — never reported missing

`KNOWN_MODULES` in `src/buildscript/modules.ts` recognises `std`, `std.compat`, `mcpp`,
`mcpp.core` exactly, and `mcpp.plugins.*`, `mcpp.deps.*`, `mcpp.rules.*`, `mcpp.dist.*`,
`mcpp.tools.*` by prefix. The rule is absolute: **we never report "module not found"**. The
table only *recognises*; it never validates, because a build program's imports are resolved by
mcpp's own module graph, not by clangd. A third-party `mcpp.<namespace>.*` name is deliberately
not claimed: it is indistinguishable from a filename, and a missed hover is cheaper than a
wrong accusation.

The cost is honest: there is **no symbol-level completion, hover or navigation inside `std` or
`mcpp`** here. Knowing the module name is not the same as knowing its API.

### Diagnostics

Seven rules, from `analyseBuildScript` in `src/buildscript/analysis.ts`. `code` is the
diagnostic's `code`; `source` is `mcpp`.

| Code | What it flags | SPEC-007 |
| --- | --- | --- |
| `mcpp.buildscript.unknownSymbol` | An `mcpp::<name>` that is not a directive, an action role or a typed-API name in the snapshot, and not a namespace the file imports (`import mcpp.rules.qt;` covers `mcpp::rules::…`). Only while C++ Modules does not serve the file | §2 |
| `mcpp.buildscript.roleLiteral` | `role = "<known role>"`; use `mcpp::roles::<role>` so an engine that does not know it refuses to compile | R3.6 |
| `mcpp.buildscript.prepareNeedsOutputDir` | A `prepare` action with no `output_dir(…)` | R3.3 |
| `mcpp.buildscript.rpathInLinkFlag` | `-Wl,-rpath` in `link_flag`; use `mcpp::runtime_search_dir(…)` | R4.4 |
| `mcpp.buildscript.rawPathFlag` | `-I…` / `-L…` in `cxxflag` / `cflag` / `link_flag`; use `include_dir`, `include_dir_after`, `link_search` | R2.1 |
| `mcpp.buildscript.shellSyntaxInAction` | `NAME=value cmd` or `cd x &&` inside an action command; use `env(…)` and `cwd(…)` | R3.8 |
| `mcpp.buildscript.actionNeedsRole` | An `mcpp::action` that declares no role, or one of the five roles spelled as an unknown string | R3.2, R3.6 |

The five roles are `source`, `check`, `object`, `artifact`, `prepare`. Both the typed surface
(`mcpp::action`, `.output_dir(…)`, `.submit()`, `.arg()` / `.command()`) and the frozen raw
payload (`mcpp:action={…}`) are covered.

`mcpp.buildScript.diagnostics` (default `true`) turns the collection on or off;
`mcpp.buildScript.diagnostics.severity` (`warning` | `info` | `off`, default `warning`) picks
**one** severity for the whole file — the analyser does not rank rules against each other.

## Limitations, stated plainly

The analyser is **line-oriented, not a parser**. It has no preprocessor, no macro expansion, no
`#include` graph, no type information, and it does not evaluate a condition that guards a call.
A string built by concatenation or formatting is invisible. The one cross-line heuristic is the
action block: from an `mcpp::action` line forward to `.submit(`, at most 40 lines; a role or
`output_dir` set outside that window is not seen. Positions are exact for the spellings the
rules look for and approximate (the whole string literal) when escapes make the offset
ambiguous. Every rule is conservative on purpose: when a spelling is uncertain it says nothing.

Comments and string literals are masked before matching, so a rule never fires on a comment, and
the raw-string and block-comment state carries across lines.

## The snapshot

`data/buildscript-api.json` this build ships:

| Field | Value |
| --- | --- |
| `sourceVersion` | `2026.10.11.1` |
| `sourceCommit` | `3fb2d0cc` |
| `protocolVersion` | `15` |
| `cacheEpoch` | `3` |
| `roles` | `source`, `check`, `object`, `artifact`, `prepare` |
| `directives` | 31 entries (wire, tag, slot, scope, transform, `must`, `missingPrefix`, `missingSuffix`, `sinceProtocol`, rules, docs URL) |

`src/buildscript/api.ts` reads it and exposes `API` and `directive(wire)`. It is generated by
`tools/generate-buildscript-api.mjs` from an mcpp checkout (`MCPP_REPO`, default `../mcpp`) and
committed; `npm run check:generated` fails on drift.

## Settings that shape this page

| Key | Default | What it does |
| --- | --- | --- |
| `mcpp.buildScript.intelligence` | `true` | the master switch: off means no completion, hover or snippets for `build.mcpp`, and diagnostics stop too |
| `mcpp.buildScript.diagnostics` | `true` | the seven SPEC-007 diagnostics |
| `mcpp.buildScript.diagnostics.severity` | `warning` | `warning`, `info`, or `off` |
| `mcpp.buildScript.snippets` | `true` | the `mcpp::…` snippet catalogue; independent of completion and hover |
| `mcpp.buildScript.imports.knownModules` | `true` | whether `std`, `std.compat` and `mcpp.*` appear in **import completion**. Hover still recognises them and no import is ever reported missing, whichever way this is set |

Full descriptions, scopes and "when it applies": [settings.md](settings.md).
