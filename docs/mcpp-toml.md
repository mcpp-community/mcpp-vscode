# Editing `mcpp.toml`

The file named exactly `mcpp.toml` gets its own language id, `mcpp-toml` (see
`contributes.languages` in `package.json`), and two features: **structural completion** and
**structural diagnostics**. Both are pure text analysis — no `mcpp` process, no language server
— so they keep working in an untrusted workspace, which is what
`capabilities.untrustedWorkspaces.supported: "limited"` promises.

Formatting is **deliberately not offered**: no `DocumentFormattingEditProvider` or
`DocumentRangeFormattingEditProvider` is registered. This extension does not rewrite a file the
user owns.

## Completion

Registered in `src/toml/providers.ts` as a completion provider for `mcpp-toml`, triggered by
`[`. The suggestions are computed by `src/toml/completion.ts` from a tolerant parse of the
lines above the cursor (`contextAt` in `src/toml/parser.ts`).

| Cursor is | You get |
| --- | --- |
| On a section header | The 25 structural headers from the hand-maintained `SECTION_HEADERS` list |
| In a dependency section | The five dependency templates (`"version"`, `{ path = … }`, `{ git = …, tag = … }`, `{ version = …, features = […] }`, `{ version = …, tools = […] }`) |
| In `[features]` | The four feature templates (`[…]`, `{ defines = […] }`, `{ requires = […] }`, `{ sources = […] }`) |
| In `[generated_files]`, `[capabilities]`, `[xlings.workspace]`, `[tools.overrides]` | That section's writing template |
| Inside `[[…]]` | Nothing, on purpose — array tables are not mcpp's surface |
| In a value position | Nothing: values are not guessed |

What is **not** offered, in this build:

- **Key completion** inside a known section, and **enum value completion** (`standard`, `kind`,
  `linkage`, profile names, `[target.<cfg>]` selectors);
- **dependency version completion**. `mcpp.toml.indexCompletion` (default `false`) and
  `mcpp.toml.indexCompletionTimeoutSeconds` (default `20`) are declared in the registry, but no
  code reads them and nothing invokes `mcpp search`. It is designed, not implemented.

The section-header list is **not** derived from the snapshot below — it is a separate,
hand-maintained table. The two can drift; the snapshot is what the diagnostics use.

`mcpp.toml.completion` (default `true`) turns completion off. The old key
`mcpp.tomlCompletion` still works as a declared alias, but it is **not** read at runtime:
`src/extension.ts` reads `mcpp.toml.completion` only.

## Hover and navigation

`mcpp.toml.hover` (default `true`) and `mcpp.toml.navigation` (default `true`) are declared in
`data/config-registry.json` and appear in the settings panel, but **this build registers neither
a hover provider nor a definition provider for `mcpp-toml`**. The only providers registered for
that language are the completion provider and the diagnostic collection. The intended behaviour
— hovers with type/default/plane/since and `docs/04` links, and go-to-definition for
`workspace = true`, `path = "…"` and `features = […]` — is designed but not wired. Do not rely
on the settings having an effect yet.

## Diagnostics

`analyseManifest` in `src/toml/diagnostics.ts` is a **conservative TOML subset scanner**, not a
validator. It understands section headers, `key = value` lines, line comments, single- and
double-quoted strings, triple-quoted multi-line strings and arrays/inline tables that span
lines. Anything outside that subset is not reported — a missed diagnostic is preferred to a
wrong one.

Seven rules, each with a stable `code` (the diagnostic's `code`; `source` is `mcpp`):

| Rule | Code | Default severity | Setting |
| --- | --- | --- | --- |
| Obvious syntax breakage | `mcpp.manifest.syntax` | `error` | `mcpp.toml.diagnostics.syntax` |
| Section not in the snapshot | `mcpp.manifest.unknownSection` | `warning` | `mcpp.toml.diagnostics.unknownSection` |
| Key not in the snapshot for a known section | `mcpp.manifest.unknownKey` | `warning` | `mcpp.toml.diagnostics.unknownKey` |
| Key in the wrong plane (tool as dependency, package as tool) | `mcpp.manifest.planeSeparation` | `warning` | `mcpp.toml.diagnostics.planeSeparation` |
| `[package].mcpp` is not `">=<release>"` | `mcpp.manifest.mcppFloor` | `error` | none — fixed |
| Legacy section or key | `mcpp.manifest.legacyKey` | `info` | `mcpp.toml.diagnostics.legacyKeys` |
| Array table `[[…]]` | `mcpp.manifest.arrayTable` | `error` | none — fixed |

Every severity setting takes `error`, `warning`, `info` or `off`. `mcpp.toml.diagnostics.enabled`
(default `true`) is the master switch: when it is off, the collection is cleared. Diagnostics are
recomputed on open, on change, on close and on any configuration change.

The legacy markers themselves come from the snapshot: `[language]` is marked `deprecatedBy:
"[package].standard"`, and `build.static_stdlib`, `language.import_std`, `language.modules` and
`language.standard` are marked `legacy`.

`mcpp.floor` and array tables have no setting yet (see the comment in
`src/toml/diagnostics.ts`): they are always `error`. If the setting surface gains them, the
signature already accepts the fields.

## The snapshot

`data/toml-schema.json` is the single source of the section/key/enum vocabulary. This build
ships:

- `sourceVersion`: `2026.10.1.3`
- `sourceCommit`: `4d81d062`
- 30 sections across the manifest planes, with per-key `type`, `values`, `default`, `since`,
  `legacy`, `note`, `unmodelled` and a `doc` URL into mcpp's `docs/04-mcpp-toml.md`
- 7 rules with their default severities

`src/toml/schema.ts` reads it and exposes `sectionByHeader`, `sectionByName`, `keyOf` and
`schemaSource()`. `sectionProblems()` checks the snapshot's own shape (duplicate header, empty
plane, a `deprecatedBy` that names no known section) and is asserted by the tests.

It is generated by `tools/generate-toml-schema.mjs` from an mcpp checkout
(`MCPP_REPO`, default `../mcpp`) and committed, so the extension builds without that checkout.
`npm run check:generated` (`tools/check-generators.mjs`) regenerates both snapshots and fails on
any diff; with no checkout present it skips with a notice rather than passing silently.

## Settings that shape this page

| Key | Default | Read by this build |
| --- | --- | --- |
| `mcpp.toml.completion` | `true` | yes — `src/extension.ts` |
| `mcpp.toml.diagnostics.enabled` | `true` | yes |
| `mcpp.toml.diagnostics.syntax` | `error` | yes |
| `mcpp.toml.diagnostics.unknownSection` | `warning` | yes |
| `mcpp.toml.diagnostics.unknownKey` | `warning` | yes |
| `mcpp.toml.diagnostics.planeSeparation` | `warning` | yes |
| `mcpp.toml.diagnostics.legacyKeys` | `info` | yes |
| `mcpp.toml.hover` | `true` | **no** |
| `mcpp.toml.navigation` | `true` | **no** |
| `mcpp.toml.indexCompletion` | `false` | **no** |
| `mcpp.toml.indexCompletionTimeoutSeconds` | `20` | **no** |

Full descriptions, scopes and "when it applies": [settings.md](settings.md).
