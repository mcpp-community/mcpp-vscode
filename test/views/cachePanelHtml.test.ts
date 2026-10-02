import assert from "node:assert/strict";
import test from "node:test";

import {
  CACHE_PANEL_UI,
  decodeCachePanelMessage,
  renderCachePanelHtml,
  type CachePanelAssets,
  type CachePanelModel,
} from "../../src/views/cachePanelHtml";

const ASSETS: CachePanelAssets = {
  cspSource: "vscode-webview://cache",
  nonce: "nonce-cache123",
  styleUri: "vscode-webview://cache/media/cache.css",
};

const UI: Record<string, string> = {
  [CACHE_PANEL_UI.htmlLang]: "en",
  [CACHE_PANEL_UI.title]: "Cache statistics",
  [CACHE_PANEL_UI.boundary]: "Sizes are estimates.",
  [CACHE_PANEL_UI.projectTitle]: "Project artifacts",
  [CACHE_PANEL_UI.projectFiles]: "{0} file(s) · {1} group(s)",
  [CACHE_PANEL_UI.sharedTitle]: "Global build cache",
  [CACHE_PANEL_UI.sharedEntries]: "{0} entries",
  [CACHE_PANEL_UI.sharedRoot]: "Root: {0}",
  [CACHE_PANEL_UI.sharedOldest]: "Oldest use: {0}",
  [CACHE_PANEL_UI.sharedNewest]: "Newest use: {0}",
  [CACHE_PANEL_UI.legacyTitle]: "Pre-v1 cache",
  [CACHE_PANEL_UI.legacyPath]: "Path: {0}",
  [CACHE_PANEL_UI.unknown]: "not recorded",
  [CACHE_PANEL_UI.projectUnavailable]: "Project artifacts could not be measured.",
  [CACHE_PANEL_UI.sharedUnavailable]: "The shared build cache could not be read.",
  [CACHE_PANEL_UI.actions]: "Cache actions",
  [CACHE_PANEL_UI.refresh]: "Refresh",
  [CACHE_PANEL_UI.cleanStale]: "Clean stale artifacts",
  [CACHE_PANEL_UI.cleanProject]: "Clean project artifacts",
  [CACHE_PANEL_UI.prune]: "Drop entries unused for a while",
  [CACHE_PANEL_UI.verify]: "Verify the cache",
  [CACHE_PANEL_UI.cleanLegacy]: "Remove the pre-v1 cache",
  [CACHE_PANEL_UI.collect]: "Collect to this budget",
  [CACHE_PANEL_UI.details]: "Details",
  [CACHE_PANEL_UI.detailsFor]: "Show cache entry details for {0}",
  [CACHE_PANEL_UI.reasonShared]: "The shared build cache is not available.",
  [CACHE_PANEL_UI.reasonProject]: "Project artifacts are not available.",
  [CACHE_PANEL_UI.reasonLegacy]: "There is no pre-v1 cache to remove.",
  [CACHE_PANEL_UI.composition]: "Composition by kind",
  [CACHE_PANEL_UI.compositionHint]: "Share of the total cache size, by entry kind.",
  [CACHE_PANEL_UI.compositionEmpty]: "No cache entries were found.",
  [CACHE_PANEL_UI.age]: "Age distribution",
  [CACHE_PANEL_UI.ageHint]: "Bytes and entries by how long ago they were last used.",
  [CACHE_PANEL_UI.ageEmpty]: "No entry has a recorded last use.",
  [CACHE_PANEL_UI.ageUnder]: "under {0} day(s)",
  [CACHE_PANEL_UI.ageRange]: "{0}–{1} day(s)",
  [CACHE_PANEL_UI.ageOverflow]: "more than {0} day(s)",
  [CACHE_PANEL_UI.ageUnknown]: "{0} entries have no recorded last use.",
  [CACHE_PANEL_UI.top]: "Largest packages (top {0})",
  [CACHE_PANEL_UI.topHint]: "The {0} largest cache labels, by bytes.",
  [CACHE_PANEL_UI.topEmpty]: "No cache label was read.",
  [CACHE_PANEL_UI.colLabel]: "Label",
  [CACHE_PANEL_UI.colEntries]: "Entries",
  [CACHE_PANEL_UI.colBytes]: "Size",
  [CACHE_PANEL_UI.colOldest]: "Oldest use",
  [CACHE_PANEL_UI.colActions]: "Actions",
  [CACHE_PANEL_UI.budget]: "Budget simulator",
  [CACHE_PANEL_UI.budgetHint]: "Simulates mcpp cache gc --max-size.",
  [CACHE_PANEL_UI.budgetLabel]: "Keep the shared build cache under",
  [CACHE_PANEL_UI.budgetUnit]: "GiB",
  [CACHE_PANEL_UI.incompleteWarning]: "{0} cache entries are incomplete.",
  [CACHE_PANEL_UI.sizeWarning]: "The shared build cache is {0}, at or above the {1} warning threshold.",
  [CACHE_PANEL_UI.barsHint]: "The same figures are listed as text next to each bar.",
};

