/**
 * The package detail page's document, as a pure function (plan §12.1–§12.5).
 *
 * The sidebar answers "which package"; this page answers "what is it, how do I
 * consume it, and how do I add it". It opens in the **editor area** (a
 * `WebviewPanel`, see `src/library/detailPanel.ts`), because a 200 px sidebar
 * cannot show a version matrix and a code block.
 *
 * The same house rules as the other webviews apply: strict CSP, every label from
 * `DetailModel.ui`, every interpolation escaped, no inline `style=`, and no state
 * that is only a colour. Everything shown is either authoritative
 * (`mcpp xpkg parse --json`, `mcpp.toml`) or explicitly attributed (the example
 * code comes from the index's own CI-built test projects, and says so).
 *
 * The example block is tokenized by `indexModel.tokenizeCppLine` — a deliberately
 * small highlighter: comments, strings, the preprocessor directive, a short
 * keyword list and punctuation. It is not a parser and is not meant to be.
 */

import type { ProjectDependencyState } from "./projectState";

import {
  BADGE_UI,
  surfaceLabel,
  tokenizeCppLine,
  type BadgeKey,
  type Surface,
} from "./indexModel";

/** One platform's row in the version matrix. */
export interface DetailVersionGroup {
  platform: string;
  versions: string[];
  /** The platform this extension host is running on. */
  current: boolean;
}

/** One declared dependency, as far as it is cheaply known. */
export interface DetailDependency {
  id: string;
  version?: string;
  /** The version the project's `mcpp.lock` resolved, when it is known. */
  resolved?: string;
  key?: string;
}

/** One window of real example code. */
export interface DetailSnippet {
  file: string;
  startLine: number;
  lines: string[];
  usageLine: number;
  fileKey?: string;
}

/** The outcome of the last `mcpp add`, shown in place. */
export interface DetailResult {
  /** `pending` is the client's own "I asked the host" line, replaced by the answer. */
  state: "ok" | "error" | "pending";
  message: string;
}

/** The workspace's own answer about one package. */
export interface DetailInstalled {
  version: string;
  /** Declared under `[dev-dependencies]`. */
  dev: boolean;
}

export interface DetailModel {
  /** Everything is already localized by the caller. */
  ui: Record<string, string>;
  key?: string;
  generation?: number;
  projectRoot?: string;
  platform?: string;
  projectState?: ProjectDependencyState;
  blockedReason?: string;
  loading?: boolean;
  preview?: boolean;
  busy?: boolean;
  id: string;
  name: string;
  description?: string;
  licenses: string[];
  repo?: string;
  registry: string;
  surface?: Surface;
  surfaces: Surface[];
  badges: BadgeKey[];
  /** The version matrix, current platform first. */
  versions: DetailVersionGroup[];
  /** Every version the current platform has, greatest first. */
  currentVersions: string[];
  /** What `mcpp add` would use by default. */
  latest?: string;
  /**
   * The version this workspace already asks for — `mcpp.toml` first, then
   * `mcpp.lock` — so the page can say "you have this one" and offer the switch
   * instead of a blind add. Absent when the project does not depend on the
   * package, or when the dependency names no version (a path or git entry).
   */
  installed?: DetailInstalled;
  standard?: string;
  dependencies: DetailDependency[];
  includeDirs: string[];
  targets: string[];
  snippets: DetailSnippet[];
  /** The example project the snippets come from, when there is one. */
  exampleProject?: string;
  /**
   * How a reader brings the package into code (§22): the example project's
   * real `import …;` / `#include …` lines when there are any, else the honest
   * synthetic form for the surface. Empty when the surface is not importable.
   */
  usage: string[];
  /** The index site's package page; omitted for a registry that has no site. */
  indexUrl?: string;
  /** `mcpp add {0}@{1}` / with `--dev`, so the preview and the run agree. */
  commandTemplate: string;
  commandDevTemplate: string;
  /** Set when `mcpp xpkg parse` could not be read; the page still renders. */
  parseNotice?: string;
  /** The data source, in plain words, for the footer. */
  dataSource: string;
  result?: DetailResult;
}

export interface DetailAssets {
  cspSource: string;
  nonce: string;
  styleUri: string;
}

