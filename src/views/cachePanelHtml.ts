/**
 * The cache view's document, as a pure function (plan §8.1).
 *
 * `src/views/cachePanel.ts` resolves the cache inventory into a
 * `CachePanelModel`; this module turns that into one self-contained HTML
 * document. No `vscode`, no file system, no network — which is what makes the
 * interesting parts (escaping, the strict CSP, the proportional bars, the
 * collapsed global block, the empty state) unit-testable.
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
 *   inline SVG (shape) and once as the text of the row beside it (the legend, or
 *   the figure line under the project bar). Colour is decoration, so a
 *   high-contrast theme and a screen reader both get the whole story.
 *
 * §8.1 puts one primary bar in the document (the project block's, 6 px) and
 * compresses the legend into a single wrapped line separated by `·`; the type
 * scale is 26 / 12 / 11 px and everything is separated by whitespace rather than
 * nested borders. The global block is a real `<details>` that renders
 * **collapsed**: the markup carries no `open` attribute.
 *
 * The visualisation is CSS plus inline SVG on purpose. A `<rect width>` is not
 * an inline style, so the bars can be proportional without ever breaking the
 * CSP. Bar *heights* are class-driven (`media/cache.css`), never inline.
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
    /**
     * Bytes mcpp would drop with `mcpp clean --stale`. Optional on purpose:
     * nothing in this extension can know that figure today (mcpp owns the
     * staleness rule), so the block renders the line and the split bar only
     * when a caller supplies one.
     */
    staleBytes?: number;
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
   * The caller's LRU projection for the budget control. Optional: when the
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
 * The `ui` keys the panel uses, so the caller and the renderer cannot drift
 * apart on a string. `cachePanel.ts` fills all of them through `t()`.
 */
