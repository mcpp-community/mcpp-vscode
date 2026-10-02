# Editing `build.mcpp`

`build.mcpp` is mcpp's build program: C++ that the engine compiles and runs to produce the
build graph. It gets its own language id, `mcpp-build` (exact filename `build.mcpp`), with the
TextMate grammar `source.mcpp-build` from `syntaxes/mcpp-build.tmLanguage.json`; the module
grammar `source.cpp.mcpp-modules` is injected into both `source.cpp` and `source.mcpp-build`.

## Why it is not handed to the C++ language service

Measured on a real mcppls payload with clangd 23.1.0, handing `build.mcpp` to the C++ language
service fails for **both** `import std;` and `import mcpp;`:

```text
$ mcppls check build.mcpp --payload <payload>
root      …/examples/11-features/greeter
database  6 entries, 2 standard library units, 0 left out
module    build.mcpp:2: module 'mcpp' not found
E [module_not_found] Line 1: module 'std' not found
E Failed to build module mcpp; due to Don't get the module unit for module mcpp
clangd    exit 3

$ mcppls check src/main.cpp --payload <payload>
database  6 entries, 2 standard library units, 0 left out
clangd    exit 0
```

The reason is in the build database: `mcpp emit build-database --spec compile-commands --format
json` lists 6 records and **none of them is `build.mcpp`** — it only appears under `data.watch`.
mcpp deliberately does not put the build program into the compilation database, and mcppls's
model has no `build.mcpp` (it handles `target/.build-mcpp/deps/…`). So this is not "only `mcpp`
is missing": `std` fails too, and VS Code has no public API to filter a diagnostic another
extension published.

**Therefore `build.mcpp` stays in its own language id and the C++ language service never sees
it.** This extension analyses the file itself, and it never reports any import as missing.

## What this extension provides

All of it comes from the generated snapshot (`data/buildscript-api.json`) or from
`src/buildscript/modules.ts`; nothing executes a compiler or a build program, so the providers
work in an untrusted workspace.

### Completion

Registered for the `mcpp-build` language in `src/buildscript/providers.ts`.

- After `mcpp::` (or `mcpp::pre`): directive names, from the 31 entries in the snapshot's
  `directives` array, with `-` rewritten to `_` (so the wire name `link-flag` offers
  `link_flag`). Kind: function.
- After `import ` or `export import `: the concrete module names from the known-module table
  (the `prefix.*` patterns are not offered as literal text). Kind: module, with the module's
  description as documentation.

### Hover

- On a known module name in an `import`: the module name and its description (for a
  `prefix.*` match, the concrete name the user wrote is shown).
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
| `mcpp.buildscript.unknownSymbol` | An `mcpp::<name>` that is not a directive, an action role or a typed-API name in the snapshot | §2 |
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
| `sourceVersion` | `2026.10.1.3` |
| `sourceCommit` | `4d81d062` |
| `protocolVersion` | `15` |
| `cacheEpoch` | `3` |
| `roles` | `source`, `check`, `object`, `artifact`, `prepare` |
| `directives` | 31 entries (wire, tag, slot, scope, transform, `must`, `missingPrefix`, `missingSuffix`, `sinceProtocol`, rules, docs URL) |

`src/buildscript/api.ts` reads it and exposes `API` and `directive(wire)`. It is generated by
`tools/generate-buildscript-api.mjs` from an mcpp checkout (`MCPP_REPO`, default `../mcpp`) and
committed; `npm run check:generated` fails on drift.

## Settings that shape this page

| Key | Default | Read by this build |
| --- | --- | --- |
| `mcpp.buildScript.diagnostics` | `true` | yes — `src/extension.ts` |
| `mcpp.buildScript.diagnostics.severity` | `warning` | yes |
| `mcpp.buildScript.intelligence` | `true` | **no** — there is no separate switch; completion and hover are always registered |
| `mcpp.buildScript.snippets` | `true` | **no** — no snippet provider is registered |
| `mcpp.buildScript.imports.knownModules` | `true` | **no** — the analyser never reports a missing module regardless of this key |

Full descriptions, scopes and "when it applies": [settings.md](settings.md).
