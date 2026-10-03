/**
 * The VS Code half of the cache view: the sidebar **WebviewView** (`mcpp.cache`,
 * plan §8.1).
 *
 * The panel is a **reading aid** for what `mcpp cache list`, `mcpp cache dir`
 * and a bounded walk of `target/` already report: composition, age, the largest
 * labels, an LRU projection for a budget, and the cleanup actions the cache view
 * exposes. `src/views/cachePanelHtml.ts` owns the document; this module owns the
 * data, the messages and the webview's lifetime.
 *
 * Deliberate boundaries:
 *
 * - **Nothing runs on its own.** Every figure comes from the injected `refresh`
 *   + `read` pair; every write goes through the injected `run()`, which is the
 *   same routine the cache commands use, so a confirmation cannot be bypassed by
 *   opening the view.
 * - **The document is re-rendered after every action**, so there is exactly one
 *   renderer (the pure one) and no client-side model application to keep in
 *   sync. `renderCachePanelHtml` is idempotent, which is what a `WebviewView`
 *   needs: it has no `retainContextWhenHidden`, so hiding the sidebar destroys
 *   the document and showing it renders a new one. An unchanged document is
 *   not re-assigned (`WebviewDocument.paint()`), so a refresh that changes
 *   nothing keeps the scroll position and the budget input as they are.
 * - **A failure still renders.** When the refresh/read pair rejects, the view
 *   draws an unavailable state with the reason instead of going blank. A global
 *   block that is unavailable is rendered *open*, because a reason hidden behind
 *   a collapsed disclosure is worse than no disclosure at all.
 * - **One webview per window.** The provider is registered once; VS Code hands
 *   it the view whenever the sidebar shows it.
 *
 * The confirmation logic does not live here: `run()` is the caller's, and every
 * destructive path still goes through `src/cli/clean.ts`'s plans and the graded
 * modals in `src/views/cacheView.ts`.
 */

import * as vscode from "vscode";

import { read } from "../config/access";
import { languagePreference, t } from "../i18n/t";
import { localeFromEditorLanguage } from "../i18n/translate";
import { formatBytes, formatCount, type NumberFormat } from "../util/format";
import { WebviewDocument } from "../webview/document";
import {
  CACHE_PANEL_UI,
  decodeCachePanelMessage,
  renderCachePanelHtml,
  type CachePanelMessage,
  type CachePanelModel,
} from "./cachePanelHtml";

/** The sidebar view this module provides; `package.json` spells the same id. */
export const CACHE_VIEW_ID = "mcpp.cache";

/**
 * VS Code registers `<viewId>.focus` for every contributed view, so bringing the
 * cache view on screen needs no command of our own. Used by the status item.
 */
export const CACHE_VIEW_FOCUS_COMMAND = `${CACHE_VIEW_ID}.focus`;

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
  /** Brings the caller's figures up to date; may run mcpp. */
  refresh: () => Promise<void>;
  /** The figures as they stand, without running anything. */
  read: () => CachePanelData;
  /** Runs one of the cleanup commands; the caller owns confirmation. */
  run: (message: CachePanelAction) => Promise<void>;
  showEntry: (label: string) => Promise<void>;
  /** The webview view became visible or hidden; the caller owns the refresh timer. */
  onVisibilityChanged?: (visible: boolean) => void;
}

/** What `cacheView.ts` needs back from the registration. */
export interface CachePanelProvider extends vscode.WebviewViewProvider {
  /** True while the sidebar view is on screen. The caller's timer checks it. */
  readonly visible: boolean;
  /** Redraws from the caller's current figures. A no-op while the view is not resolved. */
  refresh: () => void;
}

/**
 * Register the provider for the `mcpp.cache` sidebar view.
 *
 * The provider is returned so the caller can ask "is the view on screen?" (the
 * auto-refresh timer) and "redraw" (after a settings change — the caller already
 * listens for those, and keeps the status item and the timer in step in the same
 * handler). It is registered with `retainContextWhenHidden: false`, the only
 * value a `WebviewView` supports, which is why the document is re-rendered on
 * every resolve.
 */