export const CACHE_PANEL_UI = {
  htmlLang: "cache.htmlLang",
  title: "cache.title",
  boundary: "cache.boundary",
  projectTitle: "cache.project.title",
  projectFiles: "cache.project.files",
  projectStale: "cache.project.stale",
  sharedTitle: "cache.shared.title",
  sharedEntries: "cache.shared.entries",
  sharedRoot: "cache.shared.root",
  legacyTitle: "cache.legacy.title",
  legacyPath: "cache.legacy.path",
  unknown: "cache.unknown",
  projectUnavailable: "cache.project.unavailable",
  sharedUnavailable: "cache.shared.unavailable",
  actions: "cache.actions",
  cleanStale: "cache.action.cleanStale",
  cleanProject: "cache.action.cleanProject",
  prune: "cache.action.prune",
  verify: "cache.action.verify",
  cleanLegacy: "cache.action.cleanLegacy",
  collect: "cache.action.collect",
  detailsFor: "cache.action.detailsFor",
  reasonShared: "cache.reason.shared",
  reasonProject: "cache.reason.project",
  reasonLegacy: "cache.reason.legacy",
  composition: "cache.composition.title",
  compositionEmpty: "cache.composition.empty",
  age: "cache.age.title",
  ageEmpty: "cache.age.empty",
  ageUnder: "cache.age.under",
  ageRange: "cache.age.range",
  ageOverflow: "cache.age.overflow",
  ageUnknown: "cache.age.unknown",
  top: "cache.top.title",
  topEmpty: "cache.top.empty",
  colLabel: "cache.col.label",
  colEntries: "cache.col.entries",
  colBytes: "cache.col.bytes",
  colOldest: "cache.col.oldest",
  budgetLabel: "cache.budget.label",
  budgetHint: "cache.budget.hint",
  budgetUnit: "cache.budget.unit",
  incompleteWarning: "cache.warn.incomplete",
  sizeWarning: "cache.warn.size",
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

/**
 * `"12.4 MiB"` -> the 26 px value and the small unit beside it. The split is
 * pure text: the renderer never re-formats a number, so binary and decimal read
 * the same way they do everywhere else in the extension. A figure with no space
 * (`"1000B"`) is rendered as one value with no unit element.
 */
function splitMetric(text: string): { value: string; unit?: string } {
  const at = text.lastIndexOf(" ");
  if (at <= 0 || at === text.length - 1) {
    return { value: text };
  }
  return { value: text.slice(0, at), unit: text.slice(at + 1) };
}

/** The primary figure: 26 px value, small unit, tabular figures (plan §8.1). */
function renderMetric(text: string): string {
  const parts = splitMetric(text);
  const unit = parts.unit === undefined ? "" : `<span class="metric-unit">${escapeHtml(parts.unit)}</span>`;
  return `<p class="metric"><span class="metric-value">${escapeHtml(parts.value)}</span>${unit}</p>`;
}

/** One segment of a bar: pre-rendered attributes, a caption and a size. */
interface BarPart {
  /** Already-escaped `data-*` attributes, including a leading space. */
  attributes: string;
  label: string;
  bytes: number;
}

/**
 * Inline SVG: one `<rect>` per part, widths proportional to bytes. `className`
 * chooses the height (6 px or 14 px) — the renderer never sets a style.
 *
 * Without an `ariaLabel` the graphic is decoration for the labelled text beside
 * it; with one it becomes the shape whose name carries the same figure.
 */
function renderBar(parts: readonly BarPart[], total: number, className: string, ariaLabel?: string): string {
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
  const semantics =
    ariaLabel === undefined
      ? ` aria-hidden="true" focusable="false"`
      : ` role="img" aria-label="${escapeHtml(ariaLabel)}" focusable="false"`;
  return [
    `<svg class="${className}" viewBox="0 0 ${BAR_UNITS} ${BAR_HEIGHT}" preserveAspectRatio="none"${semantics}>`,
    groups,
    `</svg>`,
  ].join("\n");
}

/**
 * The legend, compressed into **one line** (§8.1): every item is inline, the
 * `·` separators are generated by the stylesheet, and all items share a single
 * `<ul>` so the line wraps as text rather than as rows.
 */
function renderLegend(id: string, items: readonly string[]): string {
  return `<ul class="legend legend-inline" data-legend="${escapeHtml(id)}" role="list">${items.join("")}</ul>`;
}

/** One legend item: swatch (shape), caption (text) and share (text). */
function legendItem(attributes: string, caption: string, pct: number, detail: string): string {
  return (
    `<li class="legend-item"${attributes} data-percent="${percentText(pct)}" role="listitem" title="${escapeHtml(detail)}">` +
    `<span class="swatch"${attributes} aria-hidden="true"></span>` +
    `<span class="legend-label">${escapeHtml(caption)}</span>` +
    `<span class="legend-value">${escapeHtml(`${percentText(pct)}%`)}</span>` +
    `</li>`
  );
}

/** `Reason` plus the caller's explanation, when there is one. */
function reasonText(label: UiLabel, key: string, note?: string): string {
  const base = label(key);
  return note === undefined || note.length === 0 ? base : `${base} ${note}`;
}

function button(action: string, text: string, disabled: boolean, reason: string): string {
  return (
    `<button type="button" data-action="${action}"${flag("disabled", disabled)}` +
    ` title="${escapeHtml(disabled ? reason : text)}">${escapeHtml(text)}</button>`
  );
}

// ─────────────────────────────────────────────────────────────── warnings

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

// ────────────────────────────────────────────────────────── project cache

/**
 * The project block, always on screen (§8.1): the primary figure, one line of
 * secondary figures, one 6 px bar, the stale line when a caller can name it, and
 * the two project actions.
 */
function renderProjectBlock(model: CachePanelModel, label: UiLabel): string {
  const formatters = model.format;
  const available = model.project.available;
  const total = Math.max(0, finite(model.project.totalBytes));
  const value = available ? formatters.bytes(total) : label(CACHE_PANEL_UI.unknown);

  const parts: string[] = [
    `<section class="block block-project" data-block="project">`,
    `  <h2 class="block-heading">${escapeHtml(label(CACHE_PANEL_UI.projectTitle))}</h2>`,
    `  ${renderMetric(value)}`,
  ];

  if (available) {
    parts.push(
      `  <p class="metric-sub">${escapeHtml(
        fill(label, CACHE_PANEL_UI.projectFiles, [
          formatters.count(finite(model.project.files)),
          formatters.count(finite(model.project.groups)),
        ]),
      )}</p>`,
    );
  } else {
    parts.push(
      `  <p class="metric-sub">${escapeHtml(model.project.note ?? label(CACHE_PANEL_UI.projectUnavailable))}</p>`,
    );
  }

  const stale = available ? Math.max(0, finite(model.project.staleBytes ?? 0)) : 0;
  if (available && stale > 0 && total > 0) {
    const bar = renderBar(
      [
        {
          attributes: ` data-segment="stale"`,
          label: fill(label, CACHE_PANEL_UI.projectStale, [formatters.bytes(stale)]),
          bytes: stale,
        },
        {
          attributes: ` data-segment="current"`,
          label: label(CACHE_PANEL_UI.projectTitle),
          bytes: Math.max(0, total - stale),
        },
      ],
      total,
      "viz-bar viz-bar-thin project-bar",
      fill(label, CACHE_PANEL_UI.projectStale, [formatters.bytes(stale)]),
    );
    parts.push(`  ${bar}`);
    parts.push(
      `  <p class="metric-note">${escapeHtml(
        fill(label, CACHE_PANEL_UI.projectStale, [formatters.bytes(stale)]),
      )}</p>`,
    );
  }

  if (available && model.project.truncated !== undefined) {
    parts.push(`  <p class="metric-note">${escapeHtml(model.project.truncated)}</p>`);
  }
  if (available && model.project.note !== undefined) {
    parts.push(`  <p class="metric-note">${escapeHtml(model.project.note)}</p>`);
  }

  const reason = reasonText(label, CACHE_PANEL_UI.reasonProject, model.project.note);
  parts.push(
    `  <div class="actions" role="toolbar" aria-label="${escapeHtml(label(CACHE_PANEL_UI.projectTitle))}">`,
    `    ${button("cleanStale", label(CACHE_PANEL_UI.cleanStale), !available, reason)}`,
    `    ${button("cleanProject", label(CACHE_PANEL_UI.cleanProject), !available, reason)}`,
    `  </div>`,
  );
  parts.push(`</section>`);
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────── global cache

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
    sources.push({
      kind: "legacy",
      segment: "legacy",
      caption: label(CACHE_PANEL_UI.legacyTitle),
      bytes: legacyBytes,
    });
  }

  const total = sources.reduce((sum, source) => sum + Math.max(0, finite(source.bytes)), 0);
  const aria = label(CACHE_PANEL_UI.composition);
  if (sources.length === 0 || total <= 0) {
    return [
      `<section class="viz" data-viz="composition" aria-label="${escapeHtml(aria)}">`,
      `  <p class="empty">${escapeHtml(label(CACHE_PANEL_UI.compositionEmpty))}</p>`,
      `</section>`,
    ].join("\n");
  }

  const parts: BarPart[] = [];
  const items: string[] = [];
  for (const source of sources) {
    // `data-kind` stays the raw mcpp value: it is the hook the stylesheet and
    // the tests select on, so a translated caption must not change it.
    const attributes = ` data-kind="${escapeHtml(source.kind)}" data-segment="${source.segment}"`;
    parts.push({ attributes, label: source.caption, bytes: source.bytes });
    const pct = percent(source.bytes, total);
    const detail = [
      source.caption,
      `${percentText(pct)}%`,
      formatters.bytes(finite(source.bytes)),
      ...(source.entries === undefined ? [] : [formatters.count(finite(source.entries))]),
    ].join(" · ");
    items.push(legendItem(attributes, source.caption, pct, detail));
  }

  return [
    `<section class="viz" data-viz="composition" aria-label="${escapeHtml(aria)}">`,
    `  ${renderBar(parts, total, "viz-bar")}`,
    `  ${renderLegend("composition", items)}`,
    `</section>`,
  ].join("\n");
}

