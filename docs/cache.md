# Cache and cleanup

Two different things share the word "cache" here:

- the **project artifacts** under `<project>/target/`, which only this project uses;
- the **shared build cache** mcpp keeps for the whole machine (packages and standard-library
  module entries), which every mcpp project reads.

The view is `mcpp.cache` in the `mcpp` container. Its refresh is manual
(`mcpp.refreshCacheStats`); `mcpp.cache.autoRefreshSeconds` is declared but not read, so there
is no timer. All cache commands require a trusted workspace — in a restricted workspace the
view shows `the workspace is not trusted` and the commands refuse.

## Reading the numbers

| Command | Document | How it is parsed |
| --- | --- | --- |
| `mcpp cache list --format json` | An envelope with `kind: "mcpp.cache"`: `data.root` plus `data.entries[]` of `{accessed, bytes, complete, dir, files, key, kind, label}` | Strictly. A foreign `kind`, a non-JSON body or a bad shape is rejected outright, not partially believed |
| `mcpp cache dir` | Human text: the root, then an optional `legacy (unused, removable with \`mcpp cache clean --legacy\`): <path>` line | Leniently; only the last `": "` on the legacy line is treated as a path, so the backticked command is never mistaken for one |
| `<root>/target` | The file system | `estimateArtifacts` walks it (see below) |
| `mcpp cache info <package>` | Human text | **Not parsed at all** — shown verbatim in a preview document |
| `mcpp cache verify` | Human text plus the exit code | Shown verbatim in a preview document |

A broken entry is dropped rather than thrown, and an entry with no `complete: true` counts as
incomplete. Entries without a usable `accessed` timestamp are left out of the age histogram and
out of the oldest/newest figures instead of being guessed at.

### `target/` is always an estimate

mcpp documents the contents of `target/` as **not an interface**: the layout may change without
notice. So this extension never parses mcpp's fingerprints and never decides which artifacts are
stale. It walks `<root>/target` with `estimateArtifacts` (`src/cli/artifacts.ts`):

- a bounded budget of 200,000 entries and depth 6, so a hostile or huge tree cannot hang the
  extension host; `truncated: "entries"` or `"depth"` is reported and the figure is then a
  **lower bound**;
- symlinks are counted as zero-byte entries and never followed (a link to an ancestor would
  loop); fifos, sockets and devices count as zero;
- unreadable directories are tolerated and a raced `mcpp clean` cannot throw;
- a symlinked or missing `target/` reports as absent.

The authoritative answer to "what would be removed" is always **`mcpp clean --dry-run`**, which
the stale-artifact command runs and shows. `mcpp.views.cache.topN` (default 5) and
`mcpp.views.cache.ageBuckets` (default `["1d","7d","30d"]`) shape the tree; the buckets accept
`h`, `d`, `w` and `m` suffixes, and unparsable entries are dropped.

## The two project levels

`src/cli/clean.ts` owns both, as data.

| Level | Button | argv | Semantics |
| --- | --- | --- | --- |
| **L1** Clean Project Artifacts | `mcpp.cleanProjectArtifacts` | `mcpp clean` | Deletes the whole `target/` directory; the next build starts from scratch. The shared cache is untouched |
| **L2** Clean Stale Artifacts | `mcpp.cleanStaleArtifacts` | `mcpp clean --stale --older-than <N>d` | Removes only the build directories mcpp no longer considers current, keeping the last `N` days |

`N` is `mcpp.cache.staleDays` (default `3`, applied on the next clean; `0` means keep none). It
is always written explicitly so the result does not depend on mcpp's own default. `mcpp clean` is
explicitly **not** given `--bmi-cache` by either level; emptying the shared cache is a separate
second button in the L1 dialogue (`withSharedCache`), which escalates the plan to level 3 with a
second acknowledgement. The classic `mcpp.clean` command (a VS Code task) is separate and never
touches the shared cache either.

## Every action and its argv