export function registerCachePanel(context: vscode.ExtensionContext, deps: CachePanelDeps): CachePanelProvider {
  const provider = new CacheWebviewViewProvider(context, deps);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CACHE_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );
  return provider;
}

class CacheWebviewViewProvider implements CachePanelProvider {
  private view: vscode.WebviewView | undefined;
  private busy = false;
  /** A redraw was asked for while one was running: do exactly one more pass. */
  private again = false;
  /**
   * The document on screen and the one CSP nonce it may be built with — the
   * same kit the library view uses: a nonce per render would make every render
   * a different document, and an assignment reloads the view (which is what
   * loses the scroll position and the budget input).
   */
  private readonly webviewDocument = new WebviewDocument(STYLESHEET);

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: CachePanelDeps,
  ) {}

  get visible(): boolean {
    return this.view?.visible === true;
  }

  /**
   * The `WebviewViewProvider` contract:
   * `resolveWebviewView(view: WebviewView, context: WebviewViewResolveContext, token: CancellationToken)`.
   * The two trailing arguments are unused on purpose: the document is a pure
   * function of the caller's figures, so a resolve needs neither the previous
   * state nor a cancellation token, and the render it starts checks `this.view`
   * before it touches the DOM.
   *
   * Called by VS Code every time the sidebar shows the view — and because a
   * `WebviewView` cannot retain its context while hidden, that is also the point
   * at which the document is drawn from scratch.
   */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // A resolved view is a fresh, empty webview, so the document comparison
    // starts from nothing again.
    this.webviewDocument.invalidate();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot(this.context)],
    };
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.webviewDocument.invalidate();
      }
    });
    view.onDidChangeVisibility(() => {
      this.deps.onVisibilityChanged?.(view.visible);
    });
    view.webview.onDidReceiveMessage((raw: unknown) => {
      void this.handle(raw);
    });
    this.deps.onVisibilityChanged?.(view.visible);
    this.refresh();
  }

  refresh(): void {
    if (this.busy) {
      this.again = true;
      return;
    }
    void this.run();
  }

  /** One pass at a time; a request arriving mid-pass earns exactly one more. */
  private async run(): Promise<void> {
    this.busy = true;
    try {
      do {
        this.again = false;
        await this.render();
      } while (this.again && this.view !== undefined);
    } finally {
      this.busy = false;
    }
  }

  private async handle(raw: unknown): Promise<void> {
    const message = decodeCachePanelMessage(raw);
    if (message === undefined) {
      return;
    }
    try {
      if (message.type === "refresh") {
        // Nothing to run: the render below re-reads everything.
      } else if (message.type === "showEntry") {
        await this.deps.showEntry(message.label);
      } else {
        await this.deps.run(message);
      }
    } catch {
      // The caller owns confirmation and error reporting. The view still
      // re-renders, so the user sees the state that actually resulted.
    }
    this.refresh();
  }

  /**
   * Resolve the model and put it on the webview. A rejected refresh/read pair
   * becomes an unavailable model carrying the reason, because a blank view tells
   * the user nothing and a view that is still usable can be redrawn.
   */
  private async render(): Promise<void> {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    let model: CachePanelModel;
    try {
      await this.deps.refresh();
      model = buildModel(this.deps.read());
    } catch (error) {
      model = unavailableModel(error instanceof Error ? error.message : String(error));
    }
    if (this.view !== view) {
      return;
    }
    const html = renderCachePanelHtml(model, this.webviewDocument.assets(mediaRoot(this.context), view.webview));
    this.webviewDocument.paint(view.webview, html);
  }
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

/** Both halves unavailable, with one reason. Used when the read rejects. */
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
 *
 * A key the §8.1 layout no longer prints (`refresh`, `details`, `colActions`,
 * the four section hints, `barsHint`) is gone rather than left as a dictionary
 * entry: the constant and the renderer have to keep meaning the same thing.
 */