/** One age bucket, with its caption already resolved. */
interface AgeSource {
  caption: string;
  bytes: number;
  entries: number;
  oldest: boolean;
  index: number;
}

/** How many colours the age ramp has: cold/fresh through hot/old. */
export const AGE_RAMP_STEPS = 4;

/**
 * Where one age bucket sits on the ramp, `0` (newest) to `3` (oldest).
 *
 * The bar used to paint every bucket but the last in one colour, so four
 * segments read as a single block and the chart said nothing that the legend
 * under it did not already say. The step is computed here, in the renderer,
 * rather than in CSS, because the bucket count follows `mcpp.cache.staleDays`
 * and the stylesheet cannot count. A two-bucket machine gets the two ends, a
 * four-bucket one gets all four, and anything longer is dealt onto the same four
 * stops — the ramp is a shape, not a promise about how many buckets exist.
 */
export function ageRampStep(index: number, count: number): number {
  if (!Number.isFinite(index) || !Number.isFinite(count) || count <= 1) {
    return 0;
  }
  const clamped = Math.min(Math.max(index, 0), count - 1);
  return Math.round((clamped / (count - 1)) * (AGE_RAMP_STEPS - 1));
}

/** The age bar: one segment per bucket, `<1d` through the overflow. */
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
  const heading = `<h3 class="viz-heading">${escapeHtml(label(CACHE_PANEL_UI.age))}</h3>`;
  const notes: string[] = [];
  const unaccounted = finite(model.shared.totalEntries) - accounted;
  if (model.shared.available && unaccounted > 0) {
    notes.push(
      `<p class="viz-note">${escapeHtml(
        fill(label, CACHE_PANEL_UI.ageUnknown, [formatters.count(unaccounted)]),
      )}</p>`,
    );
  }

  if (sources.length === 0 || ageTotal <= 0) {
    return [
      `<section class="viz" data-viz="age">`,
      `  ${heading}`,
      ...notes.map((note) => `  ${note}`),
      `  <p class="empty">${escapeHtml(label(CACHE_PANEL_UI.ageEmpty))}</p>`,
      `</section>`,
    ].join("\n");
  }

  const parts: BarPart[] = [];
  const items: string[] = [];
  for (const source of sources) {
    const step = ageRampStep(source.index, sources.length);
    const attributes =
      ` data-bucket="${source.oldest ? "oldest" : "recent"}"` +
      ` data-bucket-index="${source.index}" data-age-step="${step}"`;
    parts.push({ attributes, label: source.caption, bytes: source.bytes });
    const pct = percent(source.bytes, ageTotal);
    const detail = [
      source.caption,
      `${percentText(pct)}%`,
      formatters.bytes(finite(source.bytes)),
      formatters.count(finite(source.entries)),
    ].join(" · ");
    items.push(legendItem(attributes, source.caption, pct, detail));
  }

  return [
    `<section class="viz" data-viz="age">`,
    `  ${heading}`,
    ...notes.map((note) => `  ${note}`),
    `  ${renderBar(parts, ageTotal, "viz-bar viz-bar-thin")}`,
    `  ${renderLegend("age", items)}`,
    `</section>`,
  ].join("\n");
}

