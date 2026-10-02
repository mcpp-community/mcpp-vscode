/**
 * The VS Code half of the cache panel: `mcpp: Cache statistics` (plan §3.4.3).
 *
 * The panel is a **reading aid** for what `mcpp cache list`, `mcpp cache dir`
 * and a bounded walk of `target/` already report: composition, age, the largest
 * labels, an LRU projection for a budget, and the cleanup actions the cache view
 * exposes. `src/views/cachePanelHtml.ts` owns the document; this module owns the
 * data, the messages and the webview's lifetime.
 *
 * Deliberate boundaries:
 *
 * - **Nothing runs on its own.** Every read comes from the injected `read()`;
 *   every write goes through the injected `run()`, which is the same routine the
 *   cache view uses, so a confirmation cannot be bypassed by opening a panel.
 * - **One panel per window.** Reopening reveals and re-renders the existing one.
 * - **A failure still renders.** When `read()` rejects, the panel draws an
 *   unavailable state with the reason instead of leaving the webview blank.
 * - **The document is re-rendered after every action**, so there is exactly one
 *   renderer (the pure one) and no client-side model application to keep in
 *   sync.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { CACHE_COMMANDS } from "../commands/ids";
import { read } from "../config/access";
import { languagePreference, t } from "../i18n/t";
import { localeFromEditorLanguage } from "../i18n/translate";
import { formatBytes, formatCount, type NumberFormat } from "../util/format";
import {
  CACHE_PANEL_UI,
  decodeCachePanelMessage,
  renderCachePanelHtml,
  type CachePanelAssets,
  type CachePanelMessage,
  type CachePanelModel,
} from "./cachePanelHtml";

const PANEL_VIEW_TYPE = "mcpp.cachePanel";
const MEDIA_DIRECTORY = "media";
const STYLESHEET = "cache.css";

export interface CachePanelData {
  project: CachePanelModel["project"];
  shared: CachePanelModel["shared"];
  legacy?: CachePanelModel["legacy"];
  /**
   * The caller's LRU projection for the budget simulator. Optional on purpose:
   * when the caller has no estimate the panel omits the line rather than
   * inventing a number.
   */
  estimate?: string;
}

/** The six messages the panel may hand to `run()`; `refresh` and `showEntry` do not clean anything. */
export type CachePanelAction = Extract<
  CachePanelMessage,
  { type: "cleanStale" | "cleanProject" | "collect" | "prune" | "verify" | "cleanLegacy" }
>;

export interface CachePanelDeps {
  /** Recomputes what the panel shows; the same routine the tree uses. */
  read: () => Promise<CachePanelData>;
  /** Runs one of the cleanup commands; the caller owns confirmation. */
  run: (message: CachePanelAction) => Promise<void>;
  showEntry: (label: string) => Promise<void>;
}

interface CachePanelSession {
  panel: vscode.WebviewPanel;
  context: vscode.ExtensionContext;
  /** Set by `onDidDispose`, so an in-flight `read()` cannot touch a dead webview. */
  disposed: boolean;
}

/** One panel per window: reopening reveals and refreshes the existing one. */
let session: CachePanelSession | undefined;

export function registerCachePanel(context: vscode.ExtensionContext, deps: CachePanelDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CACHE_COMMANDS.showPanel, () => open(context, deps)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (session === undefined) {
        return;
      }
      if (
        event.affectsConfiguration("mcpp.cache") ||
        event.affectsConfiguration("mcpp.views.cache") ||
        event.affectsConfiguration("mcpp.ui.numberFormat")
      ) {
        void render(session, deps);
      }
    }),
    {
      dispose: () => {
        session?.panel.dispose();
        session = undefined;
      },
    },
  );
}

async function open(context: vscode.ExtensionContext, deps: CachePanelDeps): Promise<void> {
  if (session !== undefined) {
    session.panel.reveal();
    await render(session, deps);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    PANEL_VIEW_TYPE,
    t("Cache statistics"),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [mediaRoot(context)],
      retainContextWhenHidden: false,
    },
  );
  const active: CachePanelSession = { panel, context, disposed: false };
  session = active;
  panel.webview.onDidReceiveMessage((raw: unknown) => {
    void handle(active, deps, raw);
  });
  panel.onDidDispose(() => {
    active.disposed = true;
    if (session === active) {
      session = undefined;
    }
  });
  await render(active, deps);
}

