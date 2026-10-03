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
  /** Declared under `[dev-dependencies]`. */
  dev?: boolean;
  /** The resolved (`mcpp.lock`) version, when a caller could supply one. */
  resolved?: string;
}

/** One window of real example code. */
export interface DetailSnippet {
  file: string;
  startLine: number;
  lines: string[];
  usageLine: number;
}

/** The outcome of the last `mcpp add`, shown in place. */
export interface DetailResult {
  state: "ok" | "error";
  message: string;
}

export interface DetailModel {
  /** Everything is already localized by the caller. */
  ui: Record<string, string>;
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
  standard?: string;
  dependencies: DetailDependency[];
  includeDirs: string[];
  targets: string[];
  snippets: DetailSnippet[];
  /** The example project the snippets come from, when there is one. */
  exampleProject?: string;
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
  dev: "detail.dev",
  code: "detail.code",
  codeNone: "detail.code.none",
  codeSource: "detail.code.source",
  codeProject: "detail.code.project",
  add: "detail.add",
  addDev: "detail.addDev",
  addLatest: "detail.addLatest",
  addNoVersion: "detail.add.noVersion",
  command: "detail.command",
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
  | { type: "openUrl"; url: string };

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
  if (model.versions.length === 0) {
    return `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.versionsNone))}</p>`;
  }
  const groups = model.versions
    .map((group) => {
      const list =
        group.versions.length === 0
          ? `<span class="detail-version-empty">—</span>`
          : group.versions
              .map(
                (version) =>
                  `<button type="button" class="detail-version" data-version="${escapeHtml(version)}"` +
                  `${flag("data-selected", version === model.latest)}>${escapeHtml(version)}</button>`,
              )
              .join("");
      return (
        `<li class="detail-version-group"${flag("data-current", group.current)}>` +
        `<span class="detail-platform">${escapeHtml(group.platform)}</span>` +
        `<span class="detail-version-list">${list}</span>` +
        (group.current ? `<span class="detail-current">${escapeHtml(label(DETAIL_UI.versionsCurrent))}</span>` : "") +
        `</li>`
      );
    })
    .join("\n");
  return [
    `<ul class="detail-versions">`,
    groups,
    `</ul>`,
    `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.versionsPick))}</p>`,
  ].join("\n");
}