/**
 * The largest packages, inside a second collapsed `<details>` (§8.1). Each label
 * is itself the `showEntry` button, so dropping the old "Actions" column does
 * not drop the drill-down.
 */
function renderTop(model: CachePanelModel, label: UiLabel): string {
  const formatters = model.format;
  if (model.shared.top.length === 0) {
    return [
      `<section class="viz" data-viz="top">`,
      `  <p class="empty">${escapeHtml(label(CACHE_PANEL_UI.topEmpty))}</p>`,
      `</section>`,
    ].join("\n");
  }

  const head: Array<[string, string]> = [
    [CACHE_PANEL_UI.colLabel, label(CACHE_PANEL_UI.colLabel)],
    [CACHE_PANEL_UI.colEntries, label(CACHE_PANEL_UI.colEntries)],
    [CACHE_PANEL_UI.colBytes, label(CACHE_PANEL_UI.colBytes)],
    [CACHE_PANEL_UI.colOldest, label(CACHE_PANEL_UI.colOldest)],
  ];
  const header = `<tr>${head.map(([, text]) => `<th scope="col">${escapeHtml(text)}</th>`).join("")}</tr>`;

  const rows = model.shared.top.map((row) => {
    const iso = isoSeconds(row.oldestAccessed);
    const oldest =
      iso === undefined
        ? `<span class="unknown">${escapeHtml(label(CACHE_PANEL_UI.unknown))}</span>`
        : `<time datetime="${escapeHtml(iso)}" data-oldest="${escapeHtml(String(finite(row.oldestAccessed ?? 0)))}">${escapeHtml(iso.slice(0, 10))}</time>`;
    const detailsFor = fill(label, CACHE_PANEL_UI.detailsFor, [row.label]);
    return [
      `<tr data-label="${escapeHtml(row.label)}">`,
      // `data-head` carries the column name onto the cell, so the stylesheet can
      // stack the table into labelled rows at 200 px without a second renderer.
      `  <td class="cell-label" data-head="${escapeHtml(label(CACHE_PANEL_UI.colLabel))}">` +
        `<button type="button" class="link" data-show-entry="${escapeHtml(row.label)}" title="${escapeHtml(detailsFor)}" aria-label="${escapeHtml(detailsFor)}">${escapeHtml(row.label)}</button></td>`,
      `  <td data-head="${escapeHtml(label(CACHE_PANEL_UI.colEntries))}">${escapeHtml(formatters.count(finite(row.entries)))}</td>`,
      `  <td data-head="${escapeHtml(label(CACHE_PANEL_UI.colBytes))}">${escapeHtml(formatters.bytes(finite(row.bytes)))}</td>`,
      `  <td data-head="${escapeHtml(label(CACHE_PANEL_UI.colOldest))}">${oldest}</td>`,
      `</tr>`,
    ].join("\n");
  });

  return [
    `<details class="viz viz-details" data-viz="top" data-details="top">`,
    `  <summary class="viz-summary">${escapeHtml(
      fill(label, CACHE_PANEL_UI.top, [formatters.count(finite(model.limits.topN))]),
    )}</summary>`,
    `  <table class="top-table">`,
    `    <thead>${header}</thead>`,
    `    <tbody>`,
    rows.join("\n"),
    `    </tbody>`,
    `  </table>`,
    `</details>`,
  ].join("\n");
}

