<p align="center">
  <img src="media/logo.png" width="160" alt="mcpp logo">
</p>

# mcpp for VS Code

English | [简体中文](README.zh-CN.md)

> **This repository is superseded by [mcpp-ide](https://github.com/mcpp-community/mcpp-ide).**
> The extension keeps its identity (`mcpp-community.mcpp-vscode`) and is built from
> [mcpp-ide/vscode](https://github.com/mcpp-community/mcpp-ide/tree/main/vscode) from version 1.0.0 on:
> one backend, `mcpp-ide serve`, answers VS Code and CLion alike, and the extension carries it as one
> ok-image bundle for every system. Issues and pull requests belong there; 0.9.0 is the last release
> built from this repository, which is kept read-only for its history.

The VS Code front end for the [mcpp](https://github.com/mcpp-community/mcpp) C++23 build tool:
project discovery, `mcpp build` / `run` / `test` / `clean` as VS Code tasks, toolchain management,
`mcpp.toml` and `build.mcpp` editing help, the package library view, and cache views with graded
cleanup. C++ module semantics — diagnostics, completion, hover, definitions, references, the module
graph — come from `sunrisepeak.mcpp-language-server`; this extension never starts an LSP client of
its own and only **forwards** to it ([docs/architecture.md](docs/architecture.md)).

## Related projects

| Project | What it is | Where |
| --- | --- | --- |
| [mcpp](https://github.com/mcpp-community/mcpp) | The C++23 build tool this extension drives | — |
| [mcpp-language-server](https://github.com/Sunrisepeak/mcpp-language-server) | The C++ Modules language service; a hard dependency of this extension | [Marketplace](https://marketplace.visualstudio.com/items?itemName=sunrisepeak.mcpp-language-server) · [Open VSX](https://open-vsx.org/extension/sunrisepeak/mcpp-language-server) |
| mcpp-vscode (this extension) | The VS Code front end | [Marketplace](https://marketplace.visualstudio.com/items?itemName=mcpp-community.mcpp-vscode) · [Open VSX](https://open-vsx.org/extension/mcpp-community/mcpp-vscode) · [Releases](https://github.com/mcpp-community/mcpp-vscode/releases) |

See [dependency graph navigation and exports](docs/dependency-graphs.md) for entry groups, importer depth, refresh behavior and SVG/PNG export.

## Install

Any of the three channels installs the same extension:

- **Marketplace**: the link above, or search "mcpp" inside VS Code.
- **Open VSX**: the link above (VSCodium, Gitpod and friends; listed from 0.6.0 on).
- **GitHub Releases**: download the VSIX, then **Extensions: Install from VSIX...**, or
  `code --install-extension mcpp-vscode-<version>.vsix`.

`package.json` declares `extensionDependencies: ["sunrisepeak.mcpp-language-server"]`, so VS Code
installs that extension automatically where a platform package exists — the field only accepts an
extension id, no version range ([docs/compatibility.md](docs/compatibility.md)).

| Platform | mcppls package | This extension |
| --- | --- | --- |
| `linux-x64`, `linux-arm64`, `darwin-arm64`, `win32-x64` | yes | yes |
| `darwin-x64`, `win32-arm64` | no package | not activated |

## Quick start

1. Open a folder containing an `mcpp.toml` (or run **mcpp: New Project**).
2. Run **mcpp: Build** (`mcpp.build`); it runs in a dedicated task terminal.
3. Open the **mcpp** activity-bar container: **Project**, **Libraries** and **Cache** (collapsed by
   default); the C++ Modules status and actions live in **Project → Basics**.

Opening a project never runs `mcpp` on its own and never downloads a toolchain.

## Features

- **mcpp CLI and tasks** — build, run, test, clean, the quick menu, toolchains: [docs/commands.md](docs/commands.md).
- **`mcpp.toml` editing** — structural completion, hovers, go-to-definition, seven structural diagnostics, no formatting: [docs/mcpp-toml.md](docs/mcpp-toml.md).
- **`build.mcpp` help** — `build.mcpp` is a `cpp` file that C++ Modules compiles as the build program; this extension adds the `mcpp::…` directive completion, hovers and snippets and the SPEC-007 rule checks no compiler makes: [docs/build-script.md](docs/build-script.md).
- **Libraries** — browse the official mcpp-index offline, choose a target project and dependency type, and view available versions and verified example code. Other registry hits have separate previews. See [Libraries](docs/libraries.md).
- **Cache views and cleanup** — project artifacts and the shared build cache, previewed before anything is deleted: [docs/cache.md](docs/cache.md).
- **C++ Modules** — the other extension's state and actions, in the project view and the status-bar menu, forwarded not reimplemented: [docs/commands.md](docs/commands.md).
- **Settings and diagnostics** — a registry-backed settings panel (`mcpp.openSettings`) and a copyable environment self-check (`mcpp.selfCheck`): [docs/settings.md](docs/settings.md). `mcpp.ui.language` overrides our messages and panels only; palette titles always follow VS Code ([docs/architecture.md](docs/architecture.md#language)).

## Troubleshooting

Look first at the **mcpp** output channel, then run **mcpp: Environment Self-check**
(`mcpp.selfCheck`). The common cases — the dependency is missing, the language service stays on
"no status yet", `mcpp.path` versus `PATH`, a build that finished without refreshing the language
service — are in [docs/troubleshooting.md](docs/troubleshooting.md).

## Development

`npm ci`, `npm run compile`, `npm test` (the gates first, then the unit tests), `npm run test:e2e`,
`npm run package`, and `node tools/dev-profile.mjs` for a throwaway profile under `.dev-profile/`
that never touches your real one.

Release: bump the version in `package.json` and `package-lock.json`, commit, and push a tag
matching the version exactly. The workflow runs the tests, packages one VSIX, and publishes that
same artifact to GitHub Releases and Open VSX. Upload that VSIX manually through the Visual Studio Marketplace publisher portal.

## License

Apache-2.0 — see [LICENSE](LICENSE).
