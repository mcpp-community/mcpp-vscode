import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { TOOL_COMMANDS } from "../commands/ids";
import { t } from "../i18n/t";
import { cachedDescriptorText, loadSnapshot } from "../library/indexLocator";
import { descriptorDependencies, lockPackageVersions } from "../library/indexModel";
import type { ProjectSummary } from "../views/models";
import { escapeHtml } from "../util/text";
import { WebviewDocument } from "../webview/document";
import { buildDependencyGraph, graphMermaid } from "./dependencyGraph";

/** A read-only declaration graph. The lock supplies versions, never fabricated parent edges. */
export function registerDependencyGraph(context: vscode.ExtensionContext, project: () => ProjectSummary | undefined): void {
  let panel: vscode.WebviewPanel | undefined;
  let selected: ProjectSummary | undefined;
  let source = "";
  let generation = 0;
  const document = new WebviewDocument("dependencyGraph.css");
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
  const vendor = vscode.Uri.joinPath(context.extensionUri, "dist", "vendor");
  const render = async (): Promise<void> => {
    if (!panel || !selected) { return; }
    const target = panel;
    const root = selected.root;
    const name = selected.name ?? path.basename(root);
    const request = ++generation;
    const read = (file: string) => fs.readFile(file, "utf8").catch(() => undefined);
    try {
      const [snapshot, lock, manifest] = await Promise.all([loadSnapshot({ projectRoot: root }).catch(() => undefined), read(path.join(root, "mcpp.lock")), read(path.join(root, "mcpp.toml"))]);
      if (manifest === undefined) { throw new Error(t("The project manifest is missing or unreadable.")); }
      const locked = lockPackageVersions(lock ?? "");
      const entries = snapshot?.entries ?? [];
      const graph = await buildDependencyGraph(root, name, {
        manifest: (directory) => directory === root ? Promise.resolve(manifest) : read(path.join(directory, "mcpp.toml")),
        descriptor: (id) => {
          const matches = entries.filter((entry) => entry.id === id || (!id.includes(".") && entry.name === id));
          if (matches.length !== 1) { return undefined; }
          const entry = matches[0];
          const text = cachedDescriptorText(entry.file);
          if (text === undefined) { return undefined; }
          return { id: entry.id, resolved: locked.find((pkg) => pkg.id === entry.id)?.version,
            dependencies: descriptorDependencies(text).map((dep) => ({ ...dep, dev: false, kind: "normal" as const })) };
        },
      });
      if (panel !== target || generation !== request) { return; }
      source = graphMermaid(graph);
      const assets = document.assets(media, target.webview);
      const renderer = target.webview.asWebviewUri(vscode.Uri.joinPath(vendor, "mermaid.js")).toString();
      const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
      const html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${assets.nonce}'; style-src ${assets.cspSource} 'unsafe-inline'; img-src ${assets.cspSource} data:; font-src ${assets.cspSource};">
      <link rel="stylesheet" href="${escapeHtml(assets.styleUri)}"></head><body>
      <header><div><h1>${escapeHtml(name)} · ${escapeHtml(t("Project dependency graph"))}</h1><p>${escapeHtml(root)}</p></div>
      <nav><button data-action="refresh">${escapeHtml(t("Refresh"))}</button><button data-action="copy">${escapeHtml(t("Copy Mermaid"))}</button><button data-action="manifest">${escapeHtml(t("Open mcpp.toml"))}</button></nav></header>
      <p>${escapeHtml(t("Up to 3 dependency levels · {0} packages · {1} edges", graph.nodes.length - 1, graph.edges.length))}</p>
      <p class="hint">${escapeHtml(t("Edges come from manifests and local index descriptors; lockfile versions are shown when available. This is a declaration graph, not a resolved build graph. Dashed nodes have no local dependency metadata; conditional edges may not apply to this environment."))}</p>
      ${graph.limited ? `<p role="status">${escapeHtml(t("Large graph truncated at 120 nodes or 240 edges."))}</p>` : ""}
      <div class="zoom"><button data-zoom="-">−</button><button data-zoom="fit">${escapeHtml(t("Fit"))}</button><button data-zoom="+">+</button><span id="feedback" role="status"></span></div>
      <div id="graph" aria-label="${escapeHtml(t("Project dependency graph"))}"></div>
      <details><summary>${escapeHtml(t("Mermaid source"))}</summary><pre>${escapeHtml(source)}</pre></details>
      <script nonce="${assets.nonce}" src="${escapeHtml(renderer)}"></script>
      <script nonce="${assets.nonce}">
      const vscode=acquireVsCodeApi();let zoom=1;
      document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:button.dataset.action})));
      document.querySelectorAll('[data-zoom]').forEach(button=>button.addEventListener('click',()=>{zoom=button.dataset.zoom==='fit'?1:Math.max(.25,Math.min(4,zoom+(button.dataset.zoom==='+'?.25:-.25)));const svg=document.querySelector('#graph svg');if(svg){svg.style.width=(zoom*100)+'%';svg.style.maxWidth='none';}}));
      window.addEventListener('message',event=>{if(event.data.type==='copied')document.getElementById('feedback').textContent=${json(t("Copied"))};});
      async function draw(){const dark=document.body.classList.contains('vscode-dark')||document.body.classList.contains('vscode-high-contrast');mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:dark?'dark':'default',flowchart:{htmlLabels:false,useMaxWidth:true},maxEdges:250});try{const result=await mermaid.render('dependency-svg',${json(source)});document.getElementById('graph').innerHTML=result.svg;}catch{document.getElementById('graph').textContent=${json(t("Could not render the graph. Copy Mermaid source or refresh to retry."))};}}
      draw();new MutationObserver(draw).observe(document.body,{attributes:true,attributeFilter:['class']});
      </script></body></html>`;
      document.paint(target.webview, html);
    } catch (error) {
      if (panel === target && generation === request) { void vscode.window.showErrorMessage(t("Could not read project dependencies: {0}", String(error))); }
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand(TOOL_COMMANDS.dependencyGraph, async () => {
    const current = project();
    if (!current) { void vscode.window.showInformationMessage(t("Open an mcpp project first.")); return; }
    selected = current;
    if (!panel) {
      panel = vscode.window.createWebviewPanel("mcpp.dependencyGraph", t("Project dependency graph"), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media, vendor] });
      panel.webview.html = `<p>${escapeHtml(t("Reading project dependencies…"))}</p>`;
      panel.onDidDispose(() => { panel = undefined; generation++; document.invalidate(); });
      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        const type = (message as {type?: unknown} | null)?.type;
        if (type === "refresh") { await render(); }
        if (type === "copy") { await vscode.env.clipboard.writeText(source); await panel?.webview.postMessage({ type: "copied" }); }
        if (type === "manifest" && selected) { await vscode.window.showTextDocument(vscode.Uri.file(path.join(selected.root, "mcpp.toml"))); }
      });
    } else { panel.reveal(); }
    await render();
  }), { dispose: () => panel?.dispose() });
}