/**
 * The ones that must be asked for (plan §8.1): the budget input stays next to
 * the button that uses it — `mcpp cache gc --max-size` has no implicit default,
 * so the figure has to come from somewhere the user can see.
 */
function renderSharedActions(model: CachePanelModel, label: UiLabel): string {
  const sharedAvailable = model.shared.available;
  const legacyBytes = finite(model.legacy?.bytes ?? 0);
  const sharedReason = reasonText(label, CACHE_PANEL_UI.reasonShared, model.shared.note);
  const budget = model.limits.budgetGiB;
  const value = budget === undefined || !Number.isFinite(budget) ? undefined : Math.max(0, Math.floor(budget));
  const budgetHint = label(CACHE_PANEL_UI.budgetHint);
  const estimate =
    model.estimate === undefined || model.estimate.length === 0
      ? ""
      : `<span class="budget-estimate">${escapeHtml(model.estimate)}</span>`;
  return [
    `<div class="actions actions-shared" role="toolbar" aria-label="${escapeHtml(label(CACHE_PANEL_UI.actions))}">`,
    `  ${button("verify", label(CACHE_PANEL_UI.verify), !sharedAvailable, sharedReason)}`,
    `  <span class="budget">`,
    `    ${button("collect", label(CACHE_PANEL_UI.collect), !sharedAvailable, sharedReason)}`,
    `    <input id="cache-budget" type="number" min="0" step="1" inputmode="numeric" aria-label="${escapeHtml(label(CACHE_PANEL_UI.budgetLabel))}" title="${escapeHtml(budgetHint)}"${attribute("value", value)}${flag("disabled", !sharedAvailable)}>`,
    `    <span class="budget-unit">${escapeHtml(label(CACHE_PANEL_UI.budgetUnit))}</span>`,
    `  </span>`,
    `  ${estimate}`,
    `  ${button("prune", label(CACHE_PANEL_UI.prune), !sharedAvailable, sharedReason)}`,
    legacyBytes > 0
      ? `  ${button("cleanLegacy", label(CACHE_PANEL_UI.cleanLegacy), false, label(CACHE_PANEL_UI.reasonLegacy))}`
      : "",
    `</div>`,
  ].filter((line) => line.length > 0).join("\n");
}

/**
 * The global block. Expanded it is the composition bar, the age bar, the nested
 * largest-packages list and the shared actions; collapsed it is one summary line
 * (`7.20 GiB · 657 entries`). The markup carries **no `open` attribute**, which
 * is what makes the first render collapsed.
 */
