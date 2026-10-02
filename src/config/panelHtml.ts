/**
 * The configuration panel's document, as a pure function.
 *
 * Everything the panel shows is data: `src/config/panel.ts` resolves the
 * registry and the current values into a `PanelModel`, and this module turns
 * that into one self-contained HTML document. No `vscode`, no file system, no
 * network — which is what makes the interesting parts (escaping, the strict
 * CSP, the advanced/deprecated/invalid marking) unit-testable.
 *
 * House rules the tests pin down:
 *
 * - **Strict CSP.** `default-src 'none'` plus exactly three sources: the
 *   stylesheet, the nonced inline script, and the webview's own image source.
 *   There are no external resources and no inline `style=` attributes, so a
 *   theme change cannot be the only thing that makes a control usable.
 * - **No hard-coded copy.** Every user-visible label is looked up in
 *   `PanelModel.ui`, which the caller has already localized; the renderer never
 *   invents English. A key the caller forgot degrades to the key itself rather
 *   than to a blank control.
 * - **No unescaped interpolation.** Every value from the registry or from
 *   `settings.json` goes through `escapeHtml`; the client script only ever
 *   assigns through `textContent`, never `innerHTML`.
 * - **State is text plus shape, not colour.** Source, deprecation and invalid
 *   state are rendered as labelled badges and hidden attributes; the stylesheet
 *   adds borders around them. Colour is decoration only, so high-contrast
 *   themes stay readable.
 *
 * The webview talks back with JSON `postMessage`s (see `decodePanelMessage`)
 * and the host answers with `{ type: "model", model }`, which the client script
 * applies in place.
 */

import { format } from "../i18n/translate";

/** One choice of an enum setting. */
export interface PanelOption {
  value: string;
  label: string;
}

/** One setting, ready to render. Values and copy are already resolved. */
export interface PanelRow {
  key: string;
  title: string;
  description: string;
  type: "boolean" | "string" | "number" | "array";
  value: boolean | string | number | string[];
  options?: PanelOption[];
  minimum?: number;
  maximum?: number;
  scope: "resource" | "window";
  applies: "immediate" | "next-build" | "next-clean" | "view-reload";
  source: "default" | "user" | "workspace" | "workspaceFolder" | "invalid";
  tier: "public" | "advanced";
  deprecated?: boolean;
  deprecationMessage?: string;
  since: string;
}

/** One registry group, with its rows in registry order. */
export interface PanelSection {
  id: string;
  title: string;
  rows: PanelRow[];
}

/** One preset button. */
export interface PanelPreset {
  id: string;
  title: string;
  description: string;
}

export interface PanelModel {
  sections: PanelSection[];
  presets: PanelPreset[];
  /** Every label the panel shows, already localized by the caller. */
  ui: Record<string, string>;
  /** The workspace folder the values belong to, when the panel was opened from one. */
  resourceLabel?: string;
}

export interface PanelAssets {
  cspSource: string;
  nonce: string;
  styleUri: string;
  scriptUri: string;
}

/**
 * The `ui` keys the renderer reads, so the caller and the renderer cannot drift
 * apart on a string. `panel.ts` fills all of them through `t()`.
 */
export const PANEL_UI = {
  htmlLang: "panel.htmlLang",
  title: "panel.title",
  boundary: "panel.boundary",
  openMcpplsSettings: "panel.openMcpplsSettings",
  resourceLabel: "panel.resourceLabel",
  search: "panel.search",
  onlyModified: "panel.onlyModified",
  showAdvanced: "panel.showAdvanced",
  target: "panel.target",
  targetUser: "panel.target.user",
  targetWorkspace: "panel.target.workspace",
  targetWorkspaceUnavailable: "panel.target.workspaceUnavailable",
  presets: "panel.presets",
  modified: "panel.modified",
  deprecated: "panel.deprecated",
  invalid: "panel.invalid",
  appliesNextBuild: "panel.applies.nextBuild",
  appliesNextClean: "panel.applies.nextClean",
  appliesViewReload: "panel.applies.viewReload",
  sourceDefault: "panel.source.default",
  sourceUser: "panel.source.user",
  sourceWorkspace: "panel.source.workspace",
  sourceWorkspaceFolder: "panel.source.workspaceFolder",
  sourceInvalid: "panel.source.invalid",
  reset: "panel.reset",
  resetInvalid: "panel.resetInvalid",
  openNative: "panel.openNative",
  arrayHint: "panel.arrayHint",
  noMatches: "panel.noMatches",
  toggleSection: "panel.toggleSection",
} as const;

