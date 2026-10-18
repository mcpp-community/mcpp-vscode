# Libraries

Open **MC++ → Libraries**, search for a package, and click it to open its detail page.
The default catalog is the official mcpp-index already installed on this machine.
The footer distinguishes rereading local files from updating the index with mcpp.

The detail header shows usage, C++ standard and license tags. Choose the target
project in the upper right, then select a version available for the current
environment. This platform describes the extension host, not a cross-compilation target.

Use the arrow beside the add button to choose the dependency type:

| Type | Behavior |
| --- | --- |
| Project dependency | Runs `mcpp add <package>@<version>` |
| Development dependency | Runs `mcpp add <package>@<version> --dev` |
| Build dependency | Shows a copyable `[build-dependencies]` entry and opens `mcpp.toml` for editing |

Current mcpp does not provide a flag for adding build dependencies. Moving an
existing declaration between project and development groups also opens the
manifest with an appropriate snippet; the extension does not silently duplicate
or migrate it. Additions use exact versions. Existing declarations are preserved
by default, and lockfile resolutions are shown separately from direct declarations.

Usage examples are shown when verified local source is available. A packaged
index may omit example projects; the repository and index-site buttons provide
the next place to look. Platform versions, build information and source
diagnostics can be expanded without leaving the page.

**Search other registries** is optional and off by default. Results from these
registries appear in a separate group and open limited previews. They cannot be
added directly without a complete local descriptor.

If the official catalog is missing, update the mcpp index or configure
`mcpp.library.indexPath` to an index directory containing `pkgs/`. A custom path
is identified as a custom source; global index updates do not update an arbitrary
checkout. The legacy official path is supported, while the xlings tool catalog
is not automatically substituted for mcpp-index.