| Command | argv | Level |
| --- | --- | --- |
| `mcpp.refreshCacheStats` | `cache list --format json`, `cache dir` | read-only |
| `mcpp.showCachePanel` | none (refreshes, then shows a summary) | read-only |
| `mcpp.showCacheEntry` | `cache info <package>` | read-only |
| `mcpp.verifyGlobalCache` | `cache verify` | read-only |
| `mcpp.gcGlobalCache` | `cache gc --max-size <n>GiB` | preview + modal |
| `mcpp.pruneGlobalCache` | `cache prune --older-than <n>d` | preview + modal |
| `mcpp.cleanStaleArtifacts` | `clean --dry-run`, then `clean --stale --older-than <n>d` | preview + modal |
| `mcpp.cleanLegacyCache` | `cache clean --legacy` | modal |
| `mcpp.cleanProjectArtifacts` | `clean` (optionally `clean --bmi-cache`) | modal (escalated option: modal + acknowledgement) |

`cache gc`'s budget comes from `mcpp.cache.gc.defaultBudgetGiB` (default `0`, which means "ask");
when it is `0` the input box suggests half the current size. Before asking, the extension runs a
**local LRU projection** (`projectGc` in `src/util/format.ts`) and shows
`About <size> would be freed (<n> entries).` That is an estimate: mcpp's own LRU also weighs
entry completeness and its own bookkeeping, so the command's output is what actually happened.
`mcpp prune`'s default age is `mcpp.cache.pruneAgeDays` (default 30, never below 1).

There is **no per-package delete**. mcpp's `cache clean` only accepts `--deps`, `--std`, `--all`
and `--legacy`, so a top-label row opens `cache info` instead of pretending such a command
exists.

## The five confirmation levels

`confirmPlan` in `src/views/cacheView.ts` implements the policy from `planClean`. Nothing
destructive ever runs itself; every path goes through the plan, an optional preview and a modal.

| # | Behaviour | Used by |
| --- | --- | --- |
| 1 | No prompt | `cache list`, `cache verify` (level 0) |
| 2 | One modal, whose text names what goes and what does not | `mcpp clean` / L1 (level 1) |
| 3 | A preview first, then the modal | L2 stale, `cache gc`, `cache prune`, `cache clean --deps`, `cache clean --std` (level 2) |
| 4 | Modal only, no preview — nothing is rebuilt because nothing reads the pre-v1 cache | `cache clean --legacy` (level 2, no preview by design) |
| 5 | A preview, the modal, then a **second, explicit acknowledgement** ("I understand this affects every mcpp project on this machine") | `cache clean --all`; and the escalated `clean --bmi-cache` (level 3) |

`planProblems()` asserts the policy has no holes (every plan requires trust; every level-2+
plan except legacy is previewed; every level-3 plan acknowledges), and
`test/cli/clean.test.ts` pins it. `mcpp.cache.gc.confirmAboveGiB` (default `1`) is declared but
**not read** in this build, so a gc that would free more than a gigabyte gets the same
preview-then-modal treatment as any other gc, not an extra confirmation.

## What a preview shows

`mcpp.showCachePanel` opens the **webview panel** (`src/views/cachePanel.ts`); its own budget
simulator is a *local LRU projection*, and the panel says so — mcpp's policy decides in the end
panel — via `workspace.openTextDocument({ content, language: "markdown" })` and
`showTextDocument(…, { preview: true, preserveFocus: true })`. The content is a `# title` and a
fenced block holding the command's raw stdout (or stderr when stdout is empty), trimmed. So:

- `mcpp clean --dry-run` — mcpp's own list of what L2 would remove;
- `mcpp cache verify` — the verification report, or `Every entry matches its manifest.` when
  there is no output;
- `mcpp cache info <package>` — the command's output verbatim;
- `mcpp.showCachePanel` — a generated Markdown summary (`cacheSummaryText`) of the project
  estimate, the shared cache totals per `kind`, the incomplete count and the largest labels.

The summary numbers are formatted with `formatBytes` (binary units, three significant digits)
and `formatCount`; `mcpp.ui.numberFormat` is declared but not read, so decimal units are not
selectable yet.

## Known gaps in this build

- The **pre-v1 cache** node renders only when a byte count is known. `mcpp cache dir` is run and
  its `legacyPath` is stored, but no size is measured, so the node does not appear;
  `mcpp.cleanLegacyCache` is reachable from the Command Palette. `mcpp.cache.showLegacy` is
  declared but not read.
- No byte total is shown per project in the status bar: `mcpp.cache.statusBar` and
  `mcpp.cache.warnAboveGiB` are declared but not read.
- `mcpp.views.cache.show` is declared but the view has no `when` clause, so it is always
  present.

Full setting descriptions: [settings.md](settings.md). The mcpp side of these commands:
`.agents/docs/mcpp-integration.md`.
