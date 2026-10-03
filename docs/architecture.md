# Architecture

How this repository is put together, and which file is the single source of truth for what.

The extension is a thin VS Code assembly layer (`src/extension.ts`) over a set of **pure**
modules: project discovery, TOML/build-script text analysis, cache aggregation, the mcppls
capability table and command-id tables. Nearly everything can be exercised by `node --test`
without an Extension Host, and the parts that cannot are small.

## Module layout

| Directory | What lives there | Touches `vscode` |
| --- | --- | --- |
| `src/extension.ts` | The only assembly point: `activate` / `deactivate` | yes |
| `src/commands/` | Command ids (`ids.ts`) and the quick-menu table (`menu.ts`) | no |
| `src/config/` | Settings registry access, validation, the settings panel, presets | `access.ts`, `panel.ts`, `migrate.ts` |
| `src/cli/` | mcpp process runner, protocol probe, tasks, toolchain parsing, cache/cleanup plans, artifacts walk, self-check text | `controller.ts` |
| `src/projects/` | `mcpp.toml` discovery, the `mcpp.inProject` context key, the manifest summary | no |
| `src/toml/` | Tolerant TOML parser, snapshot reader, structural completion, diagnostics | `providers.ts` |
| `src/buildscript/` | `build.mcpp` API snapshot, known modules, static analysis | `providers.ts` |
| `src/mcppls/` | The mcppls contract, capability probe, state normaliser, bridge | `stateSource.ts` |
| `src/views/` | Tree models as data, the shared tree provider, the three views | `treeProvider.ts`, `projectView.ts`, `cacheView.ts`, `languageServerView.ts` |
| `src/i18n/` | Runtime string resolution (`t.ts`) and the pure resolver (`translate.ts`) | `t.ts` |
| `src/util/` | Byte/count formatting, text truncation | no |
| `src/workflows/` | The build-then-refresh state machine | no |

`test/` mirrors `src/` and the directory names match, so a failing test names its module.

## The purity rule

A module that does not import `vscode` runs under plain `node --test`, cannot touch the editor
by accident, and is the place to put a decision. The `vscode`-touching modules are exactly:

`src/extension.ts`, `src/cli/controller.ts`, `src/config/{access,panel,migrate}.ts`,
`src/i18n/t.ts`, `src/mcppls/stateSource.ts`, `src/toml/providers.ts`,
`src/buildscript/providers.ts`, `src/views/{treeProvider,projectView,cacheView,languageServerView}.ts`.

Two rules follow from that:

- a policy (which argv, how much confirmation, which severity) belongs in a pure module —
  `src/cli/clean.ts` is the model: it owns the whole cleanup danger table so a UI change cannot
  quietly add a sixth level of danger;
- a `vscode`-touching module should only translate a decision into API calls, not make it.

CI also asserts the boundary that matters most: the packaged extension contains no
`vscode-languageclient` and no second language client (`test ! -e dist/src/languageClient.js`
plus a `rg` check in `.github/workflows/ci.yml`).

## Single sources of truth

| Fact | Source | Read by |
| --- | --- | --- |
| Every setting | `data/config-registry.json` | `src/config/registry.ts`, `tools/check-config.mjs`, `tools/generate-settings-docs.mjs` |
| Setting labels | `package.nls.json` / `package.nls.zh-cn.json` | VS Code, at startup |
| Runtime strings (Chinese) | `data/i18n/zh-cn.json` | `src/i18n/t.ts`, `tools/generate-l10n.mjs` |
| Runtime strings VS Code reads | `l10n/bundle.l10n*.json` (generated, do not edit) | `vscode.l10n.t` under `mcpp.ui.language: auto` |
| `build.mcpp` API | `data/buildscript-api.json` (generated) | `src/buildscript/api.ts` |
| `mcpp.toml` shape | `data/toml-schema.json` (generated) | `src/toml/schema.ts` |
| Command ids | `src/commands/ids.ts` | the manifest is held to it by `test/artifacts.test.ts` (command list, view ids, colour ids) and `test/commands/ids.test.ts` |

The two generated snapshots come from an mcpp checkout and are committed, because the extension
must build without that checkout. Regenerate them with `npm run gen:buildscript` and
`npm run gen:toml` (`MCPP_REPO`, default `../mcpp`).

`package.json`'s `contributes.configuration` is **hand-written**, not generated: rewriting a
several-hundred-line manifest on every change would produce an unreviewable diff. It is held to
the registry semantically instead.