interface PageOptions {
  project?: Partial<CachePanelModel["project"]>;
  shared?: Partial<CachePanelModel["shared"]>;
  legacy?: CachePanelModel["legacy"];
  limits?: Partial<CachePanelModel["limits"]>;
  estimate?: string;
}

/**
 * A known cache: 500 B in two kinds (300 B `pkg`, 200 B `std`) and, when asked
 * for, a 500 B pre-v1 cache — so the composition percentages are exactly
 * 30 / 20 / 50 and the SVG widths are 300 / 200 / 500 out of 1000.
 */
function makeModel(options: PageOptions = {}): CachePanelModel {
  return {
    ui: UI,
    project: { available: true, totalBytes: 1000, files: 3, groups: 1, ...options.project },
    shared: {
      available: true,
      totalBytes: 500,
      totalEntries: 4,
      byKind: [
        { kind: "pkg", entries: 3, bytes: 300 },
        { kind: "std", entries: 1, bytes: 200 },
      ],
      buckets: [
        { fromDays: 0, toDays: 1, entries: 1, bytes: 100 },
        { fromDays: 1, toDays: 7, entries: 1, bytes: 100 },
        { fromDays: 7, toDays: 30, entries: 1, bytes: 100 },
        { fromDays: 30, entries: 1, bytes: 200 },
      ],
      top: [{ label: "zlib", entries: 2, bytes: 200, oldestAccessed: 1_758_636_000 }],
      incomplete: 0,
      ...options.shared,
    },
    format: { bytes: (value) => `${value}B`, count: (value) => `c${value}` },
    limits: { topN: 5, warnAboveGiB: 0, ...options.limits },
    ...(options.legacy === undefined ? {} : { legacy: options.legacy }),
    ...(options.estimate === undefined ? {} : { estimate: options.estimate }),
  };
}

function page(options: PageOptions = {}): string {
  return renderCachePanelHtml(makeModel(options), ASSETS);
}

