# Troubleshooting

Start with the **mcpp** output channel (`View → Output → mcpp`) and then run
**mcpp: Environment Self-check** (`mcpp.selfCheck`). The self-check writes one copyable block to
that channel: extension/VS Code/platform, workspace trust and roots, the project root,
`mcpp.path` plus the `--protocol-version` probe (version, envelope, advertised `kinds`), the
mcppls version plus every capability's state (`available` / `unconfirmed` / `missing`), the
mcppls state summary, the last language-service refresh, and every setting whose effective value
differs from its default. Its `Cache` section reports the shared cache's size, entry count and
incomplete-entry count, read with the same bounded query the Cache view uses.

## The C++ Modules view says the dependency is missing

<a name="the-c-modules-view-says-the-dependency-is-missing"></a><a name="c-modules-视图提示依赖缺失"></a>

The view's first node reads `C++ Modules is not installed`. It appears when
`vscode.extensions.getExtension("sunrisepeak.mcpp-language-server")` is `undefined`, and its
command opens that extension's settings page (the view also uses it as an install entry point).

Because `extensionDependencies` is a **hard** dependency, on a supported platform the extension
should not activate at all without mcppls — see the platform matrix in
[compatibility.md](compatibility.md). So this node is normally only reachable if mcppls was
disabled after activation, or on a platform where no package exists.

1. Confirm it is installed and enabled:
   `code --list-extensions --show-versions | grep mcpp-language-server`.
2. Confirm the platform has a package ([compatibility.md](compatibility.md#platform-matrix)).
3. If the tree says `· disabled here`, `mcppls.enable` is `false` for this workspace. That
   value is read-only for this extension; change it with mcppls's own command
   (`mcpp.languageServer.toggleInWorkspace`) or its Settings page.

## The language service stays on "no status yet"

<a name="the-language-service-stays-on-no-status-yet"></a><a name="语言服务一直停在暂无状态"></a>

The Status node shows the state's `reason` instead of a state. Reading mcppls's state goes
through the object its `activate()` returned (its internal `TestApi`), which is a
**best-effort channel, not a contract**. `readStateFromExports` returns `available: false`,
with a reason, whenever the exports are not an object, `lastStatus` is not a function, the call
throws, or the returned `state` is not one of `starting`, `loading`, `preparing`, `ready`,
`degraded`, `error`.

- The reason string is written to the `mcpp` output channel; read it there.
- `mcpp: Environment Self-check` prints the same state plus the capability table.
- `mcpp.languageService.readState` (default `true`) and
  `mcpp.languageService.stateRefreshSeconds` (default `0`) are declared but **not read** in this
  build: turning the first off does not stop the read, and setting the second does not add a
  timer. There is no polling either — the view is refreshed by
  `mcpp.languageServer.refreshState`, by `vscode.extensions.onDidChange`, and by a configuration
  change to `mcppls.enable` or `mcpp.views.languageServer`.
- The view stays usable: when the state is unavailable it still lists every action that
  forwards to mcppls.

## A command reports it is not offered

<a name="a-command-reports-it-is-not-offered"></a><a name="命令提示该操作不被提供"></a>

The message is `…: the installed C++ Modules does not offer this action.`, followed by the
capability's own `degradedHint`. It means the probe classified the capability as `missing`:
either the id was absent from mcppls's declared `contributes.commands` (static read), or the
first real call failed with a `command '…' not found`-style error. The candidate chain is tried
once, then the result is remembered for the session.

1. `mcpp: Environment Self-check` lists every capability as `available`, `unconfirmed` or
   `missing` — that is the fastest way to see what the installed version actually offers.
2. Compare the mcppls version in the same block with the one this build was written against
   (`>=0.0.4`). The version only produces a notice; the real judge is the capability probe.
3. Update mcppls. Nothing you can set in `mcpp.*` brings a missing command back.

Note that `mcppls.review.run` and `mcppls.review.clear` are **server-advertised** commands: they
exist only while the language server is running, so they can be reported as unoffered before
the server starts. That is expected.

## mcpp cannot be found

<a name="mcpp-cannot-be-found"></a><a name="找不到-mcpp"></a>

When `mcpp.path` is empty the extension runs the literal executable name `mcpp`, resolved on the
`PATH` of the **VS Code process**. On macOS a VS Code launched from the Dock or Finder often has
a different `PATH` than a terminal.

- Set `mcpp.path` to the absolute executable, for example `/opt/homebrew/bin/mcpp`, then
  re-run the command. The setting is per-folder (scope `resource`).
- The `mcpp` output channel shows the exact `$ <path> <args>` line, the captured stdout/stderr
  and `[exit N]` for every short command; a task's argv and exit code are logged too.
- `mcpp.path` affects **this extension's CLI calls only**. mcppls finds mcpp by itself, in the
  order `PATH` → `$HOME/.mcpp/bin/mcpp` → `$HOME/.xlings/subos/current/bin/mcpp`, behind its own
  non-user-visible `mcppls.mcpp` setting. If the two disagree, both output channels will show
  it.
- On an untrusted workspace every mcpp command refuses with a warning. Trust the folder first
  (`Workspaces: Manage Workspace Trust`). The `mcpp.toml` and `build.mcpp` text features are
  pure text analysis and keep working regardless.

## A build finished but the language service did not refresh

<a name="a-build-finished-but-the-language-service-did-not-refresh"></a><a name="构建结束了但语言服务没有刷新"></a>

After a `build` task that was not cancelled, this extension always asks mcppls to re-read the
build description, using the candidate chain `mcppls.reloadBuildDescription` →
`mcppls.restartServer`, single-flight so two builds cannot restart the server twice. `run`,
`test` and `clean` deliberately do not touch it.

1. Read the `[C++ Modules] …` line the channel just got. If the refresh was degraded, the
   channel says so and offers no retry.
2. Manual paths, in increasing weight: **mcpp: Refresh the Module Build Description**
   (`mcpp.refreshCompilationDatabase`, which runs the `build` task and then refreshes),
   **C++ Modules: Restart the Language Server** (`mcpp.languageServer.restart`), then
   **C++ Modules: Reset This Workspace's Cache** (destructive, modal).
3. `mcpp.languageService.refreshAfterBuild` is declared but **not read** in this build, so
   choosing `off` there does not stop the refresh.
4. A failed build still triggers a refresh on purpose, so mcppls can show the last usable
   description as `degraded`. If the build itself failed, fix that first.

## The cache figures are stale

<a name="the-cache-figures-are-stale"></a><a name="缓存数字看起来是旧的"></a>

There is no automatic refresh timer in this build: `mcpp.cache.autoRefreshSeconds` is declared
but not read. The view re-reads when you run **mcpp: Refresh Cache Statistics**, when it is
painted for the first time, and when `mcpp.cache.*` or `mcpp.views.cache.*` changes.
`target/` sizes are a bounded file-system estimate, never mcpp's own accounting, and the
pre-v1 cache node does not render because no size is measured for it. Details and the
authoritative "what is stale" source: [cache.md](cache.md).

## Nothing above helped

- **mcpp** output channel — the full transcript, including the argv and exit code of every
  command.
- **mcpp: Environment Self-check** — the snapshot to paste into an issue.
- The exit-code contract (`0` success, `1` failed, `2` usage, `4` environment not ready, `70`
  internal, `101` `mcpp run` build failure, `127` unknown command) is implemented in
  `src/cli/errors.ts`, but in this build the UI does not branch on it: you get the raw exit code
  in the channel rather than a per-code explanation.
- Report at <https://github.com/mcpp-community/mcpp-vscode/issues> with the self-check block.