const SOURCE_UI: Record<PanelRow["source"], string> = {
  default: PANEL_UI.sourceDefault,
  user: PANEL_UI.sourceUser,
  workspace: PANEL_UI.sourceWorkspace,
  workspaceFolder: PANEL_UI.sourceWorkspaceFolder,
  invalid: PANEL_UI.sourceInvalid,
};

const APPLIES_UI: Partial<Record<PanelRow["applies"], string>> = {
  "next-build": PANEL_UI.appliesNextBuild,
  "next-clean": PANEL_UI.appliesNextClean,
  "view-reload": PANEL_UI.appliesViewReload,
};

export type PanelUiLabel = (key: string) => string;

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
 * them would turn `'none'` into `&#39;none&#39;` and make the document state a
 * different policy than it means. Only the characters that could end the
 * attribute or start a tag are escaped; `cspSource` and the nonce come from
 * VS Code and from `crypto`, not from the registry.
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

/** The text of the `applies` hint, or `""` when the setting is immediate. */
function appliesHint(row: PanelRow, label: PanelUiLabel): string {
  const key = APPLIES_UI[row.applies];
  return key === undefined ? "" : label(key);
}

function renderControl(row: PanelRow, label: PanelUiLabel): string {
  const invalid = row.source === "invalid";
  const key = escapeHtml(row.key);
  const aria = escapeHtml(row.title);
  if (row.type === "boolean") {
    return (
      `<input type="checkbox" data-control data-kind="boolean" data-key="${key}" aria-label="${aria}"` +
      `${flag("checked", row.value === true)}${flag("disabled", invalid)}>`
    );
  }
  if (row.type === "number") {
    return (
      `<input type="number" data-control data-kind="number" data-key="${key}" aria-label="${aria}"` +
      ` value="${escapeHtml(String(row.value))}"${attribute("min", row.minimum)}${attribute("max", row.maximum)}` +
      `${flag("disabled", invalid)}>`
    );
  }
  if (row.type === "array") {
    const lines = Array.isArray(row.value) ? row.value.join("\n") : String(row.value);
    return (
      `<textarea data-control data-kind="array" data-key="${key}" aria-label="${aria}" rows="2" spellcheck="false"` +
      `${flag("disabled", invalid)}>${escapeHtml(lines)}</textarea>` +
      `<p class="control-hint">${escapeHtml(label(PANEL_UI.arrayHint))}</p>`
    );
  }
  if (row.options !== undefined && row.options.length > 0) {
    const options = row.options
      .map(
        (option) =>
          `<option value="${escapeHtml(option.value)}"${flag("selected", String(row.value) === option.value)}>` +
          `${escapeHtml(option.label)}</option>`,
      )
      .join("");
    return (
      `<select data-control data-kind="string" data-key="${key}" aria-label="${aria}"${flag("disabled", invalid)}>` +
      `${options}</select>`
    );
  }
  return (
    `<input type="text" data-control data-kind="string" data-key="${key}" aria-label="${aria}"` +
    ` value="${escapeHtml(String(row.value))}"${flag("disabled", invalid)}>`
  );
}

