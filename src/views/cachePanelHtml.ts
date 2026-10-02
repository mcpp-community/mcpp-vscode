/**
 * The cache panel's document, as a pure function (plan §3.4.3, §3.5).
 *
 * `src/views/cachePanel.ts` resolves the cache inventory into a
 * `CachePanelModel`; this module turns that into one self-contained HTML
 * document. No `vscode`, no file system, no network — which is what makes the
 * interesting parts (escaping, the strict CSP, the proportional bars, the empty
 * state) unit-testable.
 *
 * House rules, the same ones `src/config/panelHtml.ts` pins down:
 *
 * - **Strict CSP.** `default-src 'none'` plus exactly three sources: the
 *   stylesheet, the nonced inline script, and the webview's own image source.
 *   There are no external resources and no inline `style=` attributes.
 * - **No hard-coded copy.** Every user-visible label is looked up in
 *   `CachePanelModel.ui`, which the caller has already localized; a key the
 *   caller forgot degrades to the key itself rather than to a blank control.
 * - **No unescaped interpolation.** Every value that reaches the markup goes
 *   through `escapeHtml`.
 * - **State is text plus shape, not colour.** Every bar is drawn twice: once as
 *   inline SVG (shape) and once as a `<table>`-free textual list of the same
 *   figures (text). Colour is decoration, so a high-contrast theme and a screen
 *   reader both get the whole story.
 *
 * The visualisation is CSS plus inline SVG on purpose. A `<rect width>` is not
 * an inline style, so the composition and age bars can be proportional without
 * ever breaking the CSP.
 *
 * Numbers: every size and count is rendered through `model.format`, so this
 * module never chooses binary vs decimal units and never applies a locale. Two
 * figures cannot come from the caller's formatters and are produced here with a
 * canonical, locale-free representation: the *percentage* of a segment (a
 * ratio, not a measurement) and the *age* of a top package (rendered as a UTC
 * ISO-8601 date, with the raw Unix seconds kept in `data-oldest`).
 */

import { format } from "../i18n/translate";

/** One row of the "largest packages" table. */
export interface CachePanelRow {
  label: string;
  entries: number;
  bytes: number;
  /** Unix seconds; the renderer shows it as a locale-free UTC date. */
  oldestAccessed?: number;
}

/** One age bucket: `[fromDays, toDays)`, the last one being the overflow. */
export interface CachePanelBucket {
  fromDays: number;
  toDays?: number;
  entries: number;
  bytes: number;
}

export interface CachePanelModel {
  /** Everything is already localized by the caller. */
  ui: Record<string, string>;
  project: {
    available: boolean;
    note?: string;
    totalBytes: number;
    files: number;
    groups: number;
    staleNote?: string;
    truncated?: string;
  };
  shared: {
    available: boolean;
    note?: string;
    root?: string;
    totalBytes: number;
    totalEntries: number;
    byKind: Array<{ kind: string; entries: number; bytes: number }>;
    buckets: CachePanelBucket[];
    top: CachePanelRow[];
    incomplete: number;
    oldestAccessed?: string;
    newestAccessed?: string;
  };
  legacy?: { bytes: number; path?: string };
  /** Numbers the caller has already formatted, so the renderer needs no locale. */
  format: { bytes: (value: number) => string; count: (value: number) => string };
  limits: {
    topN: number;
    warnAboveGiB: number;
    /** The budget the simulator's input starts from; omitted means "empty". */
    budgetGiB?: number;
  };
  /**
   * The caller's LRU projection for the budget simulator. Optional: when the
   * caller has no estimate the renderer omits the line rather than inventing a
   * number.
   */
  estimate?: string;
}

export interface CachePanelAssets {
  cspSource: string;
  nonce: string;
  styleUri: string;
}

/**
 * The `ui` keys the renderer reads, so the caller and the renderer cannot drift
 * apart on a string. `cachePanel.ts` fills all of them through `t()`.
 */