async function handle(active: CachePanelSession, deps: CachePanelDeps, raw: unknown): Promise<void> {
  const message = decodeCachePanelMessage(raw);
  if (message === undefined) {
    return;
  }
  try {
    if (message.type === "refresh") {
      // Nothing to run: the render below re-reads everything.
    } else if (message.type === "showEntry") {
      await deps.showEntry(message.label);
    } else {
      await deps.run(message);
    }
  } catch {
    // The caller owns confirmation and error reporting. The panel still
    // re-renders, so the user sees the state that actually resulted.
  }
  await render(active, deps);
}

/**
 * Resolve the model and put it on the webview. A rejected `read()` becomes an
 * unavailable model carrying the reason, because a blank panel tells the user
 * nothing and a panel that is still usable can be refreshed.
 */
async function render(active: CachePanelSession, deps: CachePanelDeps): Promise<void> {
  let model: CachePanelModel;
  try {
    model = buildModel(await deps.read());
  } catch (error) {
    model = unavailableModel(error instanceof Error ? error.message : String(error));
  }
  if (active.disposed) {
    return;
  }
  active.panel.webview.html = renderCachePanelHtml(model, assets(active));
}

function buildModel(data: CachePanelData): CachePanelModel {
  const limits: CachePanelModel["limits"] = {
    topN: Math.max(0, Math.floor(readNumber("mcpp.views.cache.topN", 0))),
    warnAboveGiB: Math.max(0, readNumber("mcpp.cache.warnAboveGiB", 0)),
  };
  const budget = suggestedBudgetGiB(data);
  if (budget !== undefined) {
    limits.budgetGiB = budget;
  }
  const model: CachePanelModel = {
    ui: panelLabels(),
    project: data.project,
    shared: data.shared,
    format: { bytes: (value) => formatBytes(value, numberFormat()), count: formatCount },
    limits,
  };
  if (data.legacy !== undefined) {
    model.legacy = data.legacy;
  }
  if (data.estimate !== undefined) {
    model.estimate = data.estimate;
  }
  return model;
}

/** Both halves unavailable, with one reason. Used when `read()` rejects. */
function unavailableModel(message: string): CachePanelModel {
  return {
    ui: panelLabels(),
    project: { available: false, note: message, totalBytes: 0, files: 0, groups: 0 },
    shared: {
      available: false,
      note: message,
      totalBytes: 0,
      totalEntries: 0,
      byKind: [],
      buckets: [],
      top: [],
      incomplete: 0,
    },
    format: { bytes: (value) => formatBytes(value, numberFormat()), count: formatCount },
    limits: { topN: 0, warnAboveGiB: 0 },
  };
}

/**
 * What the budget input starts from: `mcpp.cache.gc.defaultBudgetGiB` when the
 * user set one, otherwise half of what the cache currently holds. `undefined`
 * leaves the input empty rather than offering a number the user did not ask for.
 */
