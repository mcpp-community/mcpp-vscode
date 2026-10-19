import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { TOOL_COMMANDS } from "../commands/ids";
import { t } from "../i18n/t";
import { queryModuleGraph } from "../cli/moduleGraph";
import { cachedDescriptorText, loadSnapshot } from "../library/indexLocator";
import { descriptorDependencies, lockPackageVersions } from "../library/indexModel";
import type { ProjectSummary } from "../views/models";
import { WebviewDocument } from "../webview/document";
import { ReadOnlyDocuments } from "../webview/readOnlyDocuments";
import { graphPanelHtml } from "../graphs/panelHtml";
import { groupedGraph, INITIAL_GRAPH_BUDGET, mermaidGraph, visibleGraph, type VisibleGraph, type VisualGraph } from "../graphs/model";
import { RefreshCoordinator } from "../graphs/refresh";
import { decodeGraphExport } from "../graphs/export";
import { readProjectSummary } from "./summary";
import { buildDependencyGraph } from "./dependencyGraph";
import { buildModuleGraph, moduleEntries, moduleOwnership, sourcePath, testDiscovery, isTestSource } from "./moduleGraph";

interface ViewState {
  root: string; mode: "packages" | "modules"; name: string; graph?: VisualGraph;
  dependencyTargets?: Map<string, string>; dependency?: string; dependencyKind?: string;
  metrics: { reads: number; projections: number };
  coordinator?: RefreshCoordinator; dirty?: boolean; revision?: string; sentRevision?: string; retry?: ReturnType<typeof setTimeout>; attempts?: number;
  visible?: VisibleGraph; group?: string; offset: number; initialized?: boolean;
  history: Array<{ focus?: string; group?: string; offset: number; selected?: string; depth: number; upstreamDepth: number; localDepth: Map<string, number>; collapsed: Set<string>; upstreamLocalDepth: Map<string, number>; upstreamCollapsed: Set<string> }>;
  upstreamDepth: number; localDepth: Map<string, number>; upstreamLocalDepth: Map<string, number>; upstreamCollapsed: Set<string>;
  depth: number; expanded: Set<string>; collapsed: Set<string>; selected?: string; focus?: string;
}
const SOURCE_SCHEME = "mcpp-graph-source";

