import { promises as fs } from "node:fs";
import path from "node:path";
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
import { mermaidGraph, visibleGraph, type VisualGraph } from "../graphs/model";
import { readProjectSummary } from "./summary";
import { buildDependencyGraph } from "./dependencyGraph";
import { buildModuleGraph, moduleEntries, moduleOwnership, sourcePath } from "./moduleGraph";

interface ViewState {
  root: string; mode: "packages" | "modules"; name: string; graph?: VisualGraph;
  dependencyTargets?: Map<string, string>; dependency?: string; dependencyKind?: string;
  depth: number; expanded: Set<string>; collapsed: Set<string>; selected?: string; focus?: string;
}
const SOURCE_SCHEME = "mcpp-graph-source";

/** Two providers, one persistent graph document. Expansion never re-runs the CLI. */
export function registerDependencyGraph(context: vscode.ExtensionContext, project: () => ProjectSummary | undefined): void {
  let panel: vscode.WebviewPanel | undefined, current: ViewState | undefined, source = "", generation = 0, ready = false, loading = false;
  const views = new Map<string, ViewState>();
  const document = new WebviewDocument("dependencyGraph.css"), media = vscode.Uri.joinPath(context.extensionUri, "media"), vendor = vscode.Uri.joinPath(context.extensionUri, "dist", "vendor");
  const sourceChanged = new vscode.EventEmitter<vscode.Uri>();
  const sources = new ReadOnlyDocuments(SOURCE_SCHEME, uri => sourceChanged.fire(vscode.Uri.parse(uri)));
  context.subscriptions.push(sourceChanged, vscode.workspace.registerTextDocumentContentProvider(SOURCE_SCHEME, { onDidChange: sourceChanged.event, provideTextDocumentContent: uri => sources.read(uri.toString()) ?? "" }));
  const viewKey = (view: ViewState): string => `${view.mode}:${view.root}`;
  const exists = async (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);
  const read = (file: string): Promise<string | undefined> => fs.readFile(file, "utf8").catch(() => undefined);

  const publish = async (center = false, fit = false): Promise<void> => {
    if (!ready || !panel || !current?.graph) { return; }
    const graph = visibleGraph(current.graph, current), rendered = mermaidGraph(graph);
    source = rendered.source;
    await panel.webview.postMessage({ type: "graph", viewKey: viewKey(current), mode: current.mode, name: current.name, depth: current.depth === Infinity ? "all" : String(current.depth),
      source, nodes: graph.nodes.map(node => ({ id: node.id, label: node.label, hidden: graph.hidden.get(node.id) ?? 0 })),
      search: current.graph.nodes.map(node => ({ id: node.id, label: node.label })),
      selected: current.selected, focus: current.focus, center, fit, limited: graph.limited, truncated: graph.truncated });
  };
  const load = async (refresh = false): Promise<void> => {
    if (!current || !panel || !ready) { return; }
    const view = current, target = panel, request = ++generation;
    if (view.graph && !refresh) { loading = false; await publish(); return; }
    loading = true;
    await target.webview.postMessage({ type: "loading", viewKey: viewKey(view), mode: view.mode, name: view.name });
    try {
      const manifest = await read(path.join(view.root, "mcpp.toml"));
      if (manifest === undefined) { throw new Error(t("The project manifest is missing or unreadable.")); }
      view.name = readProjectSummary(view.root, manifest.split(/\r?\n/)).name ?? path.basename(view.root);
      let graph: VisualGraph;
      if (view.mode === "modules") {
        const extension = vscode.extensions.getExtension("sunrisepeak.mcpp-language-server");
        const bundled = extension ? path.join(extension.extensionPath, "payload", "bin", process.platform === "win32" ? "mcppls.exe" : "mcppls") : undefined;
        const executable = bundled && await exists(bundled) ? bundled : "mcppls";
        const raw = await queryModuleGraph(vscode.workspace.isTrusted, executable, view.root);
        const entries = moduleEntries(view.root, manifest, view.name);
        const files = new Set(raw.modules.flatMap(node => node.files.map(file => sourcePath(view.root, file))));
        const names = new Set(raw.modules.map(node => node.name));
        const importers = new Set(raw.imports.filter(edge => !names.has(edge.from)).map(edge => sourcePath(view.root, edge.from)));
        // A truncated response can still contain edges from omitted module names.
        // Only an existing source file may become an ordinary importer node.
        for (const file of importers) { if (await exists(file)) { files.add(file); } }
        for (const file of entries.keys()) { if (await exists(file)) { files.add(file); } }
        graph = buildModuleGraph(view.root, raw, await moduleOwnership(view.root, [...files], exists), entries);
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
      view.graph = graph;
      if (view.dependency) {
        view.selected = view.dependencyTargets?.get(`${view.dependency}:${view.dependencyKind ?? "normal"}`) ?? view.selected;
        view.focus = view.selected; view.dependency = undefined;
      }
      loading = false; await publish(!!view.selected);
    } catch (error) {
      if (panel !== target || current !== view || request !== generation) { return; }
      loading = false;
      await target.webview.postMessage({ type: "error", error: t("Could not read project dependencies: {0}", String(error)) });
    }
  };
  const chooseView = (root: string, mode: ViewState["mode"]): ViewState => {
    const key = `${mode}:${root}`;
    let view = views.get(key);
    if (!view) { view = { root, mode, name: path.basename(root), depth: 3, expanded: new Set(), collapsed: new Set() }; views.set(key, view); }
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
    if (text === undefined) { void vscode.window.showInformationMessage(t("Source is unavailable for this module.")); return; }
    const uri = vscode.Uri.parse(sources.capture({ path: file, text }));
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
  };
  const receive = async (message: unknown): Promise<void> => {
    if (!message || typeof message !== "object") { return; }
    const value = message as Record<string, unknown>;
    if (value.type === "ready") { ready = true; await load(); return; }
    if (value.type !== "action" || !current || value.viewKey !== viewKey(current)) { return; }
    if (value.action === "mode" && (value.mode === "packages" || value.mode === "modules")) { current = chooseView(current.root, value.mode); await load(); return; }
    if (value.action === "refresh") { await load(true); return; }
    if (value.action === "manifest") { await vscode.window.showTextDocument(vscode.Uri.file(path.join(current.root, "mcpp.toml"))); return; }
    if (loading || !current.graph) { return; }
    if (value.action === "copy") { await vscode.env.clipboard.writeText(source); await panel?.webview.postMessage({ type: "copied" }); return; }
    if (value.action === "depth" && ["3", "5", "all"].includes(String(value.depth))) {
      current.depth = value.depth === "all" ? Infinity : Number(value.depth); current.expanded.clear(); current.collapsed.clear(); await publish(); return;
    }
    if (value.action === "overview") { current.focus = undefined; await publish(false, true); return; }
    const id = typeof value.id === "string" ? value.id : undefined;
    if (!id || !current.graph.nodes.some(node => node.id === id)) { return; }
    current.selected = id;
    if (value.action === "open") { await openSource(current, id); return; }
    if (value.action === "expand") { current.expanded.add(id); current.collapsed.delete(id); }
    else if (value.action === "collapse") { current.collapsed.add(id); current.expanded.delete(id); }
    else if (value.action === "focus" || value.action === "search") { current.focus = id; current.collapsed.delete(id); }
    else { return; }
    await publish(value.action === "search", value.action === "focus");
  };
  const open = async (mode: ViewState["mode"], argument?: unknown): Promise<void> => {
    const requested = argument && typeof argument === "object" ? argument as { root?: unknown; dependency?: unknown; path?: unknown; kind?: unknown } : undefined;
    const root = typeof requested?.root === "string" ? requested.root : project()?.root;
    if (!root) { void vscode.window.showInformationMessage(t("Open an mcpp project first.")); return; }
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
      panel.onDidDispose(() => { panel = undefined; ready = false; generation++; document.invalidate(); });
      const assets = document.assets(media, panel.webview);
      document.paint(panel.webview, graphPanelHtml(assets, panel.webview.asWebviewUri(vscode.Uri.joinPath(vendor, "mermaid.js")).toString(), panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "graph.js")).toString()));
    } else { panel.reveal(); await load(); if (current?.selected) { await publish(true); } }
  };
  context.subscriptions.push(vscode.commands.registerCommand(TOOL_COMMANDS.dependencyGraph, argument => open("packages", argument)),
    vscode.commands.registerCommand(TOOL_COMMANDS.moduleDependencyGraph, argument => open("modules", argument)), { dispose: () => panel?.dispose() });
}
