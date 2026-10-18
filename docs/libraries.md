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

Usage shows the index's real test examples, preferring the package's own named
test project. Local checkout tests take priority. Official packaged indexes often
omit tests, so the extension includes a pinned upstream test snapshot for offline
use, with its commit shown on the page. Open the complete source in a read-only
editor; this also applies to local checkout sources. Copy and source actions sit
beside the example heading. Custom indexes only use their own tests. Packages without matching tests
keep an explicit empty state. Platform versions, build information and source
diagnostics can be expanded without leaving the page.

In **Project → Basics → Dependencies**, use the graph icon to open the nearest
three dependency levels as Mermaid. The palette command is **mcpp: Show Project
Dependency Graph**. Relations come from project/local-path manifests and local
index descriptors; lockfiles supply versions rather than parent edges. This is a
declaration graph, so conditional or descriptor-level relations may differ from a
resolved build. Missing local metadata is marked with a dashed node. The page
supports zoom, refresh, opening the manifest and copying Mermaid source, and caps
large graphs at 120 nodes or 240 edges.

The dependency list shows direct `namespace.package@version` declarations and
distinguishes index, path and git sources. Click a row to open the graph focused
on that dependency. Graph edges keep the full package coordinate together;
colored nodes show minimal tags and dependency counts. The primary canvas omits
absolute paths and diagnostic paragraphs; the legend and source are folded.

**Search other registries** is optional and off by default. Results from these
registries appear in a separate group and open limited previews. They cannot be
added directly without a complete local descriptor.

If the official catalog is missing, update the mcpp index or configure
`mcpp.library.indexPath` to an index directory containing `pkgs/`. A custom path
is identified as a custom source; global index updates do not update an arbitrary
checkout. The legacy official path is supported, while the xlings tool catalog
is not automatically substituted for mcpp-index.

The dependency graph supports cursor-centered wheel zoom and click-and-drag panning. Use Fit to restore the complete graph; keyboard `+`, `-`, and `0` provide zoom and reset.