test("the document carries the nonce and the strict CSP", () => {
  const html = page();
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("style-src vscode-webview://cache;"));
  assert.ok(html.includes("script-src 'nonce-nonce-cache123'"));
  assert.ok(html.includes('img-src vscode-webview://cache"'));
  assert.ok(html.includes('<script nonce="nonce-cache123">'));
  assert.ok(!/https?:\/\//.test(html), "no external resources");
  assert.ok(!/ style="/.test(html), "no inline style attributes");
});

test("a label containing markup is escaped", () => {
  const html = page({
    shared: { top: [{ label: 'pkg<script>alert("x")</script>', entries: 1, bytes: 10 }] },
  });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("pkg&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
});

test("the composition bar widths are proportional to bytes", () => {
  const html = page({ legacy: { bytes: 500 } });
  assert.ok(html.includes('data-kind="pkg" data-segment="kind" data-bytes="300" data-percent="30"'));
  assert.ok(html.includes('data-kind="std" data-segment="kind" data-bytes="200" data-percent="20"'));
  assert.ok(html.includes('data-kind="legacy" data-segment="legacy" data-bytes="500" data-percent="50"'));
  assert.ok(html.includes('<rect x="0" y="0" width="300"'));
  assert.ok(html.includes('<rect x="300" y="0" width="200"'));
  assert.ok(html.includes('<rect x="500" y="0" width="500"'));
  // Each segment is also a labelled text row, so the bar is never the only source.
  assert.ok(html.includes("30% · 300B · c3"));
  assert.ok(html.includes("50% · 500B"));
});

test("the composition is empty rather than NaN when nothing is cached", () => {
  const html = page({
    shared: { totalBytes: 0, totalEntries: 0, byKind: [], buckets: [], top: [], incomplete: 0 },
  });
  assert.ok(html.includes("No cache entries were found."));
  assert.ok(html.includes("No entry has a recorded last use."));
  assert.ok(!html.includes("NaN"));
  assert.ok(!html.includes("Infinity"));
});

test("an empty kind keeps a machine-readable data-kind and a localized caption", () => {
  const html = page({ shared: { byKind: [{ kind: "", entries: 1, bytes: 10 }] } });
  assert.ok(html.includes('data-kind="" data-segment="kind"'), "data-kind stays the raw mcpp value");
  assert.ok(html.includes("not recorded"), "the caption is the caller's localized word");
});

test("the age bar has one segment per bucket, labelled with bytes and counts", () => {
  const html = page();
  for (let index = 0; index < 4; index += 1) {
    assert.ok(html.includes(`data-bucket-index="${index}"`), `missing bucket ${index}`);
  }
  assert.ok(!html.includes('data-bucket-index="4"'), "the overflow bucket is the last one");
  assert.ok(html.includes('data-bucket="oldest"'));
  assert.ok(html.includes('data-percent="40"'), "200 B of 500 B is the overflow bucket");
  assert.ok(html.includes("under c1 day(s)"));
  assert.ok(html.includes("c1–c7 day(s)"));
  assert.ok(html.includes("c7–c30 day(s)"));
  assert.ok(html.includes("more than c30 day(s)"));
  assert.ok(html.includes("100B · c1"));
  assert.ok(html.includes("200B · c1"));
});

test("the warnAboveGiB threshold produces the warning", () => {
  const over = page({ shared: { totalBytes: 2 * 1024 ** 3 }, limits: { warnAboveGiB: 1 } });
  assert.ok(over.includes("The shared build cache is 2147483648B, at or above the 1073741824B warning threshold."));

  const equal = page({ shared: { totalBytes: 1024 ** 3 }, limits: { warnAboveGiB: 1 } });
  assert.ok(equal.includes("at or above"), "the threshold is inclusive");

  const under = page({ shared: { totalBytes: 1024 ** 3 }, limits: { warnAboveGiB: 2 } });
  assert.ok(!under.includes("warning threshold"));

  const off = page({ shared: { totalBytes: 8 * 1024 ** 3 }, limits: { warnAboveGiB: 0 } });
  assert.ok(!off.includes("warning threshold"), "0 disables the warning");
});

test("incomplete entries produce the warning", () => {
  assert.ok(page({ shared: { incomplete: 2 } }).includes("2 cache entries are incomplete."));
  assert.ok(!page().includes("cache entries are incomplete"));
});

test("the largest packages table carries each label and a details button", () => {
  const html = page();
  assert.ok(html.includes('data-label="zlib"'));
  assert.ok(html.includes('data-show-entry="zlib"'));
  assert.ok(html.includes("Show cache entry details for zlib"));
  assert.ok(html.includes("Largest packages (top c5)"));
  assert.ok(html.includes('data-oldest="1758636000"'));
  assert.ok(html.includes('datetime="2025-09-23T14:00:00.000Z"'));
});

test("every action is disabled, with a reason, when its data is unavailable", () => {
  const html = page({ project: { available: false }, shared: { available: false } });
  for (const action of ["refresh", "cleanStale", "cleanProject", "prune", "verify", "cleanLegacy"]) {
    assert.ok(new RegExp(`data-action="${action}" disabled`).test(html), `${action} should be disabled`);
  }
  assert.ok(/data-action="collect" disabled/.test(html));
  assert.ok(html.includes('title="The shared build cache is not available."'));
  assert.ok(html.includes('title="Project artifacts are not available."'));
  assert.ok(html.includes('title="There is no pre-v1 cache to remove."'));
});

test("an action is enabled when its data is available", () => {
  const html = page({ legacy: { bytes: 10 } });
  for (const action of ["refresh", "cleanStale", "cleanProject", "prune", "verify", "cleanLegacy"]) {
    assert.ok(new RegExp(`data-action="${action}"(?! disabled)`).test(html), `${action} should be enabled`);
  }
  assert.ok(!/data-action="collect" disabled/.test(html));
});

test("a disabled action carries the caller's explanation of why", () => {
  const html = page({ shared: { available: false, note: "the workspace is not trusted" } });
  assert.ok(html.includes('title="The shared build cache is not available. the workspace is not trusted"'));
});

test("the budget simulator shows the estimate only when the caller supplied one", () => {
  const withEstimate = page({ estimate: "About 300B would be freed (1 entries).", limits: { budgetGiB: 2 } });
  assert.ok(withEstimate.includes("About 300B would be freed (1 entries)."));
  assert.ok(withEstimate.includes('id="cache-budget"'));
  assert.ok(withEstimate.includes('value="2"'));

  const without = page();
  assert.ok(!without.includes('class="estimate"'));
  assert.ok(without.includes('id="cache-budget"'));
});

test("decodeCachePanelMessage accepts every valid shape", () => {
  assert.deepEqual(decodeCachePanelMessage({ type: "refresh" }), { type: "refresh" });
  assert.deepEqual(decodeCachePanelMessage({ type: "cleanStale" }), { type: "cleanStale" });
  assert.deepEqual(decodeCachePanelMessage({ type: "cleanProject" }), { type: "cleanProject" });
  assert.deepEqual(decodeCachePanelMessage({ type: "collect", budgetGiB: 4 }), { type: "collect", budgetGiB: 4 });
  assert.deepEqual(decodeCachePanelMessage({ type: "collect", budgetGiB: 0 }), { type: "collect", budgetGiB: 0 });
  assert.deepEqual(decodeCachePanelMessage({ type: "collect", budgetGiB: 2.5 }), { type: "collect", budgetGiB: 2.5 });
  assert.deepEqual(decodeCachePanelMessage({ type: "prune" }), { type: "prune" });
  assert.deepEqual(decodeCachePanelMessage({ type: "verify" }), { type: "verify" });
  assert.deepEqual(decodeCachePanelMessage({ type: "cleanLegacy" }), { type: "cleanLegacy" });
  assert.deepEqual(decodeCachePanelMessage({ type: "showEntry", label: "zlib" }), { type: "showEntry", label: "zlib" });
});

test("decodeCachePanelMessage rejects garbage", () => {
  const rejected: unknown[] = [
    null,
    undefined,
    42,
    "refresh",
    [],
    {},
    { type: "nope" },
    { type: "collect" },
    { type: "collect", budgetGiB: "4" },
    { type: "collect", budgetGiB: Number.NaN },
    { type: "collect", budgetGiB: Number.POSITIVE_INFINITY },
    { type: "collect", budgetGiB: -1 },
    { type: "showEntry" },
    { type: "showEntry", label: "" },
    { type: "showEntry", label: 7 },
  ];
  for (const raw of rejected) {
    assert.equal(decodeCachePanelMessage(raw), undefined, `accepted ${JSON.stringify(raw)}`);
  }
});

test("decodeCachePanelMessage rebuilds the message and drops foreign fields", () => {
  assert.deepEqual(decodeCachePanelMessage({ type: "refresh", extra: true }), { type: "refresh" });
  assert.deepEqual(decodeCachePanelMessage({ type: "showEntry", label: "zlib", extra: 1 }), {
    type: "showEntry",
    label: "zlib",
  });
});