/** The `ui` keys the renderer reads, so the caller and the renderer cannot drift. */
export const DETAIL_UI = {
  htmlLang: "detail.htmlLang",
  title: "detail.title",
  project: "detail.project",
  chooseProject: "detail.chooseProject",
  platform: "detail.platform",
  version: "detail.version",
  otherPlatforms: "detail.otherPlatforms",
  declared: "detail.declared",
  locked: "detail.locked",
  sourceDependency: "detail.sourceDependency",
  unknownUsage: "detail.unknownUsage",
  usageSource: "detail.usageSource",
  source: "detail.source",
  loading: "detail.loading",
  pending: "detail.pending",
  groupChange: "detail.groupChange",
  output: "detail.output",
  retry: "detail.retry",
  openManifest: "detail.openManifest",
  openFile: "detail.openFile",
  preview: "detail.preview",
  overview: "detail.overview",
  license: "detail.license",
  repo: "detail.repo",
  openRepo: "detail.openRepo",
  registry: "detail.registry",
  surface: "detail.surface",
  surfaceExternal: "detail.surface.external",
  standard: "detail.standard",
  versions: "detail.versions",
  versionsAll: "detail.versions.all",
  versionsCurrent: "detail.versions.current",
  versionsNone: "detail.versions.none",
  versionsPick: "detail.versions.pick",
  dependencies: "detail.dependencies",
  dependenciesNone: "detail.dependencies.none",
  dependenciesHint: "detail.dependencies.hint",
  resolved: "detail.resolved",
  code: "detail.code",
  codeNone: "detail.code.none",
  codeSource: "detail.code.source",
  codeProject: "detail.code.project",
  add: "detail.add",
  addDev: "detail.addDev",
  switchTo: "detail.switchTo",
  alreadyAdded: "detail.alreadyAdded",
  installed: "detail.installed",
  opening: "detail.opening",
  addLatest: "detail.addLatest",
  addNoVersion: "detail.add.noVersion",
  command: "detail.command",
  usage: "detail.usage",
  copy: "detail.copy",
  copied: "detail.copied",
  copying: "detail.copying",
  indexLink: "detail.indexLink",
  badgeExamples: BADGE_UI.examples.key,
  badgeCn: BADGE_UI.cn.key,
  badgeOpenkalEcosystem: BADGE_UI["openkal-ecosystem"].key,
  badgeOpenkalCompat: BADGE_UI["openkal-compat"].key,
  badgeOpenkalPosix: BADGE_UI["openkal-posix"].key,
  badgeOpenkalPlatform: BADGE_UI["openkal-platform"].key,
  targets: "detail.targets",
  includeDirs: "detail.includeDirs",
} as const;

const BADGE_KEY_UI: Readonly<Record<BadgeKey, string>> = {
  examples: DETAIL_UI.badgeExamples,
  cn: DETAIL_UI.badgeCn,
  "openkal-ecosystem": DETAIL_UI.badgeOpenkalEcosystem,
  "openkal-compat": DETAIL_UI.badgeOpenkalCompat,
  "openkal-posix": DETAIL_UI.badgeOpenkalPosix,
  "openkal-platform": DETAIL_UI.badgeOpenkalPlatform,
};

/**
 * What the page says to the host.
 *
 * There is no `ready`: the document is already the whole model, and a page that
 * announces its own load only invites the host to render it again — which is
 * exactly the reload loop the *library sidebar* shipped with (see the note in
 * `libraryHtml.ts`). This host happened to answer `ready` with an empty `return`,
 * so the trap never fired here; it is gone all the same.
 */
export type DetailMessage =
  | { type: "add"; version: string; dev: boolean }
  | { type: "openUrl"; url: string }
  | { type: "copy"; text: string; token?: string }
  | { type: "selectProject" | "showOutput" | "retry" | "openManifest" | "mounted" }
  | { type: "openDependency" | "openFile"; key: string };