function renderDependencies(model: DetailModel, label: UiLabel): string {
  if (model.dependencies.length === 0) {
    return `<p class="detail-hint">${escapeHtml(label(DETAIL_UI.dependenciesNone))}</p>`;
  }
  const rows = model.dependencies.map((dependency) => {
    const parts = [dependency.version ?? ""];
    if (dependency.dev === true) {
      parts.push(label(DETAIL_UI.dev));
    }
    if (dependency.resolved !== undefined) {
      parts.push(fill(label, DETAIL_UI.resolved, [dependency.resolved]));
    }
    return (
      `<li><code>${escapeHtml(dependency.id)}</code>` +
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
  if (model.repo !== undefined) {
    parts.push(
      `<a href="${escapeHtml(model.repo)}" data-open-url="${escapeHtml(model.repo)}" rel="noreferrer">${escapeHtml(label(DETAIL_UI.openRepo))}</a>`,
    );
  }
  if (model.indexUrl !== undefined) {
    parts.push(
      `<a href="${escapeHtml(model.indexUrl)}" data-open-url="${escapeHtml(model.indexUrl)}" rel="noreferrer">${escapeHtml(label(DETAIL_UI.indexLink))}</a>`,
    );
  }
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
function renderActions(model: DetailModel, label: UiLabel): string {
  const disabled = model.latest === undefined;
  const command = fill(label, DETAIL_UI.command, [model.id, model.latest ?? "?"]);
  return [
    `<section class="detail-primary" data-section="add">`,
    `  <div class="detail-actions">`,
    `    <button type="button" id="detail-add" class="detail-add"${flag("disabled", disabled)}>${escapeHtml(label(DETAIL_UI.add))}</button>`,
    `    <label class="detail-toggle"><input id="detail-dev" type="checkbox"><span>${escapeHtml(label(DETAIL_UI.addDev))}</span></label>`,
    `  </div>`,
    `  <p class="detail-command" id="detail-command" data-selected-version="${escapeHtml(model.latest ?? "")}" data-template="${escapeHtml(model.commandTemplate)}" data-template-dev="${escapeHtml(model.commandDevTemplate)}">${escapeHtml(command)}</p>`,
    disabled
      ? `  <p class="detail-hint">${escapeHtml(label(DETAIL_UI.addNoVersion))}</p>`
      : `  <p class="detail-hint">${escapeHtml(label(DETAIL_UI.addLatest))}</p>`,
    `  <p class="detail-result" id="detail-result" role="status"${attribute("data-state", model.result?.state)}${model.result === undefined ? " hidden" : ""}>${escapeHtml(model.result?.message ?? "")}</p>`,
    `</section>`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * The client. It posts two things — `add` and `openUrl` — and applies
 * the host's `{type:"result"}` in place, so running `mcpp add` never rebuilds the
 * document and never resets the version the reader picked.
 */
function clientScript(initialModel: string): string {
  return `(function () {
  "use strict";
  var api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  var state = ${initialModel};
  var devInput = document.getElementById("detail-dev");
  var command = document.getElementById("detail-command");
  var result = document.getElementById("detail-result");
  var version = command ? (command.getAttribute("data-selected-version") || "") : "";

  function post(message) {
    if (api) { api.postMessage(message); }
  }

  function fillTemplate(template, values) {
    var out = template;
    for (var index = 0; index < values.length; index += 1) {
      out = out.split("{" + index + "}").join(String(values[index]));
    }
    return out;
  }

  function updateCommand() {
    if (!command) { return; }
    var dev = devInput ? devInput.checked === true : false;
    var template = dev
      ? (command.getAttribute("data-template-dev") || "")
      : (command.getAttribute("data-template") || "");
    command.setAttribute("data-selected-version", version);
    command.textContent = fillTemplate(template, [state.id, version || "?"]);
  }

  /** One version button is the selection; the rest are alternatives. */
  function selectVersion(next) {
    version = next;
    var buttons = document.querySelectorAll("[data-version]");
    for (var index = 0; index < buttons.length; index += 1) {
      var button = buttons[index];
      if (button.getAttribute("data-version") === next) {
        button.setAttribute("data-selected", "");
      } else {
        button.removeAttribute("data-selected");
      }
    }
    updateCommand();
  }

  function showResult(payload) {
    if (!result) { return; }
    result.hidden = false;
    result.setAttribute("data-state", payload.state === "ok" ? "ok" : "error");
    result.textContent = payload.message || "";
  }

  if (devInput) { devInput.addEventListener("change", updateCommand); }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") { return; }
    var link = target.closest("[data-open-url]");
    if (link) {
      event.preventDefault();
      post({ type: "openUrl", url: link.getAttribute("data-open-url") });
      return;
    }
    var pick = target.closest("[data-version]");
    if (pick) {
      selectVersion(pick.getAttribute("data-version") || "");
      return;
    }
    var add = target.closest("#detail-add");
    if (add && !add.disabled) {
      if (!version) { return; }
      post({ type: "add", version: version, dev: devInput ? devInput.checked === true : false });
    }
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (data && data.type === "result" && data.result) { showResult(data.result); }
  });

  updateCommand();
})();`;
}

/** The little state the client needs; the page is already rendered from the rest. */
function clientState(model: DetailModel): Record<string, unknown> {
  return { id: model.id, ...(model.latest === undefined ? {} : { latest: model.latest }) };
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
<header class="detail-header">
  <h1 class="detail-title">${escapeHtml(model.id)}</h1>
  ${model.description === undefined ? "" : `<p class="detail-description">${escapeHtml(model.description)}</p>`}
  ${renderMeta(model, label)}
</header>
<main>
  ${renderActions(model, label)}
  <section class="detail-section" data-section="versions">
    <h2>${escapeHtml(versionsHeading)}</h2>
    ${renderVersions(model, label)}
  </section>
  <section class="detail-section" data-section="dependencies">
    <h2>${escapeHtml(label(DETAIL_UI.dependencies))}</h2>
    ${renderDependencies(model, label)}
  </section>
  <section class="detail-section" data-section="code">
    <h2>${escapeHtml(label(DETAIL_UI.code))}</h2>
    ${renderSnippets(model, label)}
    ${model.exampleProject === undefined ? "" : `<p class="detail-hint">${escapeHtml(fill(label, DETAIL_UI.codeProject, [model.exampleProject]))}</p>`}
  </section>
  <section class="detail-section" data-section="build">
    <h2>${escapeHtml(label(DETAIL_UI.overview))}</h2>
    ${renderExtras(model, label)}
    ${model.parseNotice === undefined ? "" : `<p class="detail-hint">${escapeHtml(model.parseNotice)}</p>`}
  </section>
</main>
<footer class="detail-footer" role="note">${escapeHtml(model.dataSource)}</footer>
<script nonce="${escapeHtml(assets.nonce)}">
${clientScript(embedJson(clientState(model)))}
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
    case "add":
      return nonEmptyString(raw.version) && typeof raw.dev === "boolean"
        ? { type: "add", version: raw.version, dev: raw.dev }
        : undefined;
    case "openUrl":
      return typeof raw.url === "string" && raw.url.startsWith("https://")
        ? { type: "openUrl", url: raw.url }
        : undefined;
    default:
      return undefined;
  }
}
