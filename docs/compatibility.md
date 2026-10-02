# Compatibility

This extension has a hard dependency on `sunrisepeak.mcpp-language-server` (display name
**C++ Modules Language Server**, "mcppls" below), and it never reimplements that extension's
behaviour. This page records the platform matrix, the dependency mechanics, the commands that
were actually checked, and how the capability probe degrades.

## Platform matrix

| Platform | mcppls VSIX | This extension |
| --- | --- | --- |
| `linux-x64` | yes | activates |
| `linux-arm64` | yes | activates |
| `darwin-arm64` | yes | activates |
| `win32-x64` | yes | activates |
| `darwin-x64` | **no package** | does not activate |
| `win32-arm64` | **no package** | does not activate |

The matrix comes from mcppls's `packaging/release.manifest.json` and is cross-checked on the
mcppls side in four places (its devtools, `payload.lock.json`, `editors/vscode/src/payload.ts`
`SUPPORTED_PLATFORMS`, and its CI matrix). mcppls validates its own payload at load time:
`manifest.platform` must equal `${process.platform}-${process.arch}`.

## What `extensionDependencies` does and does not give us

```json
"extensionDependencies": ["sunrisepeak.mcpp-language-server"]
```

- **Install**: on a supported platform VS Code resolves and installs the matching mcppls
  package automatically — the user does nothing.
- **Upgrade**: mcppls upgrades independently; this extension immediately uses whatever is
  installed, with no reinstall.
- **No version range is possible.** The field accepts an extension id and nothing else. There is
  no lower bound, no upper bound, and **no install-time compatibility check**. That is why
  capability probing exists instead of a version gate.
- The dependency is **one-way**: mcppls declares no `extensionDependencies` on this extension.
- mcppls's diagnostic report reads this extension's `packageJSON.version` as environment
  information, and mcppls excludes it from its "conflicting C++ extension" candidates. That is
  mcppls's one-way knowledge of us, not a compatibility guarantee.

`src/mcppls/contract.ts` also exports `VERIFIED_MCPPLS_RANGE = ">=0.0.4"`, the range this build
was written against. In this build the constant is **not read by any production code** — no
comparison, no notice. The judge is the capability probe, not a version number: a version
cannot predict a rename.

## Unsupported platforms

`extensionDependencies` is resolved by VS Code when the extension is installed and again when it
is activated. On `darwin-x64` or `win32-arm64` there is no mcppls package to resolve, so **this
extension is not activated at all** — it does not activate and then report `unavailable`. VS
Code surfaces the unresolved dependency itself.

Caveat, from `.agents/docs/mcppls-integration.md`: this behaviour should be re-confirmed with a
clean `extensions/` directory, including an offline install, before a release, and the result
recorded there. It is a stated expectation, not a tested one in this build.

## The commands that were checked

Four mcppls commands are the original coupling surface, referenced by
`src/mcppls/contract.ts` and exercised by the tests:

| mcppls command | Used for |
| --- | --- |
| `mcppls.selectContext` | `mcpp.configureLanguageServer`, `mcpp.languageServer.selectContext` |
| `mcppls.restartServer` | `mcpp.checkModuleSupport`, `mcpp.languageServer.restart`, the post-build refresh fallback |
| `mcppls.showModuleGraph` | `mcpp.showModuleGraph`, `mcpp.languageServer.showModuleGraph` |
| `mcppls.showLogs` | `mcpp.showLanguageServerLogs`, `mcpp.languageServer.showLogs` |

**These ids are not a documented cross-extension API.** They are mcppls's own UI commands and
may change between versions. The only guard is this repository's tests.

A second batch of commands (restart clangd, reset the workspace cache, collect a report, export a
diagnostic bundle, run the build tool in a terminal, conflict handling, per-workspace
enable/disable, install command-line tools, review changes) is forwarded with the same mechanics
and the same caveat — see [commands.md](commands.md#c-modules) for the full table and the
confirmation each one requires.

## Commands we must not register

mcppls's S3 specification (S3-5.6-3) says a client **MUST NOT** register a command id the server
advertises, because `vscode-languageclient` registers one VS Code command per advertised id and
a duplicate stops the language client from starting. So:

- every id this extension contributes starts with `mcpp.`, never `mcppls.`;
- we do not "fill in" a missing refresh command such as `mcppls.reloadBuildDescription`: it is
  already in the server's advertised list.

The server's advertised ids include `mcppls.review.run`, `mcppls.review.clear`,
`mcppls.reloadBuildDescription`, `mcppls.describeOnline`, `mcppls.restartEngine`,
`mcppls.exportBundle` and `mcppls.resetCache`. Some have a paired extension-side command with a
different name (`mcppls.restartClangd`, `mcppls.exportDiagnosticBundle`,
`mcppls.resetWorkspaceCache`).

## How the probe degrades instead of breaking

`src/mcppls/capabilities.ts` probes on two levels, deliberately:

- **Static** — `getExtension(id)?.packageJSON.contributes.commands`. Zero side effects; it never
  calls anything, because most of these commands open a picker or a panel. It is re-read on
  `vscode.extensions.onDidChange`. A command the static read cannot confirm is **greyed out, not
  hidden**, so a wrong read cannot remove a feature. `commands.getCommands()` is not used:
  whether it lists a contributed-but-unactivated command is not guaranteed.
- **Runtime** — the first real use calls the command once and classifies the error
  (`command '…' not found`-style messages become `missing`). Only then is the capability hidden,
  and the degraded hint is written once. A failure that is not "not found" is a failure of that
  one call and removes nothing.

`readState` is separate: it does not use a command at all, but the object mcppls's `activate()`
returned, guarded by a shape check and `try/catch`. Anything unexpected becomes
`available: false` with a reason — the view simply shows less.

Invariants the tests assert:

1. **A failing mcppls never turns a successful `mcpp build` into a failure.** The refresh result
   is reported separately; a build's success is decided by the task's exit code alone.
2. **A missing capability never disables an mcpp feature.** Every entry in the capability table
   has `required: false`, and `capabilityProblems()` fails if one is marked required.
3. **A broken `readState` leaves the view usable** — it keeps its status line, its identity and
   all forwarding actions.
4. `deactivate()` leaves no dangling promise (VS Code disposes what `activate()` registered).

## What this extension reads and writes on the mcppls side

- Reads `mcppls.enable` (default `true`) to show `· disabled here`. **Read-only.**
- Writes **no** `mcppls.*` setting, ever. Two commands change mcppls state
  (`mcppls.turnOnInWorkspace` / `turnOffInWorkspace`), but they are mcppls's own and only run
  when the user triggers them.
- Does not read or parse mcppls's cache directories, model files or logs — that layout is an
  internal implementation detail.
- Does not create an LSP client. There is no `vscode-languageclient` dependency; CI asserts the
  packaged extension contains none.

Background and the reasoning for each integration decision:
`.agents/docs/mcppls-integration.md`. What mcpp itself promises and does not promise:
`.agents/docs/mcpp-integration.md`.