export const CACHE_PANEL_UI = {
  htmlLang: "cache.htmlLang",
  title: "cache.title",
  boundary: "cache.boundary",
  projectTitle: "cache.project.title",
  projectFiles: "cache.project.files",
  sharedTitle: "cache.shared.title",
  sharedEntries: "cache.shared.entries",
  sharedRoot: "cache.shared.root",
  sharedOldest: "cache.shared.oldest",
  sharedNewest: "cache.shared.newest",
  legacyTitle: "cache.legacy.title",
  legacyPath: "cache.legacy.path",
  unknown: "cache.unknown",
  projectUnavailable: "cache.project.unavailable",
  sharedUnavailable: "cache.shared.unavailable",
  actions: "cache.actions",
  refresh: "cache.action.refresh",
  cleanStale: "cache.action.cleanStale",
  cleanProject: "cache.action.cleanProject",
  prune: "cache.action.prune",
  verify: "cache.action.verify",
  cleanLegacy: "cache.action.cleanLegacy",
  collect: "cache.action.collect",
  details: "cache.action.details",
  detailsFor: "cache.action.detailsFor",
  reasonShared: "cache.reason.shared",
  reasonProject: "cache.reason.project",
  reasonLegacy: "cache.reason.legacy",
  composition: "cache.composition.title",
  compositionHint: "cache.composition.hint",
  compositionEmpty: "cache.composition.empty",
  age: "cache.age.title",
  ageHint: "cache.age.hint",
  ageEmpty: "cache.age.empty",
  ageUnder: "cache.age.under",
  ageRange: "cache.age.range",
  ageOverflow: "cache.age.overflow",
  ageUnknown: "cache.age.unknown",
  top: "cache.top.title",
  topHint: "cache.top.hint",
  topEmpty: "cache.top.empty",
  colLabel: "cache.col.label",
  colEntries: "cache.col.entries",
  colBytes: "cache.col.bytes",
  colOldest: "cache.col.oldest",
  colActions: "cache.col.actions",
  budget: "cache.budget.title",
  budgetHint: "cache.budget.hint",
  budgetLabel: "cache.budget.label",
  budgetUnit: "cache.budget.unit",
  incompleteWarning: "cache.warn.incomplete",
  sizeWarning: "cache.warn.size",
  barsHint: "cache.bars.hint",
} as const;

export type CachePanelMessage =
  | { type: "refresh" }
  | { type: "cleanStale" }
  | { type: "cleanProject" }
  | { type: "collect"; budgetGiB: number }
  | { type: "prune" }
  | { type: "verify" }
  | { type: "cleanLegacy" }
  | { type: "showEntry"; label: string };

type UiLabel = (key: string) => string;

/** The width of the SVG bars, in viewBox units. Independent of the CSS width. */
const BAR_UNITS = 1000;
const BAR_HEIGHT = 22;