export type UiLabel = (key: string) => string;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeCsp(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function attribute(name: string, value: string | number | undefined): string {
  return value === undefined ? "" : ` ${name}="${escapeHtml(String(value))}"`;
}

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

function badgeLabels(badges: readonly BadgeKey[], label: UiLabel): string[] {
  return badges.map((badge) => label(BADGE_KEY_UI[badge]));
}

/** One source line, tokenized. The renderer escapes every token. */
function renderLine(line: string, usage: boolean): string {
  if (line.length === 0) {
    return "\n";
  }
  const tokens = tokenizeCppLine(line)
    .map((token) => `<span class="tok-${token.kind}">${escapeHtml(token.text)}</span>`)
    .join("");
  return `<span class="code-line"${flag("data-usage", usage)}>${tokens}</span>\n`;
}

function renderSnippets(model: DetailModel, label: UiLabel): string {
  if (model.snippets.length === 0) {
    return `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.codeNone))}</p>`;
  }
  const blocks = model.snippets.map((snippet) => {
    const lines = snippet.lines
      .map((line, index) => renderLine(line, snippet.startLine + index === snippet.usageLine))
      .join("");
    const caption = fill(label, DETAIL_UI.codeSource, [snippet.file, snippet.startLine]);
    return [
      `<div class="snippet-actions"><button class="detail-copy" type="button" data-copy="${escapeHtml(snippet.lines.join("\n"))}">${escapeHtml(label(DETAIL_UI.copy))}</button>${snippet.fileKey === undefined ? "" : `<button class="link-button" type="button" data-open-file="${escapeHtml(snippet.fileKey)}">${escapeHtml(label(DETAIL_UI.openFile))}</button>`}</div>`,
      `<pre class="detail-code"><code>${lines}</code></pre>`,
      `<p class="detail-code-file">${escapeHtml(caption)}</p>`,
    ].join("\n");
  });
  return blocks.join("\n");
}

/**
 * The version matrix, as the page's **selector**: each version is a button that
 * aims the command at the top of the page at itself.
 *
 * A `<select>` and a printed list of the same versions used to sit in two
 * different places, and only the select was interactive, so the list was
 * something to read and the choice was something else to find. One clickable
 * list is both.
 */
function renderVersions(model: DetailModel, label: UiLabel): string {
  if (!model.versions.length) { return `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.versionsNone))}</p>`; }
  const row = (group: DetailVersionGroup) => `<li class="detail-version-group"${flag("data-current", group.current)}>
    <span class="detail-platform">${escapeHtml(group.platform)}</span>
    <span class="detail-version-list">${group.versions.map((version) => `<span class="detail-version"${flag("data-installed", version === model.projectState?.declaredVersion)}>${escapeHtml(version)}</span>`).join("") || "—"}</span>
    ${group.current ? `<span class="detail-current">${escapeHtml(label(DETAIL_UI.versionsCurrent))}</span>` : ""}</li>`;
  return `<ul class="detail-versions">${model.versions.filter((group) => group.current).map(row).join("")}</ul>
    <details data-persist="platforms"><summary>${escapeHtml(label(DETAIL_UI.otherPlatforms))}</summary>
    <ul class="detail-versions">${model.versions.filter((group) => !group.current).map(row).join("")}</ul></details>`;
}

function renderDependencies(model: DetailModel, label: UiLabel): string {
  if (model.dependencies.length === 0) {
    return `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.dependenciesNone))}</p>`;
  }
  const rows = model.dependencies.map((dependency) => {
    const parts = [dependency.version ?? ""];
    if (dependency.resolved !== undefined) {
      parts.push(fill(label, DETAIL_UI.resolved, [dependency.resolved]));
    }
    return (
      `<li>${dependency.key ? `<button class="link-button" type="button" data-open-dependency="${escapeHtml(dependency.key)}">${escapeHtml(dependency.id)}</button>` : `<code>${escapeHtml(dependency.id)}</code>`}` +
      (parts.length === 0 ? "" : ` — ${escapeHtml(parts.join(" · "))}`) +
      `</li>`
    );
  });
  return [
    `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.dependenciesHint))}</p>`,
    `<ul class="detail-deps">`,
    rows.join("\n"),
    `</ul>`,
  ].join("\n");
}

function renderMeta(model: DetailModel, label: UiLabel): string {
  const parts: string[] = [
    `<span class="badge">${escapeHtml(label(DETAIL_UI.registry))}: ${escapeHtml(model.registry)}</span>`,
  ];
  if (model.surface !== undefined) {
    parts.push(
      `<span class="badge">${escapeHtml(label(DETAIL_UI.surface))}: ${escapeHtml(surfaceLabel(model.surface, label))}</span>`,
    );
  }
  if (model.standard !== undefined) {
    parts.push(`<span class="badge">${escapeHtml(label(DETAIL_UI.standard))}: ${escapeHtml(model.standard)}</span>`);
  }
  for (const badge of badgeLabels(model.badges, label)) {
    parts.push(`<span class="badge">${escapeHtml(badge)}</span>`);
  }
  for (const license of model.licenses) {
    parts.push(`<span class="badge">${escapeHtml(license)}</span>`);
  }
  // The repository and index links are actions, not facts, so they live in the
  // button row below rather than at the end of this line.
  return [`<div class="detail-meta">`, parts.join("\n"), `</div>`].join("\n");
}

function renderExtras(model: DetailModel, label: UiLabel): string {
  const blocks: string[] = [];
  if (model.targets.length > 0) {
    blocks.push(
      `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.targets))}: <code>${escapeHtml(model.targets.join(", "))}</code></p>`,
    );
  }
  if (model.includeDirs.length > 0) {
    blocks.push(
      `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.includeDirs))}: <code>${escapeHtml(model.includeDirs.join(", "))}</code></p>`,
    );
  }
  return blocks.join("\n");
}

/**
 * The primary block: what this page is *for*, immediately under the title.
 *
 * It used to be the last thing on the page, below four sections of prose, so the
 * button a reader came for was the one thing they had to scroll to find. The
 * version is chosen in the list below (`renderVersions`), and this block shows
 * the command the choice produces.
 */
function selectedVersion(model: DetailModel): string | undefined {
  const declared = model.projectState?.declaredVersion ?? model.installed?.version;
  return declared !== undefined && model.currentVersions.includes(declared) ? declared : model.latest;
}

function renderActions(model: DetailModel, label: UiLabel): string {
  const version = selectedVersion(model);
  const current = model.projectState;
  const declared = current?.declaredVersion ?? model.installed?.version;
  const dev = current?.dev ?? model.installed?.dev ?? false;
  const already = declared !== undefined && declared === version;
  const blocked = model.blockedReason;
  const link = (url: string, text: string) => `<button type="button" data-secondary data-open-url="${escapeHtml(url)}">${escapeHtml(text)}</button>`;
  const command = (dev ? model.commandDevTemplate : model.commandTemplate).replace("{0}", model.id).replace("{1}", version ?? "?");
  return `<section class="detail-primary" data-section="add" aria-busy="${model.loading || model.busy ? "true" : "false"}">
    <div class="project-context"><span>${escapeHtml(label(DETAIL_UI.project))}: <strong title="${escapeHtml(model.projectRoot ?? "")}">${escapeHtml(model.projectRoot?.split(/[\\/]/).pop() ?? "—")}</strong></span>
      <button class="link-button" type="button" data-action="selectProject">${escapeHtml(label(DETAIL_UI.chooseProject))}</button>
      <span>${escapeHtml(label(DETAIL_UI.platform))}: ${escapeHtml(model.platform ?? "—")}</span></div>
    ${model.loading ? `<p class="detail-hint" role="status">${escapeHtml(label(DETAIL_UI.loading))}</p>` : ""}
    ${model.preview ? `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.preview))}</p>` : ""}
    ${model.preview ? "" : `<div class="detail-controls">
      <label>${escapeHtml(label(DETAIL_UI.version))} <select id="detail-version"${flag("disabled", !!model.loading || !!model.busy || !model.currentVersions.length)}>${model.currentVersions.map((item) => `<option value="${escapeHtml(item)}"${flag("selected", item === version)}>${escapeHtml(item)}</option>`).join("")}</select></label>
      <label class="detail-toggle"><input id="detail-dev" type="checkbox"${flag("checked", dev)}${flag("disabled", !!model.loading || !!model.busy)}><span>${escapeHtml(label(DETAIL_UI.addDev))}</span></label>
      ${declared === undefined ? "" : `<span>${escapeHtml(label(DETAIL_UI.declared))}: ${escapeHtml(declared)}</span>`}
      ${declared && model.latest && model.latest !== declared ? `<span class="detail-current">${escapeHtml(label(DETAIL_UI.version))}: ${escapeHtml(model.latest)} ↑</span>` : ""}
      ${current?.resolvedVersion === undefined ? "" : `<span>${escapeHtml(label(DETAIL_UI.locked))}: ${escapeHtml(current.resolvedVersion)}</span>`}
      ${current?.sourceType === "path-or-git" ? `<span>${escapeHtml(label(DETAIL_UI.sourceDependency))}</span>` : ""}
    </div>`}
    <div class="detail-actions">
      ${model.preview ? "" : `<button type="button" id="detail-add" class="detail-add"${flag("disabled", !!blocked || !version || already || !!model.busy)}${flag("data-installed", already)}>${escapeHtml(model.busy ? label(DETAIL_UI.pending) : already ? label(DETAIL_UI.alreadyAdded) : declared ? fill(label, DETAIL_UI.switchTo, [version ?? "?"]) : label(DETAIL_UI.add))}</button>`}
      ${model.repo === undefined ? "" : link(model.repo, label(DETAIL_UI.openRepo))}
      ${model.indexUrl === undefined ? "" : link(model.indexUrl, label(DETAIL_UI.indexLink))}
      ${current?.declared ? `<button class="link-button" type="button" data-secondary data-action="openManifest">${escapeHtml(label(DETAIL_UI.openManifest))}</button>` : ""}
    </div>
    ${blocked ? `<p class="detail-hint" id="detail-blocked">${escapeHtml(blocked)}</p>` : ""}
    <div class="detail-command-row"><p class="detail-command" id="detail-command">${escapeHtml(model.preview ? `mcpp search ${model.id}` : command)}</p><button type="button" class="detail-copy" data-copy-command>${escapeHtml(label(DETAIL_UI.copy))}</button></div>
    <p id="detail-selection-note" class="detail-hint"></p>
    <p class="detail-result" id="detail-result" role="status"${attribute("data-state", model.result?.state)}${flag("hidden", !model.result)}>${escapeHtml(model.result?.message ?? "")}</p>
    <div class="result-actions" id="detail-result-actions"${flag("hidden", model.result?.state !== "error")}><button class="link-button" type="button" data-action="retry">${escapeHtml(label(DETAIL_UI.retry))}</button><button class="link-button" type="button" data-action="showOutput">${escapeHtml(label(DETAIL_UI.output))}</button></div>
  </section>`;
}

