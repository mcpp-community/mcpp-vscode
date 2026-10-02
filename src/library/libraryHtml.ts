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
 * The one deliberate performance choice: the search box and the filter chips
 * are applied **in the client**, on rows that are already in the document, so
 * typing never round-trips through the extension host and never moves the caret.
 * The messages still go back (`search`, `filter`) so the host knows what the
 * reader is looking at; the host re-renders only when the *data* changes —
 * a refresh, the cross-registry toggle, or a new index revision.
 */

import { BADGE_UI, SURFACE_TEXT, surfaceLabel, type BadgeKey, type FilterKind, type Surface } from "./indexModel";

/** One result row, already resolved for display. */
export interface LibraryRow {
  id: string;
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

/** One filter chip. Labels and counts are resolved by the caller. */
export interface LibraryChip {
  id: string;
  kind: FilterKind;
  value?: string;
  label: string;
  count: number;
}

export interface LibraryModel {
  /** Everything is already localized by the caller. */
  ui: Record<string, string>;
  rows: LibraryRow[];
  chips: LibraryChip[];
  /** The chip id that starts selected. */
  activeChip: string;
  query: string;
  networkSearch: boolean;
  /**
   * The setting the toggle writes. Carried in the model so the client and the
   * host cannot disagree about which key the control drives.
   */
  networkSearchSetting: string;
  /** The data source, in plain words, for the footer. */
  dataSource: string;
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
  filters: "library.filters",
  chipAll: "library.chip.all",
  chipAdded: "library.chip.added",
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

export type LibraryMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "filter"; chip: string }
  | { type: "search"; query: string }
  | { type: "networkSearch"; enabled: boolean }
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
  const badges = badgeLabels(row.badges, label);
  const openTitle = fill(label, LIBRARY_UI.open, [row.id]);
  const surface = row.surface === undefined ? undefined : surfaceLabel(row.surface, label);
  const version =
    row.version === undefined ? "" : `<span class="row-version" title="${escapeHtml(row.version)}">${escapeHtml(fill(label, LIBRARY_UI.versionLatest, [row.version]))}</span>`;
  const secondary = [
    surface === undefined ? "" : `<span class="row-surface" data-surface="${escapeHtml(row.surface ?? "")}">${escapeHtml(surface)}</span>`,
    ...badges.map((badge) => `<span class="badge">${escapeHtml(badge)}</span>`),
    row.added ? `<span class="badge badge-added" data-badge="added">${escapeHtml(label(LIBRARY_UI.added))}</span>` : "",
    row.unreadable ? `<span class="badge badge-warn" data-badge="unreadable">${escapeHtml(label(LIBRARY_UI.unreadable))}</span>` : "",
    row.crossRegistry === true ? `<span class="badge" data-badge="cross">${escapeHtml(label(LIBRARY_UI.crossRegistry))}</span>` : "",
  ]
    .filter((part) => part.length > 0)
    .join("");
  const description = row.description === undefined ? "" : row.description;
  return [
    `<li class="row-item">`,
    `  <button type="button" class="row" data-row="${escapeHtml(row.id)}" data-namespace="${escapeHtml(row.namespace ?? "")}"` +
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

function renderChips(model: LibraryModel, label: UiLabel): string {
  const chips = model.chips
    .map((chip) => {
      const active = chip.id === model.activeChip;
      const data = chip.value === undefined ? "" : ` data-chip-value="${escapeHtml(chip.value)}"`;
      return (
        `<button type="button" class="chip" data-chip="${escapeHtml(chip.id)}" data-chip-kind="${chip.kind}"${data}` +
        ` aria-pressed="${active ? "true" : "false"}"${flag("data-active", active)}>` +
        `<span class="chip-label">${escapeHtml(chip.label)}</span>` +
        `<span class="chip-count">${escapeHtml(String(chip.count))}</span>` +
        `</button>`
      );
    })
    .join("\n  ");
  return [
    `<div class="toolbar">`,
    `  <label class="search-label" for="library-search"><span class="sr-only">${escapeHtml(label(LIBRARY_UI.search))}</span></label>`,
    `  <input id="library-search" type="search" class="search" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(label(LIBRARY_UI.search))}" aria-label="${escapeHtml(label(LIBRARY_UI.search))}"${attribute("value", model.query)}>`,
    `  <div class="chips" role="group" aria-label="${escapeHtml(label(LIBRARY_UI.filters))}">`,
    `  ${chips}`,
    `  </div>`,
    `  <label class="network-toggle" title="${escapeHtml(label(LIBRARY_UI.networkSearchHint))}">`,
    `    <input id="library-network" type="checkbox" data-setting="${escapeHtml(model.networkSearchSetting)}"${flag("checked", model.networkSearch)}>`,
    `    <span>${escapeHtml(label(LIBRARY_UI.networkSearch))}</span>`,
    `  </label>`,
    `</div>`,
  ].join("\n");
}

function renderList(model: LibraryModel, label: UiLabel): string {
  if (model.rows.length === 0) {
    return `<p id="library-empty" class="empty">${escapeHtml(model.notice ?? label(LIBRARY_UI.noResults))}</p>`;
  }
  return [
    `<ul id="library-list" class="rows">`,
    model.rows.map((row) => renderRow(row, label)).join("\n"),
    `</ul>`,
    `<p id="library-empty" class="empty" hidden>${escapeHtml(label(LIBRARY_UI.noResults))}</p>`,
  ].join("\n");
}

/**
 * The client. Dependency-free, no template literals of its own, and it only
 * writes through `textContent`/`setAttribute`.
 *
 * Filtering is local: a row carries its namespace, its added state and its
 * surfaces as `data-*` attributes, and the chip plus the query decide its
 * `hidden` flag. The host is told which filter and query are active, and answers
 * with a whole new document only when the data behind it changed.
 */
function clientScript(initialModel: string): string {
  return `(function () {
  "use strict";
  var api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  var state = ${initialModel};
  var searchInput = document.getElementById("library-search");
  var networkInput = document.getElementById("library-network");
  var list = document.getElementById("library-list");
  var empty = document.getElementById("library-empty");
  var chipElements = document.querySelectorAll("[data-chip]");
  var countElement = document.getElementById("library-count");
  var activeChip = state && state.activeChip ? state.activeChip : "all";
  var activeValue = "";

  function post(message) {
    if (api) { api.postMessage(message); }
  }

  function chipValue(id) {
    for (var index = 0; index < chipElements.length; index += 1) {
      if (chipElements[index].getAttribute("data-chip") === id) {
        return { kind: chipElements[index].getAttribute("data-chip-kind"), value: chipElements[index].getAttribute("data-chip-value") || "" };
      }
    }
    return { kind: "all", value: "" };
  }

  // The canonical semantics are indexModel.visibleEntries; this mirrors them on
  // the data-* attributes and on the host-built data-haystack.
  function rowMatches(row, kind, value, query) {
    if (kind === "namespace" && row.getAttribute("data-namespace") !== value) { return false; }
    if (kind === "added" && row.getAttribute("data-added") !== "true") { return false; }
    if (kind === "surface") {
      var surfaces = (row.getAttribute("data-surfaces") || "").split(" ");
      if (surfaces.indexOf(value) < 0) { return false; }
    }
    if (query.length === 0) { return true; }
    var haystack = row.getAttribute("data-haystack") || "";
    var parts = query.split(/\\s+/);
    for (var index = 0; index < parts.length; index += 1) {
      if (parts[index].length > 0 && haystack.indexOf(parts[index]) < 0) { return false; }
    }
    return true;
  }

  function apply() {
    var query = searchInput ? searchInput.value.trim().toLowerCase() : "";
    var chip = chipValue(activeChip);
    activeValue = chip.value || "";
    var any = false;
    var visible = 0;
    if (list) {
      var rows = list.querySelectorAll("[data-row]");
      for (var index = 0; index < rows.length; index += 1) {
        var shown = rowMatches(rows[index], chip.kind, activeValue, query);
        rows[index].parentNode.hidden = !shown;
        if (shown) { any = true; visible += 1; }
      }
      list.hidden = !any;
    }
    if (empty) { empty.hidden = any || !list; }
    if (countElement) {
      var template = state && state.countTemplate ? state.countTemplate : "";
      var total = state && state.total ? state.total : 0;
      countElement.textContent = template.split("{0}").join(String(visible)).split("{1}").join(String(total));
    }
    for (var index2 = 0; index2 < chipElements.length; index2 += 1) {
      var active = chipElements[index2].getAttribute("data-chip") === activeChip;
      chipElements[index2].setAttribute("aria-pressed", active ? "true" : "false");
      if (active) { chipElements[index2].setAttribute("data-active", ""); }
      else { chipElements[index2].removeAttribute("data-active"); }
    }
  }

  if (searchInput) {
    searchInput.addEventListener("input", function () {
      apply();
      post({ type: "search", query: searchInput.value });
    });
  }
  if (networkInput) {
    networkInput.addEventListener("change", function () {
      post({ type: "networkSearch", enabled: networkInput.checked === true });
    });
  }
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") { return; }
    var chip = target.closest("[data-chip]");
    if (chip) {
      activeChip = chip.getAttribute("data-chip");
      apply();
      post({ type: "filter", chip: activeChip });
      return;
    }
    var refresh = target.closest("[data-action]");
    if (refresh && refresh.getAttribute("data-action") === "refresh") {
      post({ type: "refresh" });
      return;
    }
    var row = target.closest("[data-row]");
    if (row) { post({ type: "open", id: row.getAttribute("data-row") }); }
  });
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (data && data.type === "filter" && typeof data.chip === "string") {
      activeChip = data.chip;
      apply();
    }
  });

  apply();
  post({ type: "ready" });
})();`;
}

/**
 * The little state the client needs, not the whole model.
 *
 * The rows are already in the document and the badges are already resolved, so
 * embedding the model again would double the page for nothing. `<` is escaped in
 * `embedJson`, so even this cannot close the script element.
 */
function clientState(model: LibraryModel): Record<string, unknown> {
  return {
    activeChip: model.activeChip,
    countTemplate: model.countTemplate,
    total: model.total,
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
<header class="panel-header">
  <h1 class="panel-title">${escapeHtml(label(LIBRARY_UI.title))}</h1>
  <p class="count" id="library-count">${escapeHtml(count)}</p>
</header>
${renderChips(model, label)}
<main>
${renderList(model, label)}
</main>
<footer class="footer" role="note">
  <span class="source">${escapeHtml(model.dataSource)}</span>
  <button type="button" class="link-button" data-action="refresh" title="${escapeHtml(label(LIBRARY_UI.refresh))}">${escapeHtml(label(LIBRARY_UI.refresh))}</button>
</footer>
<script nonce="${escapeHtml(assets.nonce)}">
${clientScript(embedJson(clientState(model)))}
</script>
</body>
</html>
`;
}

/**
 * The rows the initial query keeps. The live filtering is the client's
 * `rowMatches`; this mirrors it for the header count, so the count the reader
 * first sees matches the list beneath it.
 */
function rowMatchesClient(model: LibraryModel, row: LibraryRow): boolean {
  const chip = model.chips.find((candidate) => candidate.id === model.activeChip);
  if (chip !== undefined) {
    if (chip.kind === "namespace" && row.namespace !== chip.value) {
      return false;
    }
    if (chip.kind === "added" && !row.added) {
      return false;
    }
    if (chip.kind === "surface" && !row.surfaces.includes(chip.value as Surface)) {
      return false;
    }
  }
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
 * not exactly one of the six shapes is dropped, and the returned object is
 * rebuilt so foreign fields never travel further.
 */
export function decodeLibraryMessage(raw: unknown): LibraryMessage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  switch (raw.type) {
    case "ready":
      return { type: "ready" };
    case "refresh":
      return { type: "refresh" };
    case "filter":
      return nonEmptyString(raw.chip) ? { type: "filter", chip: raw.chip } : undefined;
    case "search":
      return typeof raw.query === "string" ? { type: "search", query: raw.query } : undefined;
    case "networkSearch":
      return typeof raw.enabled === "boolean" ? { type: "networkSearch", enabled: raw.enabled } : undefined;
    case "open":
      return nonEmptyString(raw.id) ? { type: "open", id: raw.id } : undefined;
    default:
      return undefined;
  }
}
