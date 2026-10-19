import { t } from "../i18n/t";
import { escapeHtml } from "../util/text";
import type { WebviewAssets } from "../webview/document";

export function graphPanelHtml(assets: WebviewAssets, renderer: string, script: string): string {
  const labels = {
    copied: t("Copied"), error: t("Could not render the graph. Copy Mermaid source or refresh to retry."),
    loading: t("Reading project dependencies…"), empty: t("No module relationships were found for this project."),
    limited: t("View limit reached. Focus a node to explore its dependencies."),
    partial: t("The source graph is incomplete. Some modules may be omitted."),
    exportError: t("Could not export this graph. Try SVG or a smaller view."), focus: t("Focus"),
    group: t("Entry group"), selectedPrefix: t("Selected"),
    expand: t("Expand next level"), selected: t("Selected node"),
  };
  const button = (action: string, label: string): string => `<button data-action="${action}">${escapeHtml(label)}</button>`;
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${assets.nonce}'; style-src ${assets.cspSource} 'unsafe-inline'; img-src ${assets.cspSource} data: blob:; font-src ${assets.cspSource};">
  <link rel="stylesheet" href="${escapeHtml(assets.styleUri)}"></head><body>
  <header class="graph-header"><div class="graph-heading"><h1>${escapeHtml(t("Dependency graph"))}</h1><span id="project-name" class="project-name"></span></div>
    <nav><span id="feedback" role="status"></span><button data-action="refresh" title="${escapeHtml(t("Refresh"))}" aria-label="${escapeHtml(t("Refresh"))}">↻</button>
    <details id="graph-export" class="graph-menu"><summary>${escapeHtml(t("Export"))}</summary><div class="graph-menu-items">
      <button data-export="svg">${escapeHtml(t("Export SVG"))}</button><button data-export="png">${escapeHtml(t("Export PNG"))}</button>${button("copy", t("Copy Mermaid"))}
    </div></details></nav></header>
  <div class="graph-tools"><div class="graph-tabs" role="group" aria-label="${escapeHtml(t("Graph view"))}"><button data-mode="packages">${escapeHtml(t("Packages"))}</button><button data-mode="modules">C++ Modules</button></div>
    <select id="graph-entries" aria-label="${escapeHtml(t("Entry group"))}"></select><button id="entry-previous" aria-label="${escapeHtml(t("Previous entries"))}">‹</button><span id="entry-page"></span><button id="entry-next" aria-label="${escapeHtml(t("Next entries"))}">›</button>
    <input id="graph-search" type="text" list="graph-options" placeholder="${escapeHtml(t("Find a node…"))}" aria-label="${escapeHtml(t("Find a node…"))}"><datalist id="graph-options"></datalist>
    <button id="graph-search-focus" hidden>${escapeHtml(t("Focus this result"))}</button>
    <details id="graph-view-menu" class="graph-menu"><summary>${escapeHtml(t("View options"))}</summary><div class="graph-menu-items">
      <label>${escapeHtml(t("Dependencies depth"))} <select id="graph-depth"><option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="5">5</option><option value="all">${escapeHtml(t("All"))}</option></select></label>
      <label>${escapeHtml(t("Importers depth"))} <select id="graph-upstream"><option>0</option><option>1</option><option selected>2</option><option>3</option><option>5</option></select></label>
      ${button("locateFocus", t("Locate focus"))}<button data-action="overview" hidden>${escapeHtml(t("Back to project"))}</button>
    </div></details><button data-action="back" title="${escapeHtml(t("Back"))}" aria-label="${escapeHtml(t("Back"))}">←</button>
  </div>
  <div class="graph-selection"><div class="graph-context"><span id="focus-node"></span><span id="selected-node">${escapeHtml(t("Select a node to explore its relationships."))}</span></div>
    <div class="graph-node-actions">${button("focus", t("Focus"))}${button("locate", t("Locate selected"))}
    </div></div>
  <main class="graph-stage"><div id="graph" tabindex="0" title="${escapeHtml(t("Scroll to zoom · drag to pan"))}" aria-label="${escapeHtml(t("Project dependency graph"))}"></div><div id="graph-state" role="status"></div>
    <div class="zoom"><button data-zoom="-" aria-label="${escapeHtml(t("Zoom out"))}">−</button><button data-zoom="fit">${escapeHtml(t("Fit"))}</button><button data-zoom="+" aria-label="${escapeHtml(t("Zoom in"))}">+</button></div></main>
  <div id="graph-node-context" class="graph-menu-items graph-context-menu" role="menu" aria-label="${escapeHtml(t("Node actions"))}" hidden>
    <button role="menuitem" tabindex="-1" data-context-action="focus">${escapeHtml(t("Focus"))}</button>
    <button role="menuitem" tabindex="-1" data-context-action="locate">${escapeHtml(t("Locate selected"))}</button>
    <button role="menuitem" tabindex="-1" data-context-action="open">${escapeHtml(t("Open source"))}</button>
    <button role="menuitem" tabindex="-1" data-context-action="expand">${escapeHtml(t("Expand next level"))}</button>
    <button role="menuitem" tabindex="-1" data-context-action="collapse">${escapeHtml(t("Collapse"))}</button>
    <button role="menuitem" tabindex="-1" data-context-action="expandParents">${escapeHtml(t("Expand importers"))}</button>
    <button role="menuitem" tabindex="-1" data-context-action="collapseParents">${escapeHtml(t("Collapse importers"))}</button>
  </div>
  <p id="graph-notice" role="status" hidden></p>
  <details class="graph-help"><summary>${escapeHtml(t("Legend and source"))}</summary><div class="graph-legend"><span class="legend-project">${escapeHtml(t("Project"))}</span><span class="legend-path">path / partition</span><span class="legend-index">index / external</span><span class="legend-unknown">${escapeHtml(t("Unavailable"))}</span></div><p>${escapeHtml(t("Packages show declarations; modules show mcppls imports. External modules stop after one hop."))}</p>${button("manifest", t("Open mcpp.toml"))}<pre id="graph-source"></pre></details>
  <script id="graph-labels" type="application/json" nonce="${assets.nonce}">${JSON.stringify(labels).replace(/</g, "\\u003c")}</script>
  <script nonce="${assets.nonce}" src="${escapeHtml(renderer)}"></script><script nonce="${assets.nonce}" src="${escapeHtml(script)}"></script></body></html>`;
}