export function detailClientState(model: DetailModel): Record<string, unknown> {
  return {
    key: model.key ?? model.id, generation: model.generation ?? 0, projectRoot: model.projectRoot,
    id: model.id, versions: model.currentVersions, version: selectedVersion(model),
    declared: model.projectState?.declaredVersion ?? model.installed?.version,
    dev: model.projectState?.dev ?? model.installed?.dev ?? false,
    loading: !!model.loading, blocked: !!model.blockedReason, busy: !!model.busy, preview: !!model.preview,
    command: model.commandTemplate, commandDev: model.commandDevTemplate,
    labels: Object.fromEntries(Object.entries(DETAIL_UI).map(([name, key]) => [name, model.ui[key] ?? key])),
  };
}

function clientScript(initialModel: string): string {
  return `(function () {
  "use strict";
  var api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  var state = ${initialModel};
  var saved = api && api.getState ? api.getState() || {} : {};
  var pages = saved.pages || {};
  var busy = state.busy;
  var version = state.version || "";
  var copyId = 0;
  function pageKey() { return state.key + "|" + (state.projectRoot || ""); }
  function post(message) { message.pageKey = state.key; message.generation = state.generation; if (api) { api.postMessage(message); } }
  function persist() {
    if (state.loading) { return; }
    var dev = document.getElementById("detail-dev");
    var expanded = Array.from(document.querySelectorAll("details[data-persist]")).filter(function (node) { return node.open; }).map(function (node) { return node.getAttribute("data-persist"); });
    pages[pageKey()] = { version: version, dev: dev ? dev.checked : false, scroll: window.scrollY, expanded: expanded };
    var keys = Object.keys(pages); while (keys.length > 20) { delete pages[keys.shift()]; }
    if (api && api.setState) { api.setState({ pages: pages }); }
  }
  function update() {
    var select = document.getElementById("detail-version");
    var dev = document.getElementById("detail-dev");
    var button = document.getElementById("detail-add");
    if (state.preview) { return; }
    if (select) { select.value = version; select.disabled = busy || !state.versions.length; }
    if (dev) { dev.disabled = busy; }
    var isDev = dev ? dev.checked : false;
    var groupChange = !!state.declared && isDev !== state.dev;
    var same = !!state.declared && state.declared === version && !groupChange;
    if (button) {
      button.disabled = busy || state.blocked || !version || same || groupChange;
      button.textContent = busy ? state.labels.pending : same ? state.labels.alreadyAdded : state.declared ? state.labels.switchTo.split("{0}").join(version) : state.labels.add;
      if (same) { button.setAttribute("data-installed", ""); } else { button.removeAttribute("data-installed"); }
    }
    var note = document.getElementById("detail-selection-note"); if (note) { note.textContent = groupChange ? state.labels.groupChange : ""; }
    var command = document.getElementById("detail-command");
    if (command) { command.textContent = (isDev ? state.commandDev : state.command).split("{0}").join(state.id).split("{1}").join(version || "?"); }
  }
  function restore() {
    var page = pages[pageKey()] || {};
    if (state.versions.indexOf(page.version) >= 0) { version = page.version; }
    var dev = document.getElementById("detail-dev"); if (dev && typeof page.dev === "boolean") { dev.checked = page.dev; }
    document.querySelectorAll("details[data-persist]").forEach(function (node) { node.open = (page.expanded || []).indexOf(node.getAttribute("data-persist")) >= 0; });
    update(); window.scrollTo(0, page.scroll || 0);
  }
  document.addEventListener("change", function (event) {
    if (event.target.id === "detail-version") { version = event.target.value; }
    if (event.target.id === "detail-version" || event.target.id === "detail-dev") { update(); persist(); }
  });
  document.addEventListener("toggle", persist, true);
  window.addEventListener("scroll", persist);
  document.addEventListener("click", function (event) {
    var target = event.target.closest && event.target.closest("button");
    if (!target || target.disabled) { return; }
    var action = target.getAttribute("data-action");
    if (action) { post({ type: action }); return; }
    if (target.hasAttribute("data-open-dependency")) { persist(); post({ type: "openDependency", key: target.getAttribute("data-open-dependency") }); return; }
    if (target.hasAttribute("data-open-file")) { post({ type: "openFile", key: target.getAttribute("data-open-file") }); return; }
    if (target.hasAttribute("data-open-url")) { post({ type: "openUrl", url: target.getAttribute("data-open-url") }); return; }
    if (target.hasAttribute("data-copy") || target.hasAttribute("data-copy-command")) {
      var token = "copy-" + (++copyId); target.setAttribute("data-copy-token", token);
      post({ type: "copy", text: target.hasAttribute("data-copy") ? target.getAttribute("data-copy") : document.getElementById("detail-command").textContent, token: token }); return;
    }
    if (target.id === "detail-add" && !busy && version) {
      busy = true; update();
      var result = document.getElementById("detail-result"); result.hidden = false; result.dataset.state = "pending"; result.textContent = state.labels.pending;
      persist(); post({ type: "add", version: version, dev: document.getElementById("detail-dev").checked });
    }
  });
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data) { return; }
    if (data.type === "detailUpdate") {
      persist();
      var focused = document.activeElement && document.activeElement.id;
      var doc = new DOMParser().parseFromString(data.html, "text/html");
      ["detail-header", "detail-main", "detail-footer"].forEach(function (id) { var old = document.getElementById(id); var next = doc.getElementById(id); if (old && next) { old.replaceWith(next); } });
      state = data.state; busy = state.busy; version = state.version || "";
      restore();
      var nextFocus = focused && document.getElementById(focused); if (nextFocus) { nextFocus.focus({ preventScroll: true }); }
      return;
    }
    if (data.key !== state.key || data.generation !== state.generation) { return; }
    if (data.type === "copyResult") {
      var copy = document.querySelector('[data-copy-token="' + data.token + '"]');
      if (copy) { copy.textContent = data.message; setTimeout(function () { copy.textContent = state.labels.copy; }, 1800); }
    }
    if (data.type === "linkResult") { var status = document.getElementById("detail-link-result"); status.textContent = data.message; }
  });
  restore();
  post({ type: "mounted" });
})();`;
}