function renderRow(row: PanelRow, label: PanelUiLabel): string {
  const invalid = row.source === "invalid";
  const modified = row.source !== "default";
  const deprecated = row.deprecated === true;
  const deprecation = row.deprecationMessage ?? "";
  const hint = appliesHint(row, label);
  const advanced = row.tier === "advanced";
  const resetTitle = invalid ? label(PANEL_UI.resetInvalid) : label(PANEL_UI.reset);
  return [
    `<div class="row" data-row="${escapeHtml(row.key)}" data-tier="${row.tier}" data-source="${row.source}" data-modified="${modified ? "true" : "false"}" data-deprecated="${deprecated ? "true" : "false"}"${flag("hidden", advanced)}>`,
    `  <div class="row-head">`,
    `    <span class="row-title">${escapeHtml(row.title)}</span>`,
    `    <span class="badge badge-modified" data-badge="modified"${flag("hidden", !modified)}>${escapeHtml(label(PANEL_UI.modified))}</span>`,
    `    <span class="badge badge-deprecated" data-badge="deprecated"${flag("hidden", !deprecated)}>${escapeHtml(label(PANEL_UI.deprecated))}</span>`,
    `    <span class="badge badge-invalid" data-badge="invalid"${flag("hidden", !invalid)}>${escapeHtml(label(PANEL_UI.invalid))}</span>`,
    `    <span class="badge badge-source" data-badge="source">${escapeHtml(label(SOURCE_UI[row.source]))}</span>`,
    `  </div>`,
    `  <p class="row-description">${escapeHtml(row.description)}</p>`,
    `  <p class="row-deprecation"${flag("hidden", !deprecated)}>${escapeHtml(deprecation)}</p>`,
    `  <p class="row-applies"${flag("hidden", hint.length === 0)}>${escapeHtml(hint)}</p>`,
    `  <div class="row-control">${renderControl(row, label)}</div>`,
    `  <div class="row-actions">`,
    `    <button type="button" class="link-button" data-action="reset" title="${escapeHtml(resetTitle)}">${escapeHtml(label(PANEL_UI.reset))}</button>`,
    `    <button type="button" class="link-button" data-action="openNative" title="${escapeHtml(label(PANEL_UI.openNative))}">${escapeHtml(label(PANEL_UI.openNative))}</button>`,
    `  </div>`,
    `</div>`,
  ].join("\n");
}

function renderSection(section: PanelSection, label: PanelUiLabel): string {
  const rows = section.rows.map((row) => renderRow(row, label)).join("\n");
  return [
    `<section class="section" data-section="${escapeHtml(section.id)}" data-collapsed="false">`,
    `  <h2 class="section-head">`,
    `    <button type="button" class="section-toggle" data-section-toggle aria-expanded="true" title="${escapeHtml(label(PANEL_UI.toggleSection))}">`,
    `      <span class="section-title">${escapeHtml(section.title)}</span>`,
    `    </button>`,
    `  </h2>`,
    `  <div class="rows">`,
    rows,
    `  </div>`,
    `</section>`,
  ].join("\n");
}

function renderPresets(presets: readonly PanelPreset[], label: PanelUiLabel): string {
  if (presets.length === 0) {
    return "";
  }
  const buttons = presets
    .map(
      (preset) =>
        `<button type="button" class="preset" data-preset="${escapeHtml(preset.id)}"` +
        ` title="${escapeHtml(preset.description)}">${escapeHtml(preset.title)}</button>`,
    )
    .join("\n    ");
  return [
    `<nav class="presets" aria-label="${escapeHtml(label(PANEL_UI.presets))}">`,
    `  <span class="presets-title">${escapeHtml(label(PANEL_UI.presets))}</span>`,
    `  <div class="preset-buttons">`,
    `    ${buttons}`,
    `  </div>`,
    `</nav>`,
  ].join("\n");
}

function renderToolbar(label: PanelUiLabel, hasResource: boolean): string {
  return [
    `<div class="toolbar">`,
    `  <input id="panel-search" type="search" class="search" placeholder="${escapeHtml(label(PANEL_UI.search))}" aria-label="${escapeHtml(label(PANEL_UI.search))}">`,
    `  <label class="toggle"><input id="panel-only-modified" type="checkbox"><span>${escapeHtml(label(PANEL_UI.onlyModified))}</span></label>`,
    `  <label class="toggle"><input id="panel-show-advanced" type="checkbox"><span>${escapeHtml(label(PANEL_UI.showAdvanced))}</span></label>`,
    `  <label class="target"><span>${escapeHtml(label(PANEL_UI.target))}</span>`,
    `    <select id="panel-target">`,
    `      <option value="user"${flag("selected", !hasResource)}>${escapeHtml(label(PANEL_UI.targetUser))}</option>`,
    `      <option value="workspace"${flag("selected", hasResource)}${flag("disabled", !hasResource)} title="${escapeHtml(label(PANEL_UI.targetWorkspaceUnavailable))}">${escapeHtml(label(PANEL_UI.targetWorkspace))}</option>`,
    `    </select>`,
    `  </label>`,
    `</div>`,
  ].join("\n");
}

