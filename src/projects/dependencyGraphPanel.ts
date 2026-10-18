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
import { readProjectSummary } from "./summary";
import { buildDependencyGraph, graphMermaid } from "./dependencyGraph";

/** A read-only declaration graph. The lock supplies versions, never fabricated parent edges. */
export function registerDependencyGraph(context: vscode.ExtensionContext, project: () => ProjectSummary | undefined): void {
  let panel: vscode.WebviewPanel | undefined;
  let selected: ProjectSummary | undefined;
  let source = "";
  let selection: { dependency?: string; kind?: string } | undefined;
  let generation = 0;
  const document = new WebviewDocument("dependencyGraph.css");
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
  const vendor = vscode.Uri.joinPath(context.extensionUri, "dist", "vendor");
  const render = async (): Promise<void> => {
    if (!panel || !selected) { return; }
    const target = panel;
    const root = selected.root;
    let name = selected.name ?? path.basename(root);
    const request = ++generation;
    const read = (file: string) => fs.readFile(file, "utf8").catch(() => undefined);
    try {
      const [snapshot, lock, manifest] = await Promise.all([loadSnapshot({ projectRoot: root }).catch(() => undefined), read(path.join(root, "mcpp.lock")), read(path.join(root, "mcpp.toml"))]);
      if (manifest === undefined) { throw new Error(t("The project manifest is missing or unreadable.")); }
      name = readProjectSummary(root, manifest.split(/\r?\n/)).name ?? name;
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
          return { id: entry.id, tags: [entry.surface === "header" ? "#include" : entry.surface === "module" ? "import" : entry.surface ?? "index", ...entry.licenses.slice(0, 1)], resolved: locked.find((pkg) => pkg.id === entry.id)?.version,
            dependencies: descriptorDependencies(text).map((dep) => ({ ...dep, dev: false, kind: "normal" as const })) };
        },
      });
      if (panel !== target || generation !== request) { return; }
      source = graphMermaid(graph);
      const focused = graph.edges.find((edge) => edge.from === root && edge.declaration === selection?.dependency && (!selection?.kind || edge.kind === selection.kind));
      const focus = focused ? `n${graph.nodes.findIndex((node) => node.key === focused.to)}` : undefined;
      const assets = document.assets(media, target.webview);
      const renderer = target.webview.asWebviewUri(vscode.Uri.joinPath(vendor, "mermaid.js")).toString();
      const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
      const html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${assets.nonce}'; style-src ${assets.cspSource} 'unsafe-inline'; img-src ${assets.cspSource} data:; font-src ${assets.cspSource};">
      <link rel="stylesheet" href="${escapeHtml(assets.styleUri)}"></head><body>
      <header class="graph-header"><div class="graph-heading"><h1>${escapeHtml(t("Dependency graph"))}</h1><span class="project-name">${escapeHtml(name)}</span><span class="depth-pill" title="${escapeHtml(t("Maximum dependency depth: 3"))}">3</span></div>
      <nav><span id="feedback" role="status"></span><button data-action="refresh" title="${escapeHtml(t("Refresh"))}">↻</button><button data-action="copy">${escapeHtml(t("Copy Mermaid"))}</button></nav></header>
      ${graph.limited ? `<p role="status" class="graph-notice">${escapeHtml(t("Large graph truncated at 120 nodes or 240 edges."))}</p>` : ""}
      <main class="graph-stage"><div id="graph" tabindex="0" title="${escapeHtml(t("Scroll to zoom · drag to pan"))}" aria-label="${escapeHtml(t("Project dependency graph"))}"></div>
      <div class="zoom"><button data-zoom="-" aria-label="${escapeHtml(t("Zoom out"))}">−</button><button data-zoom="fit">${escapeHtml(t("Fit"))}</button><button data-zoom="+" aria-label="${escapeHtml(t("Zoom in"))}">+</button></div></main>
      <details class="graph-help"><summary>${escapeHtml(t("Legend and source"))}</summary><div class="graph-legend"><span class="legend-project">${escapeHtml(t("Project"))}</span><span class="legend-path">path</span><span class="legend-index">index</span><span class="legend-unknown">${escapeHtml(t("Unavailable"))}</span></div><p>${escapeHtml(t("Declaration graph · dashed edges are conditional · lockfile supplies versions"))}</p><button data-action="manifest">${escapeHtml(t("Open mcpp.toml"))}</button><pre>${escapeHtml(source)}</pre></details>
      <script nonce="${assets.nonce}" src="${escapeHtml(renderer)}"></script>
      <script nonce="${assets.nonce}">
      const vscode=acquireVsCodeApi();let zoom=1,drawId=0,panX=0,panY=0,baseWidth=0,baseHeight=0,drag,suppressClick=false;
      const graph=document.getElementById('graph');
      document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:button.dataset.action})));
      function applyView(){const svg=graph.querySelector('svg');if(svg)svg.style.transform='translate('+panX+'px,'+panY+'px) scale('+zoom+')';}
      function zoomAt(next,x=graph.clientWidth/2,y=graph.clientHeight/2){next=Math.max(.05,Math.min(4,next));const ratio=next/zoom;panX=x-(x-panX)*ratio;panY=y-(y-panY)*ratio;zoom=next;applyView();}
      function fitGraph(){if(!baseWidth||!baseHeight)return;zoom=Math.min(1,(graph.clientWidth-48)/baseWidth,(graph.clientHeight-48)/baseHeight);panX=(graph.clientWidth-baseWidth*zoom)/2;panY=(graph.clientHeight-baseHeight*zoom)/2;applyView();}
      document.querySelectorAll('[data-zoom]').forEach(button=>button.addEventListener('click',()=>button.dataset.zoom==='fit'?fitGraph():zoomAt(zoom*(button.dataset.zoom==='+'?1.2:1/1.2))));
      graph.addEventListener('wheel',event=>{event.preventDefault();const rect=graph.getBoundingClientRect();const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?graph.clientHeight:1);zoomAt(zoom*Math.exp(-delta*.0015),event.clientX-rect.left,event.clientY-rect.top);},{passive:false});
      graph.addEventListener('pointerdown',event=>{if(event.button===0)drag={id:event.pointerId,x:event.clientX,y:event.clientY,panX,panY,moved:false};});
      graph.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(!drag.moved&&Math.hypot(dx,dy)>4){drag.moved=true;graph.setPointerCapture(event.pointerId);graph.classList.add('is-grabbing');}if(drag.moved){event.preventDefault();panX=drag.panX+dx;panY=drag.panY+dy;applyView();}});
      function endDrag(event){if(!drag||event.pointerId!==drag.id)return;suppressClick=drag.moved;if(graph.hasPointerCapture(event.pointerId))graph.releasePointerCapture(event.pointerId);graph.classList.remove('is-grabbing');drag=undefined;setTimeout(()=>suppressClick=false,0);}
      graph.addEventListener('pointerup',endDrag);graph.addEventListener('pointercancel',endDrag);
      graph.addEventListener('click',event=>{if(suppressClick){event.preventDefault();event.stopPropagation();}},true);
      graph.addEventListener('keydown',event=>{if(event.key==='+'||event.key==='='||event.key==='-'){event.preventDefault();zoomAt(zoom*(event.key==='-'?1/1.2:1.2));}if(event.key==='0'){event.preventDefault();fitGraph();}});

      window.addEventListener('message',event=>{if(event.data.type==='copied'){const feedback=document.getElementById('feedback');feedback.textContent=${json(t("Copied"))};setTimeout(()=>feedback.textContent='',1800);}});
      function focusNode(id,center){graph.querySelectorAll('.node').forEach(node=>{const active=node.dataset.nodeKey===id;node.classList.toggle('is-focused',active);node.setAttribute('aria-pressed',String(active));if(active&&center){if(zoom<.85)zoomAt(.85);const viewport=graph.getBoundingClientRect(),box=node.getBoundingClientRect();panX+=viewport.left+viewport.width/2-box.left-box.width/2;panY+=viewport.top+viewport.height/2-box.top-box.height/2;applyView();}});}
      async function draw(){const request=++drawId;const dark=document.body.classList.contains('vscode-dark')||document.body.classList.contains('vscode-high-contrast');mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,theme:dark?'dark':'default',fontFamily:'system-ui',markdownAutoWrap:false,flowchart:{htmlLabels:false,useMaxWidth:true,wrappingWidth:1000,nodeSpacing:30,rankSpacing:90,padding:18},maxEdges:250});try{const result=await mermaid.render('dependency-svg-'+request,${json(source)});if(request!==drawId)return;graph.innerHTML=result.svg;const svg=graph.querySelector('svg');baseWidth=svg.viewBox.baseVal.width;baseHeight=svg.viewBox.baseVal.height;svg.style.width=baseWidth+'px';svg.style.maxWidth='none';fitGraph();
      graph.querySelectorAll('.edgeLabel .label').forEach(label=>{const text=label.querySelector('text'),background=label.querySelector('rect.background');if(text&&background){const box=text.getBBox();background.setAttribute('x',String(box.x-4));background.setAttribute('y',String(box.y-3));background.setAttribute('width',String(box.width+8));background.setAttribute('height',String(box.height+6));background.setAttribute('rx','3');}});
      graph.querySelectorAll('.node').forEach(node=>{const match=/flowchart-(n[0-9]+)-/.exec(node.id);if(!match)return;node.dataset.nodeKey=match[1];node.setAttribute('tabindex','0');node.setAttribute('role','button');node.setAttribute('aria-label',node.textContent);node.querySelectorAll('rect').forEach(rect=>{rect.setAttribute('rx','8');rect.setAttribute('ry','8');});node.addEventListener('click',()=>focusNode(match[1],false));node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();focusNode(match[1],false);}});});
      if(${json(focus ?? "")})focusNode(${json(focus ?? "")},true);
      }catch{graph.textContent=${json(t("Could not render the graph. Copy Mermaid source or refresh to retry."))};}}
      draw();new MutationObserver(draw).observe(document.body,{attributes:true,attributeFilter:['class']});
      </script></body></html>`;
      document.paint(target.webview, html);
    } catch (error) {
      if (panel === target && generation === request) { void vscode.window.showErrorMessage(t("Could not read project dependencies: {0}", String(error))); }
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand(TOOL_COMMANDS.dependencyGraph, async (argument: unknown) => {
    const requested = argument && typeof argument === "object" ? argument as { root?: unknown; dependency?: unknown; kind?: unknown } : undefined;
    const current = typeof requested?.root === "string" ? { root: requested.root } : project();
    selection = { dependency: typeof requested?.dependency === "string" ? requested.dependency : undefined, kind: typeof requested?.kind === "string" ? requested.kind : undefined };
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
