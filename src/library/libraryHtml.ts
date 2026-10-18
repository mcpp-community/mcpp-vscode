/**
 * The library sidebar's document, as a pure function (plan §9.3, §10.2, §12).
 *
 * `src/library/libraryView.ts` resolves the index into a `LibraryModel`; this
 * module turns that into one self-contained HTML document. No `vscode`, no file
 * system, no network — which is what makes the interesting parts (escaping, the
 * strict CSP, the filter/search behaviour, the clamped description) unit
 * testable.
 *
 * House rules, the same ones `src/config/panelHtml.ts` pins down:
 *
 * - **Strict CSP.** `default-src 'none'` plus exactly three sources: the
 *   stylesheet, the nonced inline script and the webview's own image source.
 *   There are no external resources and no inline `style=` attributes.
 * - **No hard-coded copy.** Every user-visible label is looked up in
 *   `LibraryModel.ui`, which the caller has already localized; a key the caller
 *   forgot degrades to the English fallback beside it, not to a blank control.
 * - **No unescaped interpolation.** Every value that reaches the markup goes
 *   through `escapeHtml`; the client script only ever writes through
 *   `textContent` and `setAttribute`, never `innerHTML`.
 * - **State is text plus shape, not colour.** "已添加" is a labelled badge and a
 *   `data-added` attribute; the stylesheet may colour it, but the row reads the
 *   same in a high-contrast theme.
 *
 * The one deliberate performance choice: the search box
 * are applied **in the client**, on rows that are already in the document, so
 * typing never round-trips through the extension host and never moves the caret.
 * The messages still go back (`search`, `filter`) so the host knows what the
 * reader is looking at; the host re-renders only when the *data* changes —
 * a refresh, the cross-registry toggle, or a new index revision.
 */

import { BADGE_UI, SURFACE_TEXT, surfaceLabel, type BadgeKey, type Surface } from "./indexModel";

/** One result row, already resolved for display. */
export interface LibraryRow {
  id: string;
  key?: string;
  source?: string;
  namespace?: string;
  name: string;
  /** The greatest version this platform has, or `undefined`. */
  version?: string;
  surface?: Surface;
  /** Every surface the descriptor supports, not only the leading one. */
  surfaces: Surface[];
  badges: BadgeKey[];
  /**
   * The lower-cased text a query is matched against, built by the host through
   * `indexModel.searchText`. It travels in the row so the client's filter and the
   * host's `visibleEntries` cannot drift apart on what "matches" means.
   */
  haystack: string;
  description?: string;
  /** Declared in the workspace's `mcpp.toml`. */
  added: boolean;
  /** The descriptor's own fields could not be read; identity comes from the file name. */
  unreadable: boolean;
  /** Came from `mcpp search`, not from the local index. */
  crossRegistry?: boolean;
}

export interface LibraryModel {
  /** Everything is already localized by the caller. */
  ui: Record<string, string>;
  rows: LibraryRow[];
  selectedKey?: string;
  query: string;
  networkSearch: boolean;
  /**
   * The setting the toggle writes. Carried in the model so the client and the
   * host cannot disagree about which key the control drives.
   */
  networkSearchSetting: string;
  /** The data source, in plain words, for the footer. */
  dataSource: string;
  sourceDetails?: string;
  status?: string;
  projectNotice?: string;
  /** `{0}` visible of `{1}` known, already localized; the header count uses it. */
  countTemplate: string;
  /** Rows before filtering; the count line shows it against what is visible. */
  total: number;
  /** Set when there is nothing to show, already localized. */
  notice?: string;
}

export interface LibraryAssets {
  cspSource: string;
  nonce: string;
  styleUri: string;
}

/**
 * The `ui` keys the renderer reads, so the caller and the renderer cannot drift
 * apart on a string. `libraryView.ts` fills all of them through `t()`.
 */