/** A model embedded in the page's own script; `<` is escaped so it cannot close it. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The whole document. */
export function renderDetailHtml(model: DetailModel, assets: DetailAssets): string {
  const label: UiLabel = (key) => model.ui[key] ?? key;
  const csp = `default-src 'none'; style-src ${assets.cspSource}; script-src 'nonce-${assets.nonce}'; img-src ${assets.cspSource}`;
  const title = fill(label, DETAIL_UI.title, [model.id]);
  const currentPlatform = model.versions.find((group) => group.current)?.platform;
  const versionsHeading =
    currentPlatform === undefined ? label(DETAIL_UI.versionsAll) : fill(label, DETAIL_UI.versions, [currentPlatform]);
  return `<!DOCTYPE html>
<html lang="${escapeHtml(model.ui[DETAIL_UI.htmlLang] ?? "")}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeCsp(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeHtml(assets.styleUri)}">
<title>${escapeHtml(title)}</title>
</head>
<body class="detail">
<header class="detail-header" id="detail-header">
  <h1 class="detail-title">${escapeHtml(model.id)}</h1>
  ${model.description === undefined ? "" : `<p class="detail-description">${escapeHtml(model.description)}</p>`}
  ${renderMeta(model, label)}
</header>
<main id="detail-main">
  ${renderActions(model, label)}
  <p class="detail-hint" id="detail-link-result" role="status"></p>
  <div class="detail-layout">
    <section class="detail-section detail-usage" data-section="code">
      <h2>${escapeHtml(label(DETAIL_UI.usage))}</h2>
      ${model.usage.length ? `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.usageSource))}</p>` + model.usage.map((line) => `<div class="detail-usage-line"><code>${escapeHtml(line)}</code><button type="button" class="detail-copy" data-copy="${escapeHtml(line)}">${escapeHtml(label(DETAIL_UI.copy))}</button></div>`).join("") : `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.unknownUsage))}</p>`}
      <h2>${escapeHtml(label(DETAIL_UI.code))}</h2>
      ${renderSnippets(model, label)}
      ${model.exampleProject === undefined ? "" : `<p class="detail-hint">${escapeHtml(fill(label, DETAIL_UI.codeProject, [model.exampleProject]))}</p>`}
    </section>
    <aside class="detail-aside">
      <section class="detail-section" data-section="versions"><h2>${escapeHtml(versionsHeading)}</h2>${renderVersions(model, label)}</section>
      <section class="detail-section" data-section="dependencies"><h2>${escapeHtml(label(DETAIL_UI.dependencies))} (${model.dependencies.length})</h2>${renderDependencies(model, label)}</section>
      ${!model.targets.length && !model.includeDirs.length ? "" : `<details class="detail-section" data-section="build" data-persist="build"><summary>${escapeHtml(label(DETAIL_UI.overview))}</summary>${renderExtras(model, label)}</details>`}
    </aside>
  </div>
</main>
<footer class="detail-footer" id="detail-footer"><details data-persist="source"><summary>${escapeHtml(label(DETAIL_UI.source))}</summary><p>${escapeHtml(model.dataSource)}</p>${model.parseNotice === undefined ? "" : `<p>${escapeHtml(model.parseNotice)}</p>`}</details></footer>
<script nonce="${escapeHtml(assets.nonce)}">
${clientScript(embedJson(detailClientState(model)))}
</script>
</body>
</html>
`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Decode one `postMessage` payload. Webview input is untrusted: anything that is
 * not one of the three shapes is dropped. `openUrl` is restricted to `https`
 * here as well as in the host, so a compromised document cannot ask the host to
 * open a `file:` or `command:` uri.
 */
export function decodeDetailMessage(raw: unknown): DetailMessage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  switch (raw.type) {
    case "mounted":
    case "selectProject":
    case "showOutput":
    case "retry":
    case "openManifest":
      return { type: raw.type };
    case "openDependency":
    case "openFile":
      return nonEmptyString(raw.key) ? { type: raw.type, key: raw.key } : undefined;
    case "add":
      return nonEmptyString(raw.version) && typeof raw.dev === "boolean"
        ? { type: "add", version: raw.version, dev: raw.dev }
        : undefined;
    case "openUrl":
      return typeof raw.url === "string" && raw.url.startsWith("https://")
        ? { type: "openUrl", url: raw.url }
        : undefined;
    case "copy":
      // Clipboard content, same trust level as the https-restricted url. The
      // cap is 16 KiB — far above any command or usage line, low enough that a
      // hostile document cannot park a novel in the clipboard — and everything
      // else about the text is the user's own click.
      return nonEmptyString(raw.text) && raw.text.length <= 16_384
        ? { type: "copy", text: raw.text, ...(typeof raw.token === "string" && /^copy-\d+$/.test(raw.token) ? { token: raw.token } : {}) }
        : undefined;
    default:
      return undefined;
  }
}