/**
 * A model embedded in the page's own script. `<` is escaped so a registry
 * string (or a value from `settings.json`) can never close the script element.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The client. Dependency-free, no template literals of its own, and every write
 * to the DOM goes through `textContent`/`setAttribute`.
 *
 * It sends `{ type: "ready" }` once, then one message per user action. The host
 * answers every action with `{ type: "model", model }`, which is applied in
 * place: the document's structure is rendered once, and subsequent models only
 * refresh values, sources and badges. That keeps one renderer instead of two.
 */
function clientScript(initialModel: string): string {
  return `(function () {
  "use strict";
  var api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  var state = ${initialModel};
  var ui = (state && state.ui) || {};
  var SOURCE_KEYS = { default: "panel.source.default", user: "panel.source.user", workspace: "panel.source.workspace", workspaceFolder: "panel.source.workspaceFolder", invalid: "panel.source.invalid" };
  var APPLIES_KEYS = { "next-build": "panel.applies.nextBuild", "next-clean": "panel.applies.nextClean", "view-reload": "panel.applies.viewReload" };
  var rowElements = {};
  var sectionElements = [];
  var presetElements = {};
  var searchInput = document.getElementById("panel-search");
  var onlyModifiedInput = document.getElementById("panel-only-modified");
  var showAdvancedInput = document.getElementById("panel-show-advanced");
  var targetSelect = document.getElementById("panel-target");
  var emptyState = document.getElementById("panel-empty");

  var allRows = document.querySelectorAll("[data-row]");
  for (var rowIndex = 0; rowIndex < allRows.length; rowIndex += 1) {
    rowElements[allRows[rowIndex].getAttribute("data-row")] = allRows[rowIndex];
  }
  var allSections = document.querySelectorAll("[data-section]");
  for (var sectionIndex = 0; sectionIndex < allSections.length; sectionIndex += 1) {
    sectionElements.push(allSections[sectionIndex]);
  }
  var allPresets = document.querySelectorAll("[data-preset]");
  for (var presetIndex = 0; presetIndex < allPresets.length; presetIndex += 1) {
    presetElements[allPresets[presetIndex].getAttribute("data-preset")] = allPresets[presetIndex];
  }

  function post(message) {
    if (api) { api.postMessage(message); }
  }

  function setText(element, value) {
    if (element) { element.textContent = value; }
  }

  function setHidden(element, hidden) {
    if (element) { element.hidden = hidden; }
  }

  function readControl(element) {
    var kind = element.getAttribute("data-kind");
    if (kind === "boolean") { return element.checked; }
    if (kind === "number") {
      if (element.value.trim().length === 0) { return undefined; }
      var parsed = Number(element.value);
      return isFinite(parsed) ? parsed : undefined;
    }
    if (kind === "array") {
      return element.value.split("\\n").map(function (line) { return line.trim(); }).filter(function (line) { return line.length > 0; });
    }
    return element.value;
  }

  function writeControl(element, row) {
    var kind = element.getAttribute("data-kind");
    if (kind === "boolean") { element.checked = row.value === true; }
    else if (kind === "array") { element.value = (row.value || []).join("\\n"); }
    else { element.value = row.value === undefined || row.value === null ? "" : String(row.value); }
    element.disabled = row.source === "invalid";
  }

  function applyRow(row) {
    var element = rowElements[row.key];
    if (!element) { return; }
    element.setAttribute("data-source", row.source);
    element.setAttribute("data-modified", row.source === "default" ? "false" : "true");
    setText(element.querySelector('[data-badge="source"]'), ui[SOURCE_KEYS[row.source]] || row.source);
    setHidden(element.querySelector('[data-badge="modified"]'), row.source === "default");
    setHidden(element.querySelector('[data-badge="deprecated"]'), row.deprecated !== true);
    setHidden(element.querySelector('[data-badge="invalid"]'), row.source !== "invalid");
    var deprecation = element.querySelector(".row-deprecation");
    var message = typeof row.deprecationMessage === "string" ? row.deprecationMessage : "";
    setText(deprecation, message);
    setHidden(deprecation, message.length === 0);
    var applies = element.querySelector(".row-applies");
    var appliesKey = APPLIES_KEYS[row.applies];
    var hint = appliesKey ? (ui[appliesKey] || "") : "";
    setText(applies, hint);
    setHidden(applies, hint.length === 0);
    var input = element.querySelector("[data-control]");
    if (input) { writeControl(input, row); }
  }

  function rowVisible(key, element, query, onlyChanged, advanced) {
    if (!advanced && element.getAttribute("data-tier") === "advanced") { return false; }
    if (onlyChanged && element.getAttribute("data-modified") !== "true") { return false; }
    if (query.length === 0) { return true; }
    var title = element.querySelector(".row-title");
    var description = element.querySelector(".row-description");
    var haystack = key + " " + (title ? title.textContent : "") + " " + (description ? description.textContent : "");
    return haystack.toLowerCase().indexOf(query) >= 0;
  }

  function filter() {
    var query = searchInput ? searchInput.value.trim().toLowerCase() : "";
    var onlyChanged = onlyModifiedInput ? onlyModifiedInput.checked : false;
    var advanced = showAdvancedInput ? showAdvancedInput.checked : false;
    var anySection = false;
    for (var index = 0; index < sectionElements.length; index += 1) {
      var section = sectionElements[index];
      var rows = section.querySelectorAll("[data-row]");
      var anyRow = false;
      for (var inner = 0; inner < rows.length; inner += 1) {
        var element = rows[inner];
        var shown = rowVisible(element.getAttribute("data-row"), element, query, onlyChanged, advanced);
        element.hidden = !shown;
        if (shown) { anyRow = true; }
      }
      section.hidden = !anyRow;
      if (anyRow) { anySection = true; }
    }
    if (emptyState) { emptyState.hidden = anySection; }
  }

  function applyModel(next) {
    if (!next) { return; }
    state = next;
    ui = next.ui || {};
    var sections = next.sections || [];
    for (var index = 0; index < sections.length; index += 1) {
      var rows = sections[index].rows || [];
      for (var inner = 0; inner < rows.length; inner += 1) { applyRow(rows[inner]); }
    }
    var presets = next.presets || [];
    for (var presetIndex = 0; presetIndex < presets.length; presetIndex += 1) {
      var button = presetElements[presets[presetIndex].id];
      if (button) {
        setText(button, presets[presetIndex].title);
        if (typeof presets[presetIndex].description === "string") { button.title = presets[presetIndex].description; }
      }
    }
    filter();
  }

  if (searchInput) { searchInput.addEventListener("input", filter); }
  if (onlyModifiedInput) { onlyModifiedInput.addEventListener("change", filter); }
  if (showAdvancedInput) { showAdvancedInput.addEventListener("change", filter); }

  document.addEventListener("change", function (event) {
    var element = event.target;
    if (!element || typeof element.getAttribute !== "function") { return; }
    if (!element.hasAttribute("data-control")) { return; }
    var row = element.closest("[data-row]");
    if (!row) { return; }
    var value = readControl(element);
    if (value === undefined) { return; }
    post({ type: "update", key: row.getAttribute("data-row"), value: value, target: targetSelect ? targetSelect.value : "user" });
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") { return; }
    var button = target.closest("button");
    if (!button) { return; }
    var preset = button.getAttribute("data-preset");
    if (preset) { post({ type: "preset", id: preset }); return; }
    if (button.hasAttribute("data-section-toggle")) {
      var section = button.closest("[data-section]");
      if (section) {
        var collapsed = section.getAttribute("data-collapsed") === "true";
        section.setAttribute("data-collapsed", collapsed ? "false" : "true");
        button.setAttribute("aria-expanded", collapsed ? "true" : "false");
      }
      return;
    }
    var action = button.getAttribute("data-action");
    if (action === "reset" || action === "openNative") {
      var row = button.closest("[data-row]");
      if (row) {
        if (action === "reset") { post({ type: "reset", key: row.getAttribute("data-row") }); }
        else { post({ type: "openNative", key: row.getAttribute("data-row") }); }
      }
      return;
    }
    if (button.id === "panel-open-mcppls") { post({ type: "openMcpplsSettings" }); }
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (data && data.type === "model" && data.model) { applyModel(data.model); }
  });

  filter();
  post({ type: "ready" });
})();`;
}