## Language

Two independent paths decide which language you see, and they cannot be made to agree:

- **VS Code's own strings** — command titles, setting names and descriptions, deprecation
  messages — come from `package.nls.json` / `package.nls.zh-cn.json`, which VS Code resolves
  **once at startup** from its display language. Nothing this extension does at runtime can
  change them.
- **Our runtime strings and our panels** — resolved by `src/i18n/t.ts`. With
  `mcpp.ui.language: "auto"` (the default) it calls `vscode.l10n.t(english)`, which reads
  `l10n/bundle.l10n.<locale>.json` (generated from `data/i18n/zh-cn.json`) and falls back to the
  English text passed in. With `"en"` or `"zh-cn"` it reads our own bundle directly, so the
  escape hatch works even when the editor is in a third language.

The convention is that **the English text is the key**: a missing translation degrades to
readable English, never to an identifier. `tools/l10n-check.mjs` fails the build when a new
`t("…")` literal has no entry in `data/i18n/zh-cn.json`, and when the two `package.nls.*` files
have different key sets.

The deliberate consequence: a user on a Chinese VS Code who sets `mcpp.ui.language` to `en`
sees Chinese setting names and English notifications. That mixture is the documented behaviour
of the escape hatch, not a bug. Note also that the migration is **partial in this build**: many
strings in `src/cli/controller.ts` and `src/extension.ts` (task completion messages, blocked
states, toolchain prompts) are still hardcoded Chinese and never go through `t()` at all. They
do not follow `mcpp.ui.language`, and on an English VS Code they are shown as-is.

A note on the two directory names, because they look like synonyms and are not:

| Layer | Lives in | What it is |
| --- | --- | --- |
| Our runtime strings | `src/i18n/` (`t`, `translate`) + `data/i18n/zh-cn.json` | The `t()` lookup table, switchable at runtime by `mcpp.ui.language` — i18n in the sense that the engineering keeps every string adaptable |
| VS Code's manifest strings | `l10n/bundle.l10n.*.json` (generated from `package.nls*`) | What VS Code itself localizes — l10n proper, resolved once at startup; the `l10n/` directory name is a platform convention and cannot be renamed |

## The gates

| Gate | Command | Checks |
| --- | --- | --- |
| Config | `npm run check:config` (`tools/check-config.mjs`) | registry shape; that `package.json` has exactly the registry's keys with the same type, default, enum, scope, bounds and `%key%` references; that `package.nls.json` carries `<key>.title`, `<key>.description` and any `deprecationMessage`, matching the registry text |
| Localisation | `npm run check:l10n` (`tools/l10n-check.mjs`) | every `t("…")` literal in `src/**` has a `data/i18n/zh-cn.json` entry; `package.nls.json` and `package.nls.zh-cn.json` have identical key sets; every `%key%` in `package.json` resolves |
| Snapshots | `npm run check:generated` (`tools/check-generators.mjs`) | regenerates `data/buildscript-api.json` and `data/toml-schema.json` and fails on any diff; **skips with a notice** when there is no mcpp checkout |
| Docs | `npm run gen:docs` (`tools/generate-settings-docs.mjs`) | regenerates `docs/settings.md`; the stated drift check is `npm run gen:docs` then `git diff --exit-code` |
| Tests | `npm test` | runs `npm run check`, compiles, then `node --test "dist/test/**/*.test.js"` |
| Extension Host | `npm run test:e2e` | activates the extension against the `test/e2e` fixtures |

`npm test` runs the three checks as one step (`npm run check`), so a manifest/registry
mismatch, an untranslated runtime string or a stale snapshot fails before any test runs.

## Where a change goes

- A new setting: add it to `data/config-registry.json`, add the property to
  `contributes.configuration`, add the three `package.nls*` entries, then
  `npm run gen:docs`. `check-config` will tell you what is missing.
- A new command: add the id to `src/commands/ids.ts`, contribute it in `package.json` with a
  `%command.<id>.title%` placeholder, register it, and add both `package.nls*` strings.
  **Never** use an `mcppls.` id — see [compatibility.md](compatibility.md#commands-we-must-not-register).
- A new runtime string: use `t("English text", …)`, then add the Chinese entry to
  `data/i18n/zh-cn.json` (or `l10n-check` fails).
- A new user-facing page: `docs/`, written so that every relative link resolves in the
  repository.

`docs/` is excluded from the VSIX by `.vscodeignore`, so these links work on GitHub and in the
repository but not inside an installed extension.