export const LIBRARY_UI = {
  htmlLang: "library.htmlLang",
  title: "library.title",
  search: "library.search",
  networkSearch: "library.networkSearch",
  networkSearchHint: "library.networkSearch.hint",
  versionLatest: "library.version.latest",
  surfaceExternal: SURFACE_TEXT.external.uiKey ?? "library.surface.external",
  badgeExamples: BADGE_UI.examples.key,
  badgeCn: BADGE_UI.cn.key,
  badgeOpenkalEcosystem: BADGE_UI["openkal-ecosystem"].key,
  badgeOpenkalCompat: BADGE_UI["openkal-compat"].key,
  badgeOpenkalPosix: BADGE_UI["openkal-posix"].key,
  badgeOpenkalPlatform: BADGE_UI["openkal-platform"].key,
  added: "library.added",
  unreadable: "library.unreadable",
  crossRegistry: "library.crossRegistry",
  noResults: "library.noResults",
  noIndex: "library.noIndex",
  dataSource: "library.dataSource",
  count: "library.count",
  open: "library.open",
  refresh: "library.refresh",
  sources: "library.sources",
  other: "library.other",
  settings: "library.settings",
  update: "library.update",
  output: "library.output",
  clear: "library.clear",
} as const;

/** One badge key's `ui` key, so the renderer has a single lookup table. */
const BADGE_KEY_UI: Readonly<Record<BadgeKey, string>> = {
  examples: LIBRARY_UI.badgeExamples,
  cn: LIBRARY_UI.badgeCn,
  "openkal-ecosystem": LIBRARY_UI.badgeOpenkalEcosystem,
  "openkal-compat": LIBRARY_UI.badgeOpenkalCompat,
  "openkal-posix": LIBRARY_UI.badgeOpenkalPosix,
  "openkal-platform": LIBRARY_UI.badgeOpenkalPlatform,
};

/** A mounted handshake replays data in place after the initial document loads.
 * The host never assigns webview.html in response, so it cannot create a reload loop.
 */
export type LibraryMessage =
  | { type: "refresh" | "settings" | "update" | "output" | "mounted" }
  | { type: "search"; query: string }
  | { type: "networkSearch"; enabled: boolean; token?: string }
  | { type: "open"; id: string };

export type UiLabel = (key: string) => string;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The CSP is an attribute value, but its single quotes are syntax: escaping
 * them would make the document state a different policy than it means. Only the
 * characters that could end the attribute or start a tag are escaped.
 */