/**
 * The whole document. `assets.scriptUri` is accepted for the contract but not
 * used: the client script is inline and nonced, and the CSP names no external
 * script source, so nothing else can be loaded.
 */
export function renderPanelHtml(model: PanelModel, assets: PanelAssets): string {
  const label: PanelUiLabel = (key) => model.ui[key] ?? key;
  const hasResource = model.resourceLabel !== undefined;
  const sections = model.sections.map((section) => renderSection(section, label)).join("\n");
  const lang = model.ui[PANEL_UI.htmlLang] ?? "";
  const resource =
    model.resourceLabel === undefined
      ? ""
      : `<p class="resource-label">${escapeHtml(format(label(PANEL_UI.resourceLabel), [model.resourceLabel]))}</p>`;
  const csp = `default-src 'none'; style-src ${assets.cspSource}; script-src 'nonce-${assets.nonce}'; img-src ${assets.cspSource}`;
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeCsp(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeHtml(assets.styleUri)}">
<title>${escapeHtml(label(PANEL_UI.title))}</title>
</head>
<body>
<header class="panel-header">
  <h1 class="panel-title">${escapeHtml(label(PANEL_UI.title))}</h1>
  <p class="boundary" role="note">${escapeHtml(label(PANEL_UI.boundary))} <button type="button" id="panel-open-mcppls" class="link-button">${escapeHtml(label(PANEL_UI.openMcpplsSettings))}</button></p>
  ${resource}
</header>
${renderToolbar(label, hasResource)}
${renderPresets(model.presets, label)}
<main id="panel-sections">
${sections}
</main>
<p id="panel-empty" class="empty" hidden>${escapeHtml(label(PANEL_UI.noMatches))}</p>
<script nonce="${escapeHtml(assets.nonce)}">
${clientScript(embedJson(model))}
</script>
</body>
</html>
`;
}

/** Values posted back by the webview, decoded and validated. */
export type PanelMessage =
  | { type: "update"; key: string; value: unknown; target: "user" | "workspace" }
  | { type: "reset"; key: string }
  | { type: "preset"; id: string }
  | { type: "openNative"; key: string }
  | { type: "openMcpplsSettings" }
  | { type: "ready" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Decode one `postMessage` payload. Webview input is untrusted: anything that
 * is not exactly one of the six shapes is dropped, and the returned object is
 * rebuilt so foreign fields never travel further.
 *
 * A settings key is always required and always non-empty; `update` additionally
 * needs a write target and a `value` field (the value itself may be anything —
 * `validate.ts` checks it against the registry before it is written).
 */
export function decodePanelMessage(raw: unknown): PanelMessage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  switch (raw.type) {
    case "ready":
      return { type: "ready" };
    case "openMcpplsSettings":
      return { type: "openMcpplsSettings" };
    case "update": {
      if (!nonEmptyString(raw.key) || !("value" in raw)) {
        return undefined;
      }
      if (raw.target !== "user" && raw.target !== "workspace") {
        return undefined;
      }
      return { type: "update", key: raw.key, value: raw.value, target: raw.target };
    }
    case "reset":
      return nonEmptyString(raw.key) ? { type: "reset", key: raw.key } : undefined;
    case "preset":
      return nonEmptyString(raw.id) ? { type: "preset", id: raw.id } : undefined;
    case "openNative":
      return nonEmptyString(raw.key) ? { type: "openNative", key: raw.key } : undefined;
    default:
      return undefined;
  }
}