/** Two providers, one persistent graph document. Expansion never re-runs the CLI. */
export function registerDependencyGraph(context: vscode.ExtensionContext, project: () => ProjectSummary | undefined): void {
  let panel: vscode.WebviewPanel | undefined, current: ViewState | undefined, source = "", generation = 0, publication = 0, ready = false, loading = false;
  const views = new Map<string, ViewState>();
  const document = new WebviewDocument("dependencyGraph.css"), media = vscode.Uri.joinPath(context.extensionUri, "media"), vendor = vscode.Uri.joinPath(context.extensionUri, "dist", "vendor");
  const sourceChanged = new vscode.EventEmitter<vscode.Uri>();
  const sources = new ReadOnlyDocuments(SOURCE_SCHEME, uri => sourceChanged.fire(vscode.Uri.parse(uri)));
  context.subscriptions.push(sourceChanged, vscode.workspace.registerTextDocumentContentProvider(SOURCE_SCHEME, { onDidChange: sourceChanged.event, provideTextDocumentContent: uri => sources.read(uri.toString()) ?? "" }));
  const viewKey = (view: ViewState): string => `${view.mode}:${view.root}`;
  const exists = async (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);
  const read = (file: string): Promise<string | undefined> => fs.readFile(file, "utf8").catch(() => undefined);

  const publish = async (center = false, fit = false): Promise<void> => {
    const view = current, target = panel, version = ++publication;
    if (!ready || !target?.visible || !view?.graph) { return; }
    view.metrics.projections++;
    const presentation = view.focus ? view.graph : groupedGraph(view.graph, view.group, view.offset);
    const graph = visibleGraph(presentation, view, INITIAL_GRAPH_BUDGET), rendered = mermaidGraph(graph);
    view.visible = graph;
    if (view.sentRevision !== view.revision) {
      await target.webview.postMessage({ type: "snapshot", viewKey: viewKey(view),
        search: view.graph.nodes.map(node => ({ id: node.id, label: node.label })),
        groups: view.graph.groups ?? [] });
      view.sentRevision = view.revision;
    }
    if (current !== view || panel !== target || version !== publication) { return; }
    source = rendered.source;
    await target.webview.postMessage({ type: "graph", viewKey: viewKey(view), mode: view.mode, name: view.name,
      depth: view.depth === Infinity ? "all" : String(view.depth), upstreamDepth: String(view.upstreamDepth),
      source, nodes: graph.nodes.map(node => ({ id: node.id, label: node.label, hidden: graph.hidden.get(node.id) ?? 0, parents: graph.hiddenParents.get(node.id) ?? 0, virtual: !!node.virtual })),
      selected: view.selected, focus: view.focus, group: view.group, offset: view.offset,
      debug: vscode.workspace.getConfiguration?.("mcpp").get("log.level") === "debug" ? view.metrics : undefined,
      back: !!view.history.length, center, fit, limited: graph.limited, truncated: graph.truncated });
  };
  const readGraph = async (view: ViewState, signal?: AbortSignal): Promise<void> => {
    if (view !== current || !panel || !ready || signal?.aborted) { return; }
    const target = panel, request = ++generation;
    loading = !view.graph;
    if (!view.graph) { await target.webview.postMessage({ type: "loading", viewKey: viewKey(view), mode: view.mode, name: view.name }); }
    try {
      view.metrics.reads++;
      const manifest = await read(path.join(view.root, "mcpp.toml"));
      if (manifest === undefined) { throw new Error(t("The project manifest is missing or unreadable.")); }
      view.name = readProjectSummary(view.root, manifest.split(/\r?\n/)).name ?? path.basename(view.root);
      let graph: VisualGraph;
      if (view.mode === "modules") {
        const extension = vscode.extensions.getExtension("sunrisepeak.mcpp-language-server");
        const bundled = extension ? path.join(extension.extensionPath, "payload", "bin", process.platform === "win32" ? "mcppls.exe" : "mcppls") : undefined;
        const executable = bundled && await exists(bundled) ? bundled : "mcppls";
        const raw = await queryModuleGraph(vscode.workspace.isTrusted, executable, view.root, undefined, signal);
        const patterns = testDiscovery(manifest);
        const discovered = new Set<string>(); let discoveryLimited = false;
        for (const pattern of patterns.filter(pattern => !pattern.startsWith("!"))) {
          // Search is only a candidate generator; the pure mcpp matcher decides membership.
          const candidates = await vscode.workspace.findFiles(new vscode.RelativePattern(view.root, pattern), "**/{.git,.mcpp,node_modules,build}/**", 10000, signal ? { isCancellationRequested: signal.aborted, onCancellationRequested: listener => { const abort = () => listener(undefined); signal.addEventListener("abort", abort); return { dispose: () => signal.removeEventListener("abort", abort) }; } } : undefined);
          discoveryLimited ||= candidates.length >= 10000;
          for (const file of candidates) { if (isTestSource(path.relative(view.root, file.fsPath).split(path.sep).join("/"), patterns)) { discovered.add(file.fsPath); } }
        }
        const entries = moduleEntries(view.root, manifest, view.name, [...discovered]);
        const files = new Set(raw.modules.flatMap(node => node.files.map(file => sourcePath(view.root, file))));
        const names = new Set(raw.modules.map(node => node.name));
        const importers = new Set(raw.imports.filter(edge => !names.has(edge.from)).map(edge => sourcePath(view.root, edge.from)));
        // A truncated response can still contain edges from omitted module names.
        // Only an existing source file may become an ordinary importer node.
        for (const file of importers) { if (await exists(file)) { files.add(file); } }
        for (const file of entries.keys()) { if (await exists(file)) { files.add(file); } }
        graph = buildModuleGraph(view.root, raw, await moduleOwnership(view.root, [...files], exists), entries);
        graph.truncated ||= discoveryLimited;
      } else {
        const [snapshot, lock] = await Promise.all([loadSnapshot({ projectRoot: view.root }).catch(() => undefined), read(path.join(view.root, "mcpp.lock"))]);
        const locked = lockPackageVersions(lock ?? ""), entries = snapshot?.entries ?? [];
        const packages = await buildDependencyGraph(view.root, view.name, {
          manifest: directory => directory === view.root ? Promise.resolve(manifest) : read(path.join(directory, "mcpp.toml")),
          descriptor: id => {
            const matches = entries.filter(entry => entry.id === id || (!id.includes(".") && entry.name === id));
            if (matches.length !== 1) { return undefined; }
            const entry = matches[0], text = cachedDescriptorText(entry.file);
            if (text === undefined) { return undefined; }
            return { id: entry.id, tags: [entry.surface === "header" ? "#include" : entry.surface === "module" ? "import" : entry.surface ?? "index", ...entry.licenses.slice(0, 1)],
              resolved: locked.find(pkg => pkg.id === entry.id)?.version, dependencies: descriptorDependencies(text).map(dep => ({ ...dep, dev: false, kind: "normal" as const })) };
          },
        }, Infinity);
        view.dependencyTargets = new Map(packages.edges.filter(edge => edge.from === view.root).map(edge => [`${edge.declaration}:${edge.kind}`, edge.to]));
        const nodes = new Map(packages.nodes.map(node => [node.key, node]));
        graph = { roots: [view.root], truncated: packages.limited,
          nodes: packages.nodes.map(node => ({ id: node.key, label: node.name, kind: node.source, lines: [...(node.tags?.length ? [node.tags.slice(0, 2).join(" · ")] : []), `deps ${node.dependencies ?? "?"}`] })),
          edges: packages.edges.map(edge => {
            const node = nodes.get(edge.to)!, version = edge.constraint ?? node.version;
            return { from: edge.from, to: edge.to, dashed: edge.conditional, label: (edge.name ?? node.name) + (version ? `@${version}` : "") + (edge.kind === "normal" ? "" : ` · ${edge.kind}`) + (edge.conditional ? " · conditional" : "") };
          }) };
      }
      if (panel !== target || current !== view || request !== generation) { return; }
      if (graph.groups) { graph.groups = graph.groups.map(group => ({ ...group, label: t(group.label) })); }
      if (signal?.aborted) { return; }
      view.dirty = false;
      const revision = createHash("sha256").update(JSON.stringify(graph)).digest("hex");
      const unchanged = revision === view.revision;
      view.graph = unchanged ? view.graph : graph; view.revision = revision;
      if (!view.initialized) {
        const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
        const entry = graph.groups?.flatMap(group => group.nodes).find(id => graph.nodes.find(node => node.id === id)?.files?.includes(activeFile ?? ""));
        view.focus ??= entry ?? graph.groups?.[0]?.nodes[0];
        view.selected ??= view.focus; view.initialized = true;
      }
      if (view.focus && !graph.nodes.some(node => node.id === view.focus)) { view.focus = graph.groups?.[0]?.nodes[0]; }
      if (view.selected && !graph.nodes.some(node => node.id === view.selected)) { view.selected = view.focus; }
      if (view.retry) { clearTimeout(view.retry); view.retry = undefined; }
      if (graph.truncated && view.mode === "modules" && !unchanged && (view.attempts ?? 0) < 4) {
        const wait = [2000, 5000, 10000, 20000][view.attempts ?? 0]; view.attempts = (view.attempts ?? 0) + 1;
        view.retry = setTimeout(() => { view.dirty = true; if (current === view && panel?.visible) { void load(true); } }, wait);
      }
      if (view.dependency) {
        view.selected = view.dependencyTargets?.get(`${view.dependency}:${view.dependencyKind ?? "normal"}`) ?? view.selected;
        view.focus = view.selected; view.dependency = undefined;
      }
      loading = false; await publish();
    } catch (error) {
      if (panel !== target || current !== view || request !== generation) { return; }
      if (signal?.aborted) { return; }
      loading = false;
      await target.webview.postMessage({ type: "error", error: t("Could not read project dependencies: {0}", String(error)) });
    }
  };
  const load = async (refresh = false): Promise<void> => {
    const view = current;
    if (!view || !ready || !panel?.visible) { return; }
    if (view.graph && !refresh && !view.dirty) { await publish(); return; }
    view.coordinator ??= new RefreshCoordinator(async signal => { await readGraph(view, signal); });
    view.coordinator.visible = true;
    await view.coordinator.request(true);
  };
  const chooseView = (root: string, mode: ViewState["mode"]): ViewState => {
    const key = `${mode}:${root}`;
    let view = views.get(key);
    if (!view) { view = { root, mode, name: path.basename(root), depth: 3, upstreamDepth: mode === "modules" ? 2 : 0, offset: 0, metrics: { reads: 0, projections: 0 }, history: [], localDepth: new Map(), upstreamLocalDepth: new Map(), upstreamCollapsed: new Set(), expanded: new Set(), collapsed: new Set() }; views.set(key, view);
      if (views.size > 8) { const oldest = views.keys().next().value!; views.get(oldest)?.coordinator?.dispose(); const retry = views.get(oldest)?.retry; if (retry) { clearTimeout(retry); } views.delete(oldest); }
    }
    views.delete(key); views.set(key, view);
    return view;
  };
  const openSource = async (view: ViewState, id: string): Promise<void> => {
    const node = view.graph?.nodes.find(node => node.id === id);
    if (!node) { return; }
    view.selected = id;
    if (view.mode !== "modules") { return; }
    const files = node.files ?? [];
    if (!files.length) { void vscode.window.showInformationMessage(t("Source is unavailable for this module.")); return; }
    const file = files.length === 1 ? files[0] : (await vscode.window.showQuickPick(files.map(file => ({ label: path.basename(file), description: path.relative(view.root, file), file })), { placeHolder: t("Choose a module source file") }))?.file;
    if (!file || current !== view) { return; }
    const text = await read(file);
    if (current !== view) { return; }
    if (text === undefined) { void vscode.window.showInformationMessage(t("Source is unavailable for this module.")); return; }
    const uri = vscode.Uri.parse(sources.capture({ path: file, text }));
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
  };
  const receive = async (message: unknown): Promise<void> => {
    if (!message || typeof message !== "object") { return; }
    const value = message as Record<string, unknown>;
    if (value.type === "ready") { ready = true; await load(); return; }
    if (value.type !== "action" || !current || value.viewKey !== viewKey(current)) { return; }
    if (value.action === "mode" && (value.mode === "packages" || value.mode === "modules")) { current.coordinator?.cancel(); current = chooseView(current.root, value.mode); await load(); return; }
    if (value.action === "refresh") { await load(true); return; }
    if (value.action === "manifest") { await vscode.window.showTextDocument(vscode.Uri.file(path.join(current.root, "mcpp.toml"))); return; }
    if (loading || !current.graph) { return; }
    if (value.action === "copy") { await vscode.env.clipboard.writeText(source); await panel?.webview.postMessage({ type: "copied" }); return; }
    if (value.action === "depth" && ["0", "1", "2", "3", "5", "all"].includes(String(value.depth))) {
      current.depth = value.depth === "all" ? Infinity : Number(value.depth); current.expanded.clear(); current.collapsed.clear(); current.localDepth.clear(); await publish(); return;
    }
    if (value.action === "upstreamDepth" && ["0", "1", "2", "3", "5"].includes(String(value.depth))) { current.upstreamDepth = Number(value.depth); current.upstreamLocalDepth.clear(); current.upstreamCollapsed.clear(); await publish(); return; }
    const remember = (): void => {
      current!.history.push({ focus: current!.focus, group: current!.group, offset: current!.offset,
        selected: current!.visible?.nodes.some(node => node.id === current!.selected) ? current!.selected : current!.focus, depth: current!.depth, upstreamDepth: current!.upstreamDepth,
        localDepth: new Map(current!.localDepth), collapsed: new Set(current!.collapsed), upstreamLocalDepth: new Map(current!.upstreamLocalDepth), upstreamCollapsed: new Set(current!.upstreamCollapsed) });
      if (current!.history.length > 20) { current!.history.shift(); }
    };
    if (value.action === "back") { const previous = current.history.pop(); if (previous) { Object.assign(current, previous); await publish(); } return; }
    if (value.action === "overview" || value.action === "group") {
      remember(); current.focus = undefined;
      current.group = typeof value.group === "string" && current.graph.groups?.some(group => group.id === value.group) ? value.group : undefined;
      current.offset = 0; current.selected = current.group; await publish(false, true); return;
    }
    if (value.action === "page") {
      const group = current.graph.groups?.find(group => group.id === current!.group);
      if (group) { current.offset = Math.max(0, Math.min(Math.floor((group.nodes.length - 1) / 20) * 20, current.offset + (value.next ? 20 : -20))); current.selected = current.group; await publish(false, true); } return;
    }
    if (value.action === "export") {
      const payload = decodeGraphExport(value.format, value.data);
      const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(current.root, `modules-${current.mode}.${payload.extension}`)), filters: { [payload.extension.toUpperCase()]: [payload.extension] } });
      if (destination) { await vscode.workspace.fs.writeFile(destination, payload.bytes); } return;
    }
    const id = typeof value.id === "string" ? value.id : undefined;
    if (!id) { return; }
    if (current.graph.groups?.some(group => group.id === id)) {
      if (["focus", "expand", "open"].includes(String(value.action))) { remember(); current.focus = undefined; current.group = id; current.offset = 0; current.selected = id; await publish(false, true); }
      return;
    }
    if (!current.graph.nodes.some(node => node.id === id)) { return; }
    current.selected = id;
    if (value.action === "select") { return; }
    if (value.action === "open") { await openSource(current, id); return; }
    if (value.action === "expand" || value.action === "expandParents") {
      const upstream = value.action === "expandParents", overrides = upstream ? current.upstreamLocalDepth : current.localDepth;
      const remaining = upstream ? current.visible?.upstreamRemaining : current.visible?.remainingDepth;
      const depth = Math.max(0, remaining?.get(id) ?? 0, overrides.get(id) ?? 0);
      overrides.set(id, Number.isFinite(depth) ? depth + 1 : 1);
      (upstream ? current.upstreamCollapsed : current.collapsed).delete(id);
    }
    else if (value.action === "collapse" || value.action === "collapseParents") { (value.action === "collapseParents" ? current.upstreamCollapsed : current.collapsed).add(id); }
    else if (value.action === "focus" || value.action === "search") { remember(); current.focus = id; current.localDepth = new Map(); current.collapsed = new Set(); current.upstreamLocalDepth = new Map(); current.upstreamCollapsed = new Set(); }
    else { return; }
    await publish(value.action === "search", value.action === "focus");
  };
  const open = async (mode: ViewState["mode"], argument?: unknown): Promise<void> => {
    const requested = argument && typeof argument === "object" ? argument as { root?: unknown; dependency?: unknown; path?: unknown; kind?: unknown } : undefined;
    const root = typeof requested?.root === "string" ? requested.root : project()?.root;
    if (!root) { void vscode.window.showInformationMessage(t("Open an mcpp project first.")); return; }
    if (current && (current.root !== root || current.mode !== mode)) { current.coordinator?.cancel(); }
    current = chooseView(root, mode);
    if (typeof requested?.dependency === "string") {
      current.dependency = requested.dependency;
      current.dependencyKind = typeof requested.kind === "string" ? requested.kind : "normal";
      current.selected = current.dependencyTargets?.get(`${requested.dependency}:${current.dependencyKind}`) ?? (typeof requested.path === "string" ? path.resolve(root, requested.path) : current.graph?.nodes.find(node => node.id === requested.dependency || node.label === requested.dependency)?.id ?? requested.dependency);
      current.focus = current.selected;
    }
    if (!panel) {
      panel = vscode.window.createWebviewPanel("mcpp.dependencyGraph", t("Project dependency graph"), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media, vendor] });
      ready = false;
      panel.webview.onDidReceiveMessage(message => { void receive(message).catch(error => vscode.window.showErrorMessage(String(error))); });
      panel.onDidChangeViewState(() => {
        for (const view of views.values()) { view.coordinator?.setVisible(panel?.visible === true && view === current); }
        if (panel?.visible) { void load(); }
      });
      panel.onDidDispose(() => { for (const view of views.values()) { view.coordinator?.cancel(); view.sentRevision = undefined; if (view.retry) { clearTimeout(view.retry); } } panel = undefined; ready = false; generation++; document.invalidate(); });
      const assets = document.assets(media, panel.webview);
      document.paint(panel.webview, graphPanelHtml(assets, panel.webview.asWebviewUri(vscode.Uri.joinPath(vendor, "mermaid.js")).toString(), panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "graph.js")).toString()));
    } else { panel.reveal(); await load(); }
  };
  const invalidate = (uri?: vscode.Uri): void => {
    for (const view of views.values()) {
      if (uri) { const relative = path.relative(view.root, uri.fsPath); if (relative.startsWith("..") || path.isAbsolute(relative)) { continue; } }
      if (uri?.fsPath.endsWith("mcpp.lock") && view.mode === "modules") { continue; }
      view.dirty = true; view.attempts = 0;
      if (view === current && panel?.visible && ready) {
        view.coordinator ??= new RefreshCoordinator(async signal => { await readGraph(view, signal); });
        void view.coordinator.request();
      }
    }
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/{mcpp.toml,mcpp.lock,*.cpp,*.cc,*.cxx,*.cppm,*.ixx,*.mpp,*.ccm}");
  context.subscriptions.push(watcher, watcher.onDidChange(uri => invalidate(uri)), watcher.onDidCreate(uri => invalidate(uri)), watcher.onDidDelete(uri => invalidate(uri)),
    vscode.tasks.onDidEndTaskProcess(event => { const scope = event.execution.task.scope; if (scope && typeof scope === "object") { invalidate(scope.uri); } }),
    { dispose: () => { for (const view of views.values()) { view.coordinator?.dispose(); if (view.retry) { clearTimeout(view.retry); } } } });
  context.subscriptions.push(vscode.commands.registerCommand(TOOL_COMMANDS.dependencyGraph, argument => open("packages", argument)),
    vscode.commands.registerCommand(TOOL_COMMANDS.moduleDependencyGraph, argument => open("modules", argument)), { dispose: () => panel?.dispose() });
}