function escapeCsp(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** ` name="value"`, or nothing when the value is absent. */
function attribute(name: string, value: string | number | undefined): string {
  return value === undefined ? "" : ` ${name}="${escapeHtml(String(value))}"`;
}

/** ` name`, or nothing. Boolean HTML attributes only. */
function flag(name: string, on: boolean): string {
  return on ? ` ${name}` : "";
}

/** `{0}`-style substitution into an already-localized ui string. */
function fill(label: UiLabel, key: string, args: readonly (string | number)[]): string {
  return label(key).replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}

/** The badge labels, in `BADGE_UI` order. */
export function badgeLabels(badges: readonly BadgeKey[], label: UiLabel): string[] {
  return badges.map((badge) => label(BADGE_KEY_UI[badge]));
}

function renderRow(row: LibraryRow, label: UiLabel): string {
  const badges: string[] = [];
  const openTitle = fill(label, LIBRARY_UI.open, [row.id]);
  const surface = row.surface === undefined ? undefined : surfaceLabel(row.surface, label);
  const version =
    row.version === undefined ? "" : `<span class="row-version" title="${escapeHtml(row.version)}">${escapeHtml(fill(label, LIBRARY_UI.versionLatest, [row.version]))}</span>`;
  const secondary = [
    surface === undefined ? "" : `<span class="row-surface" data-surface="${escapeHtml(row.surface ?? "")}">${escapeHtml(surface)}</span>`,
    ...badges.map((badge) => `<span class="badge">${escapeHtml(badge)}</span>`),
    row.added ? `<span class="badge badge-added" data-badge="added">${escapeHtml(label(LIBRARY_UI.added))}</span>` : "",
    row.unreadable ? `<span class="badge badge-warn" data-badge="unreadable">${escapeHtml(label(LIBRARY_UI.unreadable))}</span>` : "",
    row.crossRegistry === true || row.source ? `<span class="badge" data-badge="cross">${escapeHtml(row.source ?? label(LIBRARY_UI.crossRegistry))}</span>` : "",
  ]
    .filter((part) => part.length > 0)
    .join("");
  const description = row.description === undefined ? "" : row.description;
  return [
    `<li class="row-item">`,
    `  <button type="button" class="row" data-row="${escapeHtml(row.key ?? row.id)}" data-id="${escapeHtml(row.id)}" data-cross="${row.crossRegistry === true}" data-namespace="${escapeHtml(row.namespace ?? "")}"` +
      ` data-added="${row.added ? "true" : "false"}" data-surfaces="${escapeHtml(row.surfaces.join(" "))}"` +
      ` data-haystack="${escapeHtml(row.haystack)}"` +
      ` title="${escapeHtml(openTitle)}">`,
    `    <span class="row-head">`,
    `      <span class="row-name">${escapeHtml(row.id)}</span>`,
    `      ${version}`,
    `    </span>`,
    `    <span class="row-meta">${secondary}</span>`,
    description.length === 0
      ? ""
      : `    <span class="row-description" title="${escapeHtml(description)}">${escapeHtml(description)}</span>`,
    `  </button>`,
    `</li>`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * The search box, and the network toggle under it.
 *
 * There used to be a wrapped row of filter chips between them — one per
 * namespace, one per surface, plus "Added" — which on a real index is three
 * lines of buttons above the list, and the list is the view. The search box
 * already matches the namespace (it is part of a row's haystack), so the
 * taxonomy the chips offered is still one keystroke away; the "Added" state is
 * on the row itself, as a badge.
 */
function renderToolbar(model: LibraryModel, label: UiLabel): string {
  return [
    `<div class="toolbar">`,
    `  <label class="search-label" for="library-search"><span class="sr-only">${escapeHtml(label(LIBRARY_UI.search))}</span></label>`,
    `  <input id="library-search" type="text" role="searchbox" class="search" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(label(LIBRARY_UI.search))}" aria-label="${escapeHtml(label(LIBRARY_UI.search))}"${attribute("value", model.query)}>`,
    `  <button class="link-button clear-search" type="button" data-action="clear" aria-label="${escapeHtml(label(LIBRARY_UI.clear))}"${model.query ? "" : " hidden"}>×</button>`,
    `  <label class="network-toggle" title="${escapeHtml(label(LIBRARY_UI.networkSearchHint))}">`,
    `    <input id="library-network" type="checkbox" data-setting="${escapeHtml(model.networkSearchSetting)}"${flag("checked", model.networkSearch)}>`,
    `    <span>${escapeHtml(label(LIBRARY_UI.networkSearch))}</span>`,
    `  </label>`,
    `  <span class="count" id="library-count">${escapeHtml(fill(label, LIBRARY_UI.count, [model.rows.filter((row) => !row.crossRegistry && rowMatchesClient(model, row)).length, model.rows.filter((row) => !row.crossRegistry).length]))}</span>`,
    `</div>`,
  ].join("\n");
}

function renderList(model: LibraryModel, label: UiLabel): string {
  const local = model.rows.filter((row) => !row.crossRegistry);
  const extra = model.rows.filter((row) => row.crossRegistry);
  return `<div id="library-results">
    ${model.projectNotice ? `<p class="empty project-notice">${escapeHtml(model.projectNotice)}</p>` : ""}
    <ul id="library-list" class="rows">${local.map((row) => renderRow(row, label)).join("\n")}</ul>
    <section id="library-extra"${extra.length === 0 ? " hidden" : ""}>
      <h2 class="group-title">${escapeHtml(label(LIBRARY_UI.other))} (${extra.length})</h2>
      <ul class="rows">${extra.map((row) => renderRow(row, label)).join("\n")}</ul>
    </section>
    <p id="library-empty" class="empty"${model.rows.length ? " hidden" : ""}>${escapeHtml(model.notice ?? label(LIBRARY_UI.noResults))}</p>
    <p class="search-status" role="status">${escapeHtml(model.status ?? "")}</p>
  </div>`;
}

/**
 * The client. Dependency-free, no template literals of its own, and it only
 * writes through `textContent`/`setAttribute`.
 *
 * Search is local: a row carries the text the search box matches against as a
 * `data-haystack` attribute, and the query decides its `hidden` flag. The host is
 * told the query, and answers with a whole new document only when the data
 * behind it changed.
 */
function clientScript(initialModel: string): string {
  return `(function () {
  "use strict";
  var api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  var state = ${initialModel};
  var saved = api && api.getState ? api.getState() || {} : {};
  var searchInput = document.getElementById("library-search");
  var networkInput = document.getElementById("library-network");
  var networkToken;
  var networkSequence = 0;
  var selected = state.selectedKey || saved.selected || "";
  if (searchInput && typeof saved.query === "string") { searchInput.value = saved.query; }
  function post(message) { if (api) { api.postMessage(message); } }
  function persist() {
    if (api && api.setState) { api.setState({ query: searchInput.value, selected: selected, scroll: window.scrollY }); }
  }
  function apply() {
    document.querySelector('[data-action="clear"]').hidden = searchInput.value.length === 0;
    var query = searchInput.value.trim().toLowerCase();
    var parts = query.split(/\\s+/);
    var rows = Array.from(document.querySelectorAll("[data-row]"));
    var local = 0;
    var extra = 0;
    rows.forEach(function (row) {
      var haystack = row.getAttribute("data-haystack") || "";
      var shown = parts.every(function (part) { return !part || haystack.indexOf(part) >= 0; });
      row.parentNode.hidden = !shown;
      if (shown) { if (row.getAttribute("data-cross") === "true") { extra++; } else { local++; } }
      if (row.getAttribute("data-row") === selected) { row.setAttribute("aria-current", "true"); }
      else { row.removeAttribute("aria-current"); }
    });
    var list = document.getElementById("library-list");
    if (list) {
      Array.from(list.children).sort(function (a, b) {
        function rank(item) {
          var id = item.firstElementChild.getAttribute("data-id").toLowerCase();
          var name = id.slice(id.lastIndexOf(".") + 1);
          return !query ? 2 : id === query || name === query ? 0 : id.indexOf(query) === 0 || name.indexOf(query) === 0 ? 1 : 2;
        }
        return rank(a) - rank(b) || a.firstElementChild.getAttribute("data-id").localeCompare(b.firstElementChild.getAttribute("data-id"));
      }).forEach(function (item) { list.appendChild(item); });
    }
    var empty = document.getElementById("library-empty");
    if (empty) { empty.hidden = local + extra > 0; }
    var group = document.getElementById("library-extra");
    if (group) { group.hidden = extra === 0; }
    document.getElementById("library-count").textContent = state.countTemplate.split("{0}").join(String(local)).split("{1}").join(String(state.localTotal));
    persist();
  }
  searchInput.addEventListener("input", function () { apply(); post({ type: "search", query: searchInput.value }); });
  networkInput.addEventListener("change", function () { networkToken = Date.now() + "-" + (++networkSequence); post({ type: "networkSearch", enabled: networkInput.checked, token: networkToken }); });
  document.addEventListener("click", function (event) {
    var target = event.target.closest && event.target.closest("[data-action], [data-row]");
    if (!target) { return; }
    var action = target.getAttribute("data-action");
    if (action === "clear") { searchInput.value = ""; searchInput.focus(); apply(); post({ type: "search", query: "" }); return; }
    if (action) { post({ type: action }); return; }
    selected = target.getAttribute("data-row"); apply(); post({ type: "open", id: selected });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && event.target === searchInput) {
      searchInput.value = ""; apply(); post({ type: "search", query: "" });
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") { return; }
    var rows = Array.from(document.querySelectorAll("[data-row]")).filter(function (row) { return !row.parentNode.hidden; });
    if (!rows.length || (event.target !== searchInput && !event.target.hasAttribute("data-row"))) { return; }
    event.preventDefault();
    var index = rows.indexOf(document.activeElement);
    var next = event.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
    rows[next].focus();
  });
  window.addEventListener("scroll", persist);
  window.addEventListener("message", function (event) {
    var payload = event.data;
    if (payload && payload.type === "networkSearchSaved") { if (payload.token === networkToken) { networkToken = undefined; networkInput.checked = payload.enabled; } return; }
    if (!payload || payload.type !== "libraryUpdate") { return; }
    var scroll = window.scrollY;
    var focused = document.activeElement && document.activeElement.getAttribute("data-row");
    var details = document.querySelector("footer details");
    var expanded = details && details.open;
    var doc = new DOMParser().parseFromString(payload.html, "text/html");
    ["library-results", "library-footer"].forEach(function (id) {
      var old = document.getElementById(id); var next = doc.getElementById(id);
      if (old && next) { old.replaceWith(next); }
    });
    state = payload.state;
    if (state.selectedKey) { selected = state.selectedKey; }
    if (!networkToken) { networkInput.checked = payload.networkSearch; }
    apply();
    var nextDetails = document.querySelector("footer details"); if (nextDetails) { nextDetails.open = expanded; }
    if (focused) { Array.from(document.querySelectorAll("[data-row]")).some(function (row) { if (row.getAttribute("data-row") === focused) { row.focus(); return true; } return false; }); }
    window.scrollTo(0, scroll);
  });
  apply();
  window.scrollTo(0, saved.scroll || 0);
  post({ type: "mounted" });
  post({ type: "search", query: searchInput.value });
})();`;
}

/**
 * The little state the client needs, not the whole model.
 *
 * The rows are already in the document and the badges are already resolved, so
 * embedding the model again would double the page for nothing. `<` is escaped in
 * `embedJson`, so even this cannot close the script element.
 */
export function libraryClientState(model: LibraryModel): Record<string, unknown> {
  return {
    countTemplate: model.countTemplate,
    selectedKey: model.selectedKey,
    total: model.total,
    localTotal: model.rows.filter((row) => !row.crossRegistry).length,
    query: model.query,
  };
}

/** A model embedded in the page's own script; `<` is escaped so it cannot close it. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The whole document. */
export function renderLibraryHtml(model: LibraryModel, assets: LibraryAssets): string {
  const label: UiLabel = (key) => model.ui[key] ?? key;
  const csp = `default-src 'none'; style-src ${assets.cspSource}; script-src 'nonce-${assets.nonce}'; img-src ${assets.cspSource}`;
  const visible = model.rows.filter((row) => rowMatchesClient(model, row)).length;
  const count = fill(label, LIBRARY_UI.count, [visible, model.total]);
  return `<!DOCTYPE html>
<html lang="${escapeHtml(model.ui[LIBRARY_UI.htmlLang] ?? "")}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeCsp(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeHtml(assets.styleUri)}">
<title>${escapeHtml(label(LIBRARY_UI.title))}</title>
</head>
<body>
<header class="sr-only">
  <h1 class="panel-title">${escapeHtml(label(LIBRARY_UI.title))}</h1>
</header>
${renderToolbar(model, label)}
<main>
${renderList(model, label)}
</main>
<footer id="library-footer" class="footer" role="note">
  <details><summary>${escapeHtml(model.dataSource)}</summary><p class="source">${escapeHtml(model.sourceDetails ?? "")}</p></details>
  <div class="footer-actions">
  <button type="button" class="link-button" data-action="update">${escapeHtml(label(LIBRARY_UI.update))}</button>
  <button type="button" class="link-button" data-action="settings">${escapeHtml(label(LIBRARY_UI.settings))}</button>
  <button type="button" class="link-button" data-action="output">${escapeHtml(label(LIBRARY_UI.output))}</button>
  <button type="button" class="link-button" data-action="refresh" title="${escapeHtml(label(LIBRARY_UI.refresh))}">${escapeHtml(label(LIBRARY_UI.refresh))}</button>
  </div>
</footer>
<script nonce="${escapeHtml(assets.nonce)}">
${clientScript(embedJson(libraryClientState(model)))}
</script>
</body>
</html>
`;
}

/**
 * The rows the initial query keeps. The live search is the client's
 * `rowMatches`; this mirrors it for the header count, so the count the reader
 * first sees matches the list beneath it.
 */
function rowMatchesClient(model: LibraryModel, row: LibraryRow): boolean {
  const query = model.query.trim().toLowerCase();
  if (query.length === 0) {
    return true;
  }
  return query.split(/\s+/).every((part) => part.length === 0 || row.haystack.includes(part));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Decode one `postMessage` payload. Webview input is untrusted: anything that is
 * not exactly one of the four shapes is dropped, and the returned object is
 * rebuilt so foreign fields never travel further.
 */
export function decodeLibraryMessage(raw: unknown): LibraryMessage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  switch (raw.type) {
    case "mounted":
    case "refresh":
    case "settings":
    case "update":
    case "output":
      return { type: raw.type };
    case "search":
      return typeof raw.query === "string" ? { type: "search", query: raw.query } : undefined;
    case "networkSearch":
      return typeof raw.enabled === "boolean" ? { type: "networkSearch", enabled: raw.enabled, ...(typeof raw.token === "string" && raw.token.length <= 80 ? { token: raw.token } : {}) } : undefined;
    case "open":
      return nonEmptyString(raw.id) ? { type: "open", id: raw.id } : undefined;
    default:
      return undefined;
  }
}
