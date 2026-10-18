import { t } from "../i18n/t";
import { escapeHtml } from "../util/text";
import type { WebviewAssets } from "../webview/document";

export function graphPanelHtml(assets: WebviewAssets, renderer: string, script: string): string {
  const labels = {
    copied: t("Copied"), error: t("Could not render the graph. Copy Mermaid source or refresh to retry."),
    loading: t("Reading project dependencies…"), empty: t("No module relationships were found for this project."),
    limited: t("View limit reached. Focus a node to explore its dependencies."),
    partial: t("The source graph is incomplete. Some modules may be omitted."),
    expand: t("Expand next level"), selected: t("Selected node"),
  };
  const button = (action: string, label: string): string => `<button data-action="${action}">${escapeHtml(label)}</button>`;
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${assets.nonce}'; style-src ${assets.cspSource} 'unsafe-inline'; img-src ${assets.cspSource} data:; font-src ${assets.cspSource};">
  <link rel="stylesheet" href="${escapeHtml(assets.styleUri)}"></head><body>
  <header class="graph-header"><div class="graph-heading"><h1>${escapeHtml(t("Dependency graph"))}</h1><span id="project-name" class="project-name"></span></div>
    <nav><span id="feedback" role="status"></span>${button("refresh", t("Refresh"))}${button("copy", t("Copy Mermaid"))}</nav></header>
  <div class="graph-tools"><div class="graph-tabs" role="group" aria-label="${escapeHtml(t("Graph view"))}"><button data-mode="packages">${escapeHtml(t("Packages"))}</button><button data-mode="modules">C++ Modules</button></div>
    <label>${escapeHtml(t("Depth"))} <select id="graph-depth"><option value="3">3</option><option value="5">5</option><option value="all">${escapeHtml(t("All"))}</option></select></label>
    <input id="graph-search" type="text" list="graph-options" placeholder="${escapeHtml(t("Find a node…"))}" aria-label="${escapeHtml(t("Find a node…"))}"><datalist id="graph-options"></datalist>
    <button data-action="overview" hidden>${escapeHtml(t("Back to project"))}</button>
  </div>
  <div class="graph-selection"><span id="selected-node">${escapeHtml(t("Select a node to explore its relationships."))}</span><div>${button("expand", t("Expand next level"))}${button("collapse", t("Collapse"))}${button("focus", t("Focus"))}</div></div>
  <main class="graph-stage"><div id="graph" tabindex="0" title="${escapeHtml(t("Scroll to zoom · drag to pan"))}" aria-label="${escapeHtml(t("Project dependency graph"))}"></div><div id="graph-state" role="status"></div>
    <div class="zoom"><button data-zoom="-" aria-label="${escapeHtml(t("Zoom out"))}">−</button><button data-zoom="fit">${escapeHtml(t("Fit"))}</button><button data-zoom="+" aria-label="${escapeHtml(t("Zoom in"))}">+</button></div></main>
  <p id="graph-notice" role="status" hidden></p>
  <details class="graph-help"><summary>${escapeHtml(t("Legend and source"))}</summary><div class="graph-legend"><span class="legend-project">${escapeHtml(t("Project"))}</span><span class="legend-path">path / partition</span><span class="legend-index">index / external</span><span class="legend-unknown">${escapeHtml(t("Unavailable"))}</span></div><p>${escapeHtml(t("Packages show declarations; modules show mcppls imports. External modules stop after one hop."))}</p>${button("manifest", t("Open mcpp.toml"))}<pre id="graph-source"></pre></details>
  <script id="graph-labels" type="application/json" nonce="${assets.nonce}">${JSON.stringify(labels).replace(/</g, "\\u003c")}</script>
  <script nonce="${assets.nonce}" src="${escapeHtml(renderer)}"></script><script nonce="${assets.nonce}" src="${escapeHtml(script)}"></script></body></html>`;
}