function panelLabels(): Record<string, string> {
  return {
    [CACHE_PANEL_UI.htmlLang]: htmlLanguage(),
    [CACHE_PANEL_UI.title]: t("Cache statistics"),
    [CACHE_PANEL_UI.boundary]: t(
      "Every figure here is read from mcpp cache list, mcpp cache dir and a bounded walk of target/. Sizes are estimates; cleanup runs only after confirmation and never automatically.",
    ),
    [CACHE_PANEL_UI.projectTitle]: t("Project cache"),
    [CACHE_PANEL_UI.projectFiles]: t("{0} file(s) · {1} group(s)"),
    [CACHE_PANEL_UI.projectStale]: t("Stale artifacts: about {0}"),
    [CACHE_PANEL_UI.sharedTitle]: t("Global build cache"),
    [CACHE_PANEL_UI.sharedEntries]: t("{0} entries"),
    [CACHE_PANEL_UI.sharedRoot]: t("Root: {0}"),
    [CACHE_PANEL_UI.legacyTitle]: t("Pre-v1 cache"),
    [CACHE_PANEL_UI.legacyPath]: t("Path: {0}"),
    [CACHE_PANEL_UI.unknown]: t("unknown"),
    [CACHE_PANEL_UI.projectUnavailable]: t("Project artifacts could not be measured."),
    [CACHE_PANEL_UI.sharedUnavailable]: t("The shared build cache could not be read."),
    [CACHE_PANEL_UI.actions]: t("Cache actions"),
    [CACHE_PANEL_UI.cleanStale]: t("Clean stale artifacts"),
    [CACHE_PANEL_UI.cleanProject]: t("Clean project artifacts"),
    [CACHE_PANEL_UI.prune]: t("Drop entries unused for a while"),
    [CACHE_PANEL_UI.verify]: t("Verify the cache"),
    [CACHE_PANEL_UI.cleanLegacy]: t("Remove the pre-v1 cache"),
    [CACHE_PANEL_UI.collect]: t("Collect to this budget"),
    [CACHE_PANEL_UI.detailsFor]: t("Show cache entry details for {0}"),
    [CACHE_PANEL_UI.reasonShared]: t("The shared build cache is not available."),
    [CACHE_PANEL_UI.reasonProject]: t("Project artifacts are not available."),
    [CACHE_PANEL_UI.reasonLegacy]: t("There is no pre-v1 cache to remove."),
    [CACHE_PANEL_UI.composition]: t("Composition by kind"),
    [CACHE_PANEL_UI.compositionEmpty]: t("No cache entries were found."),
    [CACHE_PANEL_UI.age]: t("Last use"),
    [CACHE_PANEL_UI.ageEmpty]: t("No entry has a recorded last use."),
    [CACHE_PANEL_UI.ageUnder]: t("under {0} day(s)"),
    [CACHE_PANEL_UI.ageRange]: t("{0}–{1} day(s)"),
    [CACHE_PANEL_UI.ageOverflow]: t("more than {0} day(s)"),
    [CACHE_PANEL_UI.ageUnknown]: t("{0} entries have no recorded last use and are not counted in this bar."),
    [CACHE_PANEL_UI.top]: t("Largest packages (top {0})"),
    [CACHE_PANEL_UI.topEmpty]: t("No cache label was read."),
    [CACHE_PANEL_UI.colLabel]: t("Label"),
    [CACHE_PANEL_UI.colEntries]: t("Entries"),
    [CACHE_PANEL_UI.colBytes]: t("Size"),
    [CACHE_PANEL_UI.colOldest]: t("Oldest use"),
    [CACHE_PANEL_UI.budgetLabel]: t("Keep the shared build cache under"),
    [CACHE_PANEL_UI.budgetHint]: t(
      "Simulates mcpp cache gc --max-size: the estimate is a local projection, so mcpp's own policy decides in the end.",
    ),
    [CACHE_PANEL_UI.budgetUnit]: t("GiB"),
    [CACHE_PANEL_UI.incompleteWarning]: t("{0} cache entries are incomplete; run mcpp cache verify to see which ones."),
    [CACHE_PANEL_UI.sizeWarning]: t("The shared build cache is {0}, at or above the {1} warning threshold."),
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