function suggestedBudgetGiB(data: CachePanelData): number | undefined {
  const configured = readNumber("mcpp.cache.gc.defaultBudgetGiB", 0);
  if (configured > 0) {
    return Math.floor(configured);
  }
  const total = data.shared.totalBytes;
  if (!data.shared.available || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return Math.max(1, Math.round(total / 1024 ** 3 / 2));
}

function readNumber(key: string, fallback: number): number {
  const value = read<number>(key);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** `binary` unless `mcpp.ui.numberFormat` says otherwise (plan §3.5). */
function numberFormat(): NumberFormat {
  return read<string>("mcpp.ui.numberFormat") === "decimal" ? "decimal" : "binary";
}

/**
 * Every visible string, resolved once per model. These are the literals
 * `tools/l10n-check.mjs` holds to `data/i18n/zh-cn.json`.
 */
function panelLabels(): Record<string, string> {
  return {
    [CACHE_PANEL_UI.htmlLang]: htmlLanguage(),
    [CACHE_PANEL_UI.title]: t("Cache statistics"),
    [CACHE_PANEL_UI.boundary]: t(
      "Every figure here is read from mcpp cache list, mcpp cache dir and a bounded walk of target/. Sizes are estimates; cleanup runs only after confirmation and never automatically.",
    ),
    [CACHE_PANEL_UI.projectTitle]: t("Project artifacts"),
    [CACHE_PANEL_UI.projectFiles]: t("{0} file(s) · {1} group(s)"),
    [CACHE_PANEL_UI.sharedTitle]: t("Global build cache"),
    [CACHE_PANEL_UI.sharedEntries]: t("{0} entries"),
    [CACHE_PANEL_UI.sharedRoot]: t("Root: {0}"),
    [CACHE_PANEL_UI.sharedOldest]: t("Oldest use: {0}"),
    [CACHE_PANEL_UI.sharedNewest]: t("Newest use: {0}"),
    [CACHE_PANEL_UI.legacyTitle]: t("Pre-v1 cache"),
    [CACHE_PANEL_UI.legacyPath]: t("Path: {0}"),
    [CACHE_PANEL_UI.unknown]: t("unknown"),
    [CACHE_PANEL_UI.projectUnavailable]: t("Project artifacts could not be measured."),
    [CACHE_PANEL_UI.sharedUnavailable]: t("The shared build cache could not be read."),
    [CACHE_PANEL_UI.actions]: t("Cache actions"),
    [CACHE_PANEL_UI.refresh]: t("Refresh"),
    [CACHE_PANEL_UI.cleanStale]: t("Clean stale artifacts"),
    [CACHE_PANEL_UI.cleanProject]: t("Clean project artifacts"),
    [CACHE_PANEL_UI.prune]: t("Drop entries unused for a while"),
    [CACHE_PANEL_UI.verify]: t("Verify the cache"),
    [CACHE_PANEL_UI.cleanLegacy]: t("Remove the pre-v1 cache"),
    [CACHE_PANEL_UI.collect]: t("Collect to this budget"),
    [CACHE_PANEL_UI.details]: t("Details"),
    [CACHE_PANEL_UI.detailsFor]: t("Show cache entry details for {0}"),
    [CACHE_PANEL_UI.reasonShared]: t("The shared build cache is not available."),
    [CACHE_PANEL_UI.reasonProject]: t("Project artifacts are not available."),
    [CACHE_PANEL_UI.reasonLegacy]: t("There is no pre-v1 cache to remove."),
    [CACHE_PANEL_UI.composition]: t("Composition by kind"),
    [CACHE_PANEL_UI.compositionHint]: t("Share of the total cache size, by entry kind."),
    [CACHE_PANEL_UI.compositionEmpty]: t("No cache entries were found."),
    [CACHE_PANEL_UI.age]: t("Age distribution"),
    [CACHE_PANEL_UI.ageHint]: t("Bytes and entries by how long ago they were last used."),
    [CACHE_PANEL_UI.ageEmpty]: t("No entry has a recorded last use."),
    [CACHE_PANEL_UI.ageUnder]: t("under {0} day(s)"),
    [CACHE_PANEL_UI.ageRange]: t("{0}–{1} day(s)"),
    [CACHE_PANEL_UI.ageOverflow]: t("more than {0} day(s)"),
    [CACHE_PANEL_UI.ageUnknown]: t("{0} entries have no recorded last use and are not counted in this bar."),
    [CACHE_PANEL_UI.top]: t("Largest packages (top {0})"),
    [CACHE_PANEL_UI.topHint]: t("The {0} largest cache labels, by bytes."),
    [CACHE_PANEL_UI.topEmpty]: t("No cache label was read."),
    [CACHE_PANEL_UI.colLabel]: t("Label"),
    [CACHE_PANEL_UI.colEntries]: t("Entries"),
    [CACHE_PANEL_UI.colBytes]: t("Size"),
    [CACHE_PANEL_UI.colOldest]: t("Oldest use"),
    [CACHE_PANEL_UI.colActions]: t("Actions"),
    [CACHE_PANEL_UI.budget]: t("Budget simulator"),
    [CACHE_PANEL_UI.budgetHint]: t(
      "Simulates mcpp cache gc --max-size: the estimate is a local projection, so mcpp's own policy decides in the end.",
    ),
    [CACHE_PANEL_UI.budgetLabel]: t("Keep the shared build cache under"),
    [CACHE_PANEL_UI.budgetUnit]: t("GiB"),
    [CACHE_PANEL_UI.incompleteWarning]: t("{0} cache entries are incomplete; run mcpp cache verify to see which ones."),
    [CACHE_PANEL_UI.sizeWarning]: t("The shared build cache is {0}, at or above the {1} warning threshold."),
    [CACHE_PANEL_UI.barsHint]: t("The same figures are listed as text next to each bar."),
  };
}

/** `auto` is the editor's own language; `en`/`zh-cn` are the manual override. */
function htmlLanguage(): string {
  const preference = languagePreference();
  if (preference === "zh-cn") {
    return "zh-cn";
  }
  if (preference === "en") {
    return "en";
  }
  return localeFromEditorLanguage(vscode.env.language) === "zh-cn" ? "zh-cn" : "en";
}

function mediaRoot(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.extensionUri, MEDIA_DIRECTORY);
}

function assets(active: CachePanelSession): CachePanelAssets {
  return {
    cspSource: active.panel.webview.cspSource,
    nonce: randomBytes(16).toString("base64"),
    styleUri: active.panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot(active.context), STYLESHEET)).toString(),
  };
}