/** Anything not a finite number is treated as `0`, so `NaN` never reaches the DOM. */
function finite(value: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

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
function fill(label: UiLabel, key: string, args: readonly unknown[] = []): string {
  return format(label(key), args);
}

/** Percent of `total`, rounded to one decimal, in a locale-free representation. */
function percent(part: number, total: number): number {
  const value = finite(part);
  const whole = finite(total);
  if (whole <= 0) {
    return 0;
  }
  return Math.round((value / whole) * 1000) / 10;
}

/** `60` / `62.5` — canonical, so the tests can assert on it exactly. */
function percentText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A cumulative ratio as viewBox units, rounded so the segments tile exactly. */
function units(ratio: number): number {
  return Math.round(clamp01(ratio) * BAR_UNITS * 1000) / 1000;
}

/** A Unix timestamp as a locale-free absolute time, or `undefined`. */
function isoSeconds(seconds: number | undefined): string | undefined {
  if (seconds === undefined) {
    return undefined;
  }
  const value = finite(seconds);
  return value <= 0 ? undefined : new Date(value * 1000).toISOString();
}

/** One segment of a bar: pre-rendered attributes, a caption and a size. */
interface BarPart {
  /** Already-escaped `data-*` attributes, including a leading space. */
  attributes: string;
  label: string;
  bytes: number;
}

/** Inline SVG: one `<rect>` per part, widths proportional to bytes. */
function renderBar(parts: readonly BarPart[], total: number, className: string): string {
  let cumulative = 0;
  const groups = parts
    .map((part) => {
      const start = units(cumulative / total);
      cumulative += Math.max(0, finite(part.bytes));
      const end = units(cumulative / total);
      const pct = percent(part.bytes, total);
      return [
        `<g${part.attributes} data-bytes="${finite(part.bytes)}" data-percent="${percentText(pct)}">`,
        `  <rect x="${start}" y="0" width="${end - start}" height="${BAR_HEIGHT}"></rect>`,
        `  <title>${escapeHtml(`${part.label}: ${percentText(pct)}%`)}</title>`,
        `</g>`,
      ].join("\n");
    })
    .join("\n");
  return [
    `<svg class="${className}" viewBox="0 0 ${BAR_UNITS} ${BAR_HEIGHT}" preserveAspectRatio="none" aria-hidden="true" focusable="false">`,
    groups,
    `</svg>`,
  ].join("\n");
}

function renderSection(id: string, title: string, body: string): string {
  return [
    `<section class="viz" data-viz="${escapeHtml(id)}">`,
    `  <h2 class="viz-title">${escapeHtml(title)}</h2>`,
    body,
    `</section>`,
  ].join("\n");
}

/** One source segment of the composition bar, before percentages are known. */
interface CompositionSource {
  kind: string;
  segment: "kind" | "legacy";
  caption: string;
  bytes: number;
  entries?: number;
}

/** The composition bar: one segment per kind, plus the pre-v1 legacy cache. */
function renderComposition(model: CachePanelModel, label: UiLabel): string {
  const formatters = model.format;
  const unknown = label(CACHE_PANEL_UI.unknown);
  const sources: CompositionSource[] = [];
  const legacyBytes = finite(model.legacy?.bytes ?? 0);

  if (model.shared.available) {
    for (const entry of model.shared.byKind) {
      sources.push({
        kind: entry.kind,
        segment: "kind",
        caption: entry.kind.length === 0 ? unknown : entry.kind,
        bytes: entry.bytes,
        entries: entry.entries,
      });
    }
  }
  if (legacyBytes > 0) {
    sources.push({ kind: "legacy", segment: "legacy", caption: label(CACHE_PANEL_UI.legacyTitle), bytes: legacyBytes });
  }

  const total = sources.reduce((sum, source) => sum + Math.max(0, finite(source.bytes)), 0);
  const parts: BarPart[] = [];
  const legend: string[] = [];
  for (const source of sources) {
    // `data-kind` stays the raw mcpp value: it is the hook the stylesheet and
    // the tests select on, so a translated caption must not change it.
    const attributes = ` data-kind="${escapeHtml(source.kind)}" data-segment="${source.segment}"`;
    parts.push({ attributes, label: source.caption, bytes: source.bytes });
    const values = [`${percentText(percent(source.bytes, total))}%`, formatters.bytes(finite(source.bytes))];
    if (source.entries !== undefined) {
      values.push(formatters.count(finite(source.entries)));
    }
    legend.push(
      `<li${attributes} data-percent="${percentText(percent(source.bytes, total))}">` +
        `<span class="swatch"${attributes} aria-hidden="true"></span>` +
        `<span class="legend-label">${escapeHtml(source.caption)}</span>` +
        `<span class="legend-value">${escapeHtml(values.join(" · "))}</span>` +
        `</li>`,
    );
  }

  const hint = `<p class="hint">${escapeHtml(label(CACHE_PANEL_UI.compositionHint))}</p>`;
  if (parts.length === 0 || total <= 0) {
    return renderSection("composition", label(CACHE_PANEL_UI.composition), `${hint}\n<p class="empty">${escapeHtml(label(CACHE_PANEL_UI.compositionEmpty))}</p>`);
  }
  const body = [
    hint,
    renderBar(parts, total, "viz-bar"),
    `<ul class="legend" data-legend="composition">`,
    legend.join("\n"),
    `</ul>`,
  ].join("\n");
  return renderSection("composition", label(CACHE_PANEL_UI.composition), body);
}

/** One age bucket, with its caption already resolved. */
interface AgeSource {
  caption: string;
  bytes: number;
  entries: number;
  oldest: boolean;
  index: number;
}

/** The age distribution bar: one segment per bucket, `<1d` through the overflow. */
function renderAge(model: CachePanelModel, label: UiLabel): string {
  const formatters = model.format;
  const buckets = model.shared.available ? model.shared.buckets : [];
  const sources: AgeSource[] = [];
  let accounted = 0;

  buckets.forEach((bucket, index) => {
    const from = finite(bucket.fromDays);
    const to = bucket.toDays === undefined ? undefined : finite(bucket.toDays);
    const caption =
      to === undefined
        ? fill(label, CACHE_PANEL_UI.ageOverflow, [formatters.count(from)])
        : from <= 0
          ? fill(label, CACHE_PANEL_UI.ageUnder, [formatters.count(to)])
          : fill(label, CACHE_PANEL_UI.ageRange, [formatters.count(from), formatters.count(to)]);
    sources.push({
      caption,
      bytes: bucket.bytes,
      entries: bucket.entries,
      oldest: index === buckets.length - 1,
      index,
    });
    accounted += finite(bucket.entries);
  });

  const ageTotal = sources.reduce((sum, source) => sum + Math.max(0, finite(source.bytes)), 0);
  const parts: BarPart[] = [];
  const legend: string[] = [];
  for (const source of sources) {
    const attributes = ` data-bucket="${source.oldest ? "oldest" : "recent"}" data-bucket-index="${source.index}"`;
    parts.push({ attributes, label: source.caption, bytes: source.bytes });
    legend.push(
      `<li${attributes} data-percent="${percentText(percent(source.bytes, ageTotal))}">` +
        `<span class="swatch"${attributes} aria-hidden="true"></span>` +
        `<span class="legend-label">${escapeHtml(source.caption)}</span>` +
        `<span class="legend-value">${escapeHtml(`${formatters.bytes(finite(source.bytes))} · ${formatters.count(finite(source.entries))}`)}</span>` +
        `</li>`,
    );
  }

  const hints = [`<p class="hint">${escapeHtml(label(CACHE_PANEL_UI.ageHint))}</p>`];
  const unaccounted = finite(model.shared.totalEntries) - accounted;
  if (model.shared.available && unaccounted > 0) {
    hints.push(`<p class="hint">${escapeHtml(fill(label, CACHE_PANEL_UI.ageUnknown, [formatters.count(unaccounted)]))}</p>`);
  }
  if (parts.length === 0 || ageTotal <= 0) {
    hints.push(`<p class="empty">${escapeHtml(label(CACHE_PANEL_UI.ageEmpty))}</p>`);
    return renderSection("age", label(CACHE_PANEL_UI.age), hints.join("\n"));
  }
  const body = [
    hints.join("\n"),
    renderBar(parts, ageTotal, "viz-bar"),
    `<ul class="legend" data-legend="age">`,
    legend.join("\n"),
    `</ul>`,
  ].join("\n");
  return renderSection("age", label(CACHE_PANEL_UI.age), body);
}

/** The largest packages, each row carrying its label and a `showEntry` button. */
function renderTop(model: CachePanelModel, label: UiLabel): string {
  const formatters = model.format;
  const head =
    `<tr>` +
    `<th scope="col">${escapeHtml(label(CACHE_PANEL_UI.colLabel))}</th>` +
    `<th scope="col">${escapeHtml(label(CACHE_PANEL_UI.colEntries))}</th>` +
    `<th scope="col">${escapeHtml(label(CACHE_PANEL_UI.colBytes))}</th>` +
    `<th scope="col">${escapeHtml(label(CACHE_PANEL_UI.colOldest))}</th>` +
    `<th scope="col">${escapeHtml(label(CACHE_PANEL_UI.colActions))}</th>` +
    `</tr>`;

  const rows = model.shared.top.map((row) => {
    const iso = isoSeconds(row.oldestAccessed);
    const oldest =
      iso === undefined
        ? `<span class="unknown">${escapeHtml(label(CACHE_PANEL_UI.unknown))}</span>`
        : `<time datetime="${escapeHtml(iso)}" data-oldest="${escapeHtml(String(finite(row.oldestAccessed ?? 0)))}">${escapeHtml(iso.slice(0, 10))}</time>`;
    return [
      `<tr data-label="${escapeHtml(row.label)}">`,
      `  <td class="cell-label">${escapeHtml(row.label)}</td>`,
      `  <td>${escapeHtml(formatters.count(finite(row.entries)))}</td>`,
      `  <td>${escapeHtml(formatters.bytes(finite(row.bytes)))}</td>`,
      `  <td>${oldest}</td>`,
      `  <td><button type="button" data-show-entry="${escapeHtml(row.label)}" aria-label="${escapeHtml(fill(label, CACHE_PANEL_UI.detailsFor, [row.label]))}" title="${escapeHtml(fill(label, CACHE_PANEL_UI.detailsFor, [row.label]))}">${escapeHtml(label(CACHE_PANEL_UI.details))}</button></td>`,
      `</tr>`,
    ].join("\n");
  });

  const body =
    model.shared.top.length === 0
      ? `<p class="empty">${escapeHtml(label(CACHE_PANEL_UI.topEmpty))}</p>`
      : [
          `<p class="hint">${escapeHtml(fill(label, CACHE_PANEL_UI.topHint, [formatters.count(finite(model.limits.topN))]))}</p>`,
          `<table class="top-table">`,
          `<thead>${head}</thead>`,
          `<tbody>`,
          rows.join("\n"),
          `</tbody>`,
          `</table>`,
        ].join("\n");
  return renderSection(
    "top",
    fill(label, CACHE_PANEL_UI.top, [formatters.count(finite(model.limits.topN))]),
    body,
  );
}

/** The budget simulator: a GiB input, a `collect` button, and the estimate. */
function renderBudget(model: CachePanelModel, label: UiLabel): string {
  const disabled = !model.shared.available;
  const budget = model.limits.budgetGiB;
  const value = budget === undefined || !Number.isFinite(budget) ? undefined : Math.max(0, Math.floor(budget));
  const notes = [`<p class="hint">${escapeHtml(label(CACHE_PANEL_UI.budgetHint))}</p>`];
  if (model.estimate !== undefined && model.estimate.length > 0) {
    notes.push(`<p class="estimate">${escapeHtml(model.estimate)}</p>`);
  }
  notes.push(
    `<div class="budget-row">`,
    `  <label class="budget-label" for="cache-budget">${escapeHtml(label(CACHE_PANEL_UI.budgetLabel))}</label>`,
    `  <input id="cache-budget" type="number" min="0" step="1" inputmode="numeric" aria-label="${escapeHtml(label(CACHE_PANEL_UI.budgetLabel))}"${attribute("value", value)}${flag("disabled", disabled)}>`,
    `  <span class="budget-unit">${escapeHtml(label(CACHE_PANEL_UI.budgetUnit))}</span>`,
    `  <button type="button" data-action="collect"${flag("disabled", disabled)} title="${escapeHtml(disabled ? reasonText(label, CACHE_PANEL_UI.reasonShared, model.shared.note) : label(CACHE_PANEL_UI.collect))}">${escapeHtml(label(CACHE_PANEL_UI.collect))}</button>`,
    `</div>`,
  );
  return renderSection("budget", label(CACHE_PANEL_UI.budget), notes.join("\n"));
}

/** `Reason` plus the caller's explanation, when there is one. */
function reasonText(label: UiLabel, key: string, note?: string): string {
  const base = label(key);
  return note === undefined || note.length === 0 ? base : `${base} ${note}`;
}

function renderActions(model: CachePanelModel, label: UiLabel): string {
  const sharedAvailable = model.shared.available;
  const projectAvailable = model.project.available;
  const anyAvailable = sharedAvailable || projectAvailable;
  const legacyBytes = finite(model.legacy?.bytes ?? 0);
  const sharedReason = reasonText(label, CACHE_PANEL_UI.reasonShared, model.shared.note);
  const projectReason = reasonText(label, CACHE_PANEL_UI.reasonProject, model.project.note);
  const refreshReason = sharedAvailable ? projectReason : sharedReason;

  const button = (action: string, text: string, disabled: boolean, reason: string): string =>
    `<button type="button" data-action="${action}"${flag("disabled", disabled)} title="${escapeHtml(disabled ? reason : text)}">${escapeHtml(text)}</button>`;

  return [
    `<div class="actions" role="toolbar" aria-label="${escapeHtml(label(CACHE_PANEL_UI.actions))}">`,
    `  ${button("refresh", label(CACHE_PANEL_UI.refresh), !anyAvailable, refreshReason)}`,
    `  ${button("cleanStale", label(CACHE_PANEL_UI.cleanStale), !projectAvailable, projectReason)}`,
    `  ${button("cleanProject", label(CACHE_PANEL_UI.cleanProject), !projectAvailable, projectReason)}`,
    `  ${button("prune", label(CACHE_PANEL_UI.prune), !sharedAvailable, sharedReason)}`,
    `  ${button("verify", label(CACHE_PANEL_UI.verify), !sharedAvailable, sharedReason)}`,
    `  ${button("cleanLegacy", label(CACHE_PANEL_UI.cleanLegacy), !(legacyBytes > 0), label(CACHE_PANEL_UI.reasonLegacy))}`,
    `</div>`,
  ].join("\n");
}

function renderCards(model: CachePanelModel, label: UiLabel): string {
  const formatters = model.format;
  const unknown = label(CACHE_PANEL_UI.unknown);

  const projectNotes: string[] = [];
  if (!model.project.available) {
    projectNotes.push(model.project.note ?? label(CACHE_PANEL_UI.projectUnavailable));
  } else {
    projectNotes.push(fill(label, CACHE_PANEL_UI.projectFiles, [formatters.count(finite(model.project.files)), formatters.count(finite(model.project.groups))]));
    if (model.project.staleNote !== undefined) projectNotes.push(model.project.staleNote);
    if (model.project.note !== undefined) projectNotes.push(model.project.note);
    if (model.project.truncated !== undefined) projectNotes.push(model.project.truncated);
  }

  const sharedNotes: string[] = [];
  if (!model.shared.available) {
    sharedNotes.push(model.shared.note ?? label(CACHE_PANEL_UI.sharedUnavailable));
  } else {
    sharedNotes.push(fill(label, CACHE_PANEL_UI.sharedEntries, [formatters.count(finite(model.shared.totalEntries))]));
    if (model.shared.root !== undefined) sharedNotes.push(fill(label, CACHE_PANEL_UI.sharedRoot, [model.shared.root]));
    if (model.shared.oldestAccessed !== undefined) sharedNotes.push(fill(label, CACHE_PANEL_UI.sharedOldest, [model.shared.oldestAccessed]));
    if (model.shared.newestAccessed !== undefined) sharedNotes.push(fill(label, CACHE_PANEL_UI.sharedNewest, [model.shared.newestAccessed]));
    if (model.shared.note !== undefined) sharedNotes.push(model.shared.note);
  }

  const card = (id: string, title: string, value: string, notes: readonly string[]): string =>
    [
      `<article class="card" data-card="${escapeHtml(id)}">`,
      `  <h2 class="card-title">${escapeHtml(title)}</h2>`,
      `  <p class="card-value">${escapeHtml(value)}</p>`,
      notes.map((note) => `  <p class="card-note">${escapeHtml(note)}</p>`).join("\n"),
      `</article>`,
    ]
      .filter((line) => line.length > 0)
      .join("\n");

  const cards = [
    card(
      "project",
      label(CACHE_PANEL_UI.projectTitle),
      model.project.available ? formatters.bytes(finite(model.project.totalBytes)) : unknown,
      projectNotes,
    ),
    card(
      "shared",
      label(CACHE_PANEL_UI.sharedTitle),
      model.shared.available ? formatters.bytes(finite(model.shared.totalBytes)) : unknown,
      sharedNotes,
    ),
  ];
  if (model.legacy !== undefined) {
    const legacyNotes =
      model.legacy.path === undefined ? [] : [fill(label, CACHE_PANEL_UI.legacyPath, [model.legacy.path])];
    cards.push(card("legacy", label(CACHE_PANEL_UI.legacyTitle), formatters.bytes(finite(model.legacy.bytes)), legacyNotes));
  }
  return `<section class="cards">\n${cards.join("\n")}\n</section>`;
}

function renderWarnings(model: CachePanelModel, label: UiLabel): string {
  const formatters = model.format;
  const warnings: string[] = [];
  if (model.shared.available && finite(model.shared.incomplete) > 0) {
    warnings.push(
      `<p class="warning" role="note"><span class="marker" aria-hidden="true">&#9888;</span> ${escapeHtml(
        fill(label, CACHE_PANEL_UI.incompleteWarning, [formatters.count(finite(model.shared.incomplete))]),
      )}</p>`,
    );
  }
  const threshold = finite(model.limits.warnAboveGiB);
  const gib = finite(model.shared.totalBytes) / 1024 ** 3;
  if (threshold > 0 && gib >= threshold) {
    warnings.push(
      `<p class="warning" role="note"><span class="marker" aria-hidden="true">&#9888;</span> ${escapeHtml(
        fill(label, CACHE_PANEL_UI.sizeWarning, [
          formatters.bytes(finite(model.shared.totalBytes)),
          formatters.bytes(threshold * 1024 ** 3),
        ]),
      )}</p>`,
    );
  }
  return warnings.length === 0 ? "" : `<section class="warnings">\n${warnings.join("\n")}\n</section>`;
}

/**
 * The client. Dependency-free, no template literals of its own, and it only
 * posts messages: the host re-renders the whole document after every action, so
 * there is exactly one renderer instead of two.
 */
function clientScript(): string {
  return `(function () {
  "use strict";
  var api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

  function post(message) {
    if (api) { api.postMessage(message); }
  }

  function budgetGiB() {
    var input = document.getElementById("cache-budget");
    if (!input) { return undefined; }
    var text = String(input.value).trim();
    if (text.length === 0) { return undefined; }
    var value = Number(text);
    if (!isFinite(value) || value < 0) { return undefined; }
    return value;
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") { return; }
    var button = target.closest("button");
    if (!button || button.disabled) { return; }
    var entry = button.getAttribute("data-show-entry");
    if (entry) { post({ type: "showEntry", label: entry }); return; }
    var action = button.getAttribute("data-action");
    if (!action) { return; }
    if (action === "collect") {
      var value = budgetGiB();
      if (value === undefined) { return; }
      post({ type: "collect", budgetGiB: value });
      return;
    }
    post({ type: action });
  });
})();`;
}

/** The whole document. */
export function renderCachePanelHtml(model: CachePanelModel, assets: CachePanelAssets): string {
  const label: UiLabel = (key) => model.ui[key] ?? key;
  const csp = `default-src 'none'; style-src ${assets.cspSource}; script-src 'nonce-${assets.nonce}'; img-src ${assets.cspSource}`;
  const body = [
    renderWarnings(model, label),
    renderCards(model, label),
    renderActions(model, label),
    renderComposition(model, label),
    renderAge(model, label),
    renderTop(model, label),
    renderBudget(model, label),
    `<p class="bars-hint">${escapeHtml(label(CACHE_PANEL_UI.barsHint))}</p>`,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="${escapeHtml(model.ui[CACHE_PANEL_UI.htmlLang] ?? "")}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeCsp(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeHtml(assets.styleUri)}">
<title>${escapeHtml(label(CACHE_PANEL_UI.title))}</title>
</head>
<body>
<header class="panel-header">
  <h1 class="panel-title">${escapeHtml(label(CACHE_PANEL_UI.title))}</h1>
  <p class="boundary" role="note">${escapeHtml(label(CACHE_PANEL_UI.boundary))}</p>
</header>
<main>
${body}
</main>
<script nonce="${escapeHtml(assets.nonce)}">
${clientScript()}
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
 * not exactly one of the eight shapes is dropped, and the returned object is
 * rebuilt so foreign fields never travel further.
 *
 * `collect` needs a finite, non-negative `budgetGiB`; a payload without one is
 * not a request this panel can honour.
 */
export function decodeCachePanelMessage(raw: unknown): CachePanelMessage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  switch (raw.type) {
    case "refresh":
    case "cleanStale":
    case "cleanProject":
    case "prune":
    case "verify":
    case "cleanLegacy":
      return { type: raw.type };
    case "collect": {
      const budget = raw.budgetGiB;
      if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) {
        return undefined;
      }
      return { type: "collect", budgetGiB: budget };
    }
    case "showEntry":
      return nonEmptyString(raw.label) ? { type: "showEntry", label: raw.label } : undefined;
    default:
      return undefined;
  }
}
