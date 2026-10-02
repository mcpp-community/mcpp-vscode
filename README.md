<p align="center">
  <img src="images/logo.png" width="160" alt="mcpp logo">
</p>

# mcpp for VS Code

English | [简体中文](README.zh-CN.md)

The VS Code front end for the [mcpp](https://github.com/mcpp-community/mcpp) C++23 build tool:
project discovery, `mcpp build` / `run` / `test` / `clean` as VS Code tasks, toolchain
management, `mcpp.toml` and `build.mcpp` editing help, and cache views with graded cleanup. C++
module semantics — diagnostics, completion, hover, definitions, references, the module graph —
come from `sunrisepeak.mcpp-language-server`; this extension never starts an LSP client itself.

## Responsibility split

| Area | Owner |
| --- | --- |
| mcpp CLI, project discovery, build/run/test/clean tasks, toolchains | mcpp-vscode |
| `mcpp.toml` and `build.mcpp` editing, cache views and cleanup commands | mcpp-vscode |
| Settings registry, settings panel, environment self-check, `mcpp` output channel | mcpp-vscode |
| C++ module diagnostics, completion, hover, definitions, references, module graph, cache reset, its own clangd/status item/output channel | `sunrisepeak.mcpp-language-server` |

The C++ Modules view here only **displays** the other extension's state and **forwards** its
commands. Details: [docs/architecture.md](docs/architecture.md).

## Install

Download the VSIX from
[GitHub Releases](https://github.com/mcpp-community/mcpp-vscode/releases) and use
**Extensions: Install from VSIX...**, or
`code --install-extension mcpp-vscode-0.5.0.vsix`.

`package.json` declares `extensionDependencies: ["sunrisepeak.mcpp-language-server"]`, so VS
Code installs that extension automatically where a package exists. Only an extension id fits
there — no version range can be pinned ([docs/compatibility.md](docs/compatibility.md)).

| Platform | mcppls package | This extension |
| --- | --- | --- |
| `linux-x64`, `linux-arm64`, `darwin-arm64`, `win32-x64` | yes | yes |
| `darwin-x64`, `win32-arm64` | no package | not activated |

## Quick start

1. Open a folder containing an `mcpp.toml` (or run **mcpp: New Project**).
2. Run **mcpp: Build** (`mcpp.build`); it runs in a dedicated task terminal.
3. Open the **mcpp** activity-bar container and watch **Project**, **Cache** and **C++ Modules**.

Opening a project never runs `mcpp` on its own and never downloads a toolchain.

## Features

- **mcpp CLI and tasks** — build, run, test, clean, quick menu, toolchains: [docs/commands.md](docs/commands.md).
- **`mcpp.toml` editing** — structural completion plus seven structural diagnostics: [docs/mcpp-toml.md](docs/mcpp-toml.md).
- **`build.mcpp` intelligence** — completion, hovers, seven SPEC-007 diagnostics, never a spurious "module not found": [docs/build-script.md](docs/build-script.md).
- **Cache views and cleanup** — project artifacts and the shared cache, previewed first: [docs/cache.md](docs/cache.md).
- **C++ Modules view** — the other extension's state and actions, forwarded not reimplemented: [docs/commands.md](docs/commands.md).
- **Settings and diagnostics** — a registry-backed settings panel and a copyable self-check: [docs/settings.md](docs/settings.md).

## Commands

Every contributed command id, with its title key and behaviour, is in
[docs/commands.md](docs/commands.md). The common ones:

| Command id | What it does |
| --- | --- |
| `mcpp.showMenu` | Project, toolchain, cache and C++ Modules actions in one picker |
| `mcpp.build` / `run` / `test` / `clean` | Runs the matching mcpp task |
| `mcpp.installToolchain`, `mcpp.selectDefaultToolchain` | Delegates to the mcpp CLI |
| `mcpp.openSettings` | The extension's own settings panel |
| `mcpp.showCachePanel`, `mcpp.cleanStaleArtifacts`, `mcpp.cleanProjectArtifacts` | Cache summary and the two project cleanup levels |
| `mcpp.languageServer.restart`, `mcpp.selfCheck` | Forward to the other extension; bug-report snapshot |

## Settings

All 64 settings, with type, default, scope and when they apply, are in
[docs/settings.md](docs/settings.md). The panel (**mcpp: Open Settings Panel**, `mcpp.openSettings`)
groups them, shows the effective value and its source, and links to the native editor; it does
not replace it. Several declared settings are not read at runtime yet; each page below names the
ones that matter to it.
`mcpp.ui.language` overrides **our** messages and panels only; Command Palette titles and setting names always follow VS Code, which resolves `package.nls.*` once at startup ([docs/architecture.md](docs/architecture.md#language)).

## Editing `mcpp.toml` / `build.mcpp`

`mcpp.toml`: completion on `[` and seven diagnostics (syntax, unknown section, unknown key,
plane separation, `mcpp` floor, legacy keys, array tables), no formatting. Hover and
go-to-definition are declared in the registry but not wired in this build —
[docs/mcpp-toml.md](docs/mcpp-toml.md).

`build.mcpp`: completion for `mcpp::…` and `import`, hovers for known modules, seven SPEC-007
diagnostics. Imports of `std`, `std.compat` and `mcpp.*` are never reported missing; there is
no symbol-level completion inside them — [docs/build-script.md](docs/build-script.md).

## Troubleshooting

- [The C++ Modules view says the dependency is missing](docs/troubleshooting.md#the-c-modules-view-says-the-dependency-is-missing)
- [The language service stays on "no status yet"](docs/troubleshooting.md#the-language-service-stays-on-no-status-yet)
- [A command reports it is not offered](docs/troubleshooting.md#a-command-reports-it-is-not-offered)
- [mcpp cannot be found (`mcpp.path` vs `PATH`)](docs/troubleshooting.md#mcpp-cannot-be-found)
- [A build finished but the language service did not refresh](docs/troubleshooting.md#a-build-finished-but-the-language-service-did-not-refresh)

Look first at the **mcpp** output channel, then **mcpp: Environment Self-check**
(`mcpp.selfCheck`). More: [docs/troubleshooting.md](docs/troubleshooting.md).

## Development

`npm ci`, `npm run compile`, `npm test`, `npm run test:e2e`, `npm run package`, and
`node tools/dev-profile.mjs` for a throwaway profile under `.dev-profile/` that never touches
your real one. `npm test` runs `npm run check` first — `tools/check-config.mjs`,
`tools/l10n-check.mjs` and `tools/check-generators.mjs` — then `node --test` over `dist/test`.
The snapshot drift gate skips with a notice when no mcpp checkout is present at `MCPP_REPO`
(default `../mcpp`).

Release: bump the version in `package.json` and `package-lock.json`, commit, then push a tag
matching the version exactly. `.github/workflows/release.yml` validates the tag, runs the
tests, packages the VSIX, writes a SHA-256 file and creates the GitHub Release.

## License

Apache-2.0 — see [LICENSE](LICENSE).