function renderSharedBlock(model: CachePanelModel, label: UiLabel): string {
  const formatters = model.format;
  const notes: string[] = [];
  if (model.shared.root !== undefined) {
    notes.push(
      `<p class="viz-note">${escapeHtml(fill(label, CACHE_PANEL_UI.sharedRoot, [model.shared.root]))}</p>`,
    );
  }
  if (model.legacy !== undefined && model.legacy.path !== undefined) {
    notes.push(
      `<p class="viz-note">${escapeHtml(fill(label, CACHE_PANEL_UI.legacyPath, [model.legacy.path]))}</p>`,
    );
  }

  const body = [
    renderComposition(model, label),
    renderAge(model, label),
    renderTop(model, label),
    renderSharedActions(model, label),
    ...notes,
  ].join("\n");

  if (!model.shared.available) {
    // A failure must not be hidden behind a collapsed disclosure: render the
    // block open, with the reason where the summary would have been.
    return [
      `<section class="block block-shared" data-block="shared">`,
      `  <h2 class="block-heading">${escapeHtml(label(CACHE_PANEL_UI.sharedTitle))}</h2>`,
      `  <p class="metric-sub">${escapeHtml(model.shared.note ?? label(CACHE_PANEL_UI.sharedUnavailable))}</p>`,
      renderSharedActions(model, label),
      `</section>`,
    ].join("\n");
  }

  const summary = `${formatters.bytes(finite(model.shared.totalBytes))} · ${fill(
    label,
    CACHE_PANEL_UI.sharedEntries,
    [formatters.count(finite(model.shared.totalEntries))],
  )}`;
  return [
    `<details class="block block-shared" data-block="shared" data-details="shared">`,
    `  <summary class="block-summary">`,
    `    <span class="summary-title">${escapeHtml(label(CACHE_PANEL_UI.sharedTitle))}</span>`,
    `    <span class="summary-value">${escapeHtml(summary)}</span>`,
    `  </summary>`,
    `  <div class="block-body">`,
    body,
    `  </div>`,
    `</details>`,
  ].join("\n");
}

// ───────────────────────────────────────────────────────────────── client

/**
 * The client. Dependency-free, no template literals of its own, and it only
 * posts messages: the host re-renders the whole document after every action, so
 * there is exactly one renderer instead of two.
 *
 * The open/closed state of the two `<details>` is the one thing the client
 * remembers (`setState`), so re-rendering after an action does not re-collapse
 * the block the user just opened. The document itself still ships collapsed.
 */
function clientScript(): string {
  return `(function () {
  "use strict";
  var api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  var saved = {};
  if (api && typeof api.getState === "function") {
    try { saved = api.getState() || {}; } catch (error) { saved = {}; }
  }

  function post(message) {
    if (api) { api.postMessage(message); }
  }

  function detailsList() {
    return document.querySelectorAll("details[data-details]");
  }

  function restoreOpen() {
    var open = saved && typeof saved.open === "object" && saved.open !== null ? saved.open : {};
    var all = detailsList();
    for (var index = 0; index < all.length; index += 1) {
      var id = all[index].getAttribute("data-details");
      if (id && open[id] === true) { all[index].open = true; }
    }
  }

  function rememberOpen() {
    var open = {};
    var all = detailsList();
    for (var index = 0; index < all.length; index += 1) {
      var id = all[index].getAttribute("data-details");
      if (id) { open[id] = all[index].open === true; }
    }
    saved.open = open;
    if (api && typeof api.setState === "function") { api.setState(saved); }
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

  // A toggle event does not bubble, so the listener captures it on the way down.
  document.addEventListener("toggle", function (event) {
    var target = event.target;
    if (target && typeof target.getAttribute === "function" && target.hasAttribute("data-details")) {
      rememberOpen();
    }
  }, true);

  restoreOpen();
})();`;
}

// ───────────────────────────────────────────────────────────── the document

/** The whole document. */
export function renderCachePanelHtml(model: CachePanelModel, assets: CachePanelAssets): string {
  const label: UiLabel = (key) => model.ui[key] ?? key;
  const csp = `default-src 'none'; style-src ${assets.cspSource}; script-src 'nonce-${assets.nonce}'; img-src ${assets.cspSource}`;
  const body = [
    renderWarnings(model, label),
    renderProjectBlock(model, label),
    renderSharedBlock(model, label),
    `<p class="boundary" role="note">${escapeHtml(label(CACHE_PANEL_UI.boundary))}</p>`,
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
<h1 class="sr-only">${escapeHtml(label(CACHE_PANEL_UI.title))}</h1>
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
