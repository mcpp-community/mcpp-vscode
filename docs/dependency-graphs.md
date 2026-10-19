# Dependency graphs

Open **Project → Basics → C++ Modules Deps** for imports, or use the graph action on the **Dependencies** row for package declarations. C++ parsing and resolution come from mcppls; package relationships come from manifests, with lock/index metadata supplementing them.

The toolbar keeps entry selection and search visible. **View options** contains the two depth controls, **Locate focus** and **Back to project**. **Node actions** contains branch expansion/collapse, importer actions and source opening; double-click and the node plus control remain shortcuts. **Export** combines SVG, PNG and Mermaid copy in one menu. Menus close after an action, on outside click or with Escape.

Modules opens an active entry with three dependency levels and two importer levels. Main and Library entries follow explicit target/main and lib paths or the package defaults. Multiple tests are grouped under Tests using `[test].discover` (default `tests/**/*.cpp`); entry groups show twenty entries per page. Other keeps disconnected components accessible. External package modules stop after one hop. The importer control follows arrows backwards; dependency depth follows imports forwards.

- Click a node to select it; double-click or press Enter to open its read-only source beside the graph. Space selects without opening.
- **Focus** uses the selected node as the center of a new subgraph. **Locate selected** and **Locate focus** move the camera without changing the graph. C and F work while the canvas has keyboard focus.
- **Expand next level** advances the selected branch repeatedly. Importers have separate expand/collapse controls. Collapsing a shared branch preserves nodes still reachable from another branch. Changing a depth control resets that direction's local overrides in the current view.
- Search selects and locates a visible match. A hidden match offers **Focus this result**. **Back** restores prior navigation; **Back to project** shows entry groups.
- Scroll to zoom, drag to pan and use **Fit** to show the complete visible drawing. Changing selection, locating and zooming reuse the current layout.

The normal view is bounded to 60 nodes and 80 edges before layout. A plus count indicates omitted outgoing neighbors; the view notice distinguishes a layout limit from incomplete provider data. When a branch reaches the limit, focus that node to continue exploring. “All” removes the depth limit while retaining the drawing budget.

Refresh merges nearby file/build events and keeps at most one query active for a project/provider. Hidden graphs defer rendering. Unchanged snapshots reuse layouts; an incomplete snapshot gets bounded background retries while visible, stopping when results stop changing. If the provider remains incomplete, its notice stays visible and Refresh is available. First-time mcppls indexing can still take several seconds; this extension does not run another C++ indexer.

Project Dependencies remains visible without a lock file: declarations are enough to list direct dependencies. A project with none shows a single information row. Transient manifest read failures preserve the last usable rows and mark them pending; without usable data a retry row appears. Successful manifest/lock changes update the row automatically. Building is useful for generating resolved metadata, but is not required to show declarations.

**Export → Export SVG** and **Export → Export PNG** save the complete visible drawing, independent of pan and zoom. They preserve current labels, colors and folding, and include a partial-view description when appropriate. Exports do not expand the full project or query mcppls. PNG starts at 2× and reduces resolution to stay within 16 megapixels and 8192 pixels per side; SVG remains scalable. Both use the standard save dialog.

For contributors, `npm run test:graphs-ui` runs the shipped canvas and Mermaid in Chromium, covering interaction, unchanged-layout reuse and offline SVG/PNG export. Install the browser once with `npx playwright install chromium`. The normal CI also runs this test and retains fixture screenshots and exports as artifacts.
