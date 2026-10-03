/**
 * The library sidebar: the `mcpp.library` view.
 *
 * The *model* is `src/library/libraryHtml.ts` plus `src/library/indexModel.ts`,
 * both pure and unit-tested; the *reading* is `src/library/indexLocator.ts`,
 * which caches per index revision. This file is the seam: it owns the webview's
 * lifetime, the `t()` literals, the settings and the messages.
 *
 * Three deliberate boundaries:
 *
 * - **The list never spawns a process per package and never touches the
 *   network.** The descriptors are read as text; `mcpp xpkg parse --json` runs
 *   only from the detail page. The one exception is `mcpp search`, behind
 *   `mcpp.library.networkSearch`, which is **off by default** and whose output
 *   reader is the tolerant best-effort one in `indexModel.parseSearchOutput`
 *   (plan §10.2; upstream request U.8).
 * - **One render, applied in place.** Filtering happens in the document; the
 *   host re-renders only when the data changed. A `webview.html` assignment
 *   would otherwise steal the caret on every keystroke.
 * - **A failure still renders.** No index, no descriptors or a failed read all
 *   produce a document with a sentence in it, never a blank sidebar.
 */

import * as vscode from "vscode";

import { runProcess } from "../cli/process";
import { read, write } from "../config/access";
import { languagePreference, t } from "../i18n/t";
import { localeFromEditorLanguage } from "../i18n/translate";
import { WebviewDocument } from "../webview/document";
import { badgesOf, searchText, parseSearchOutput, type LibraryEntry } from "./indexModel";
import { loadSnapshot, type IndexRoot, type LibrarySnapshot } from "./indexLocator";
import {
  LIBRARY_UI,
  decodeLibraryMessage,
  renderLibraryHtml,
  type LibraryModel,
  type LibraryRow,
} from "./libraryHtml";

/** The view id `package.json` declares. */
export const LIBRARY_VIEW_ID = "mcpp.library";

const MEDIA_DIRECTORY = "media";
const STYLESHEET = "library.css";

/** The delay before a cross-registry search runs: one per pause, not per keystroke. */
const SEARCH_DEBOUNCE_MS = 400;
const SEARCH_TIMEOUT_MS = 20_000;

export interface LibraryViewDeps {
  /**
   * The workspace folder whose `mcpp.toml` decides which packages are "already
   * declared". `undefined` is a normal state: the list then simply has none.
   */
  projectRoot: () => string | undefined;
  /** The configured executable, for the cross-registry search only. */
  mcppExecutable: () => string;
  /** Opens the editor-area detail page for one package id. */
  openDetail: (id: string) => Promise<void> | void;
  /** Where `mcpp search` is logged; the same channel the other commands use. */
  output?: vscode.OutputChannel;
}

/**
 * Register the view: the provider, its settings/save listeners and the
 * `registerWebviewViewProvider` call that makes VS Code ask it for a document.
 *
 * That last call is the whole point — without it the view has no document at
 * all, and every `refresh()` below is a no-op against `this.view === undefined`.
 * It lives here, next to the provider it hands over, exactly like
 * `registerCachePanel`; `extension.ts` only wires the two entry-point commands.
 *
 * `retainContextWhenHidden` is not supported by a webview view, which is why the
 * render is idempotent: the document is rebuilt from the snapshot every time the
 * view becomes visible again.
 */
export function registerLibraryView(context: vscode.ExtensionContext, deps: LibraryViewDeps): LibraryViewHandle {
  const provider = new LibraryViewProvider(context, deps);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(LIBRARY_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    provider,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mcpp.library")) {
        void provider.refresh();
      }
    }),
    // `mcpp.toml` decides the "已添加" state, so saving it re-renders the list.
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.path.endsWith("/mcpp.toml") || document.uri.path.endsWith("\\mcpp.toml")) {
        void provider.refresh();
      }
    }),
  );
  return {
    refresh: () => provider.refresh(),
    dispose: () => provider.dispose(),
  };
}

/**
 * What `extension.ts` keeps a reference to.
 *
 * `refresh()` is how a dependency change made **outside the editor** — `mcpp add`
 * run by the detail page, or `mcpp index update` — reaches the list, because no
 * document is saved in that path and therefore no save event fires. The provider
 * itself is not handed back: `registerLibraryView` has already registered it,
 * and a caller that wants to reach into the view would be reaching past the two
 * methods below.
 */
export interface LibraryViewHandle {
  refresh(): Promise<void>;
  dispose(): void;
}

class LibraryViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private snapshot: LibrarySnapshot | undefined;
  private query = "";
  /** Cross-registry hits for the current query, from `mcpp search`. */
  private extra: LibraryRow[] = [];
  private searchNote: string | undefined;
  private searchTimer: NodeJS.Timeout | undefined;
  private rendering: Promise<void> | undefined;
  /**
   * The document on screen and the one CSP nonce it may be built with. Both
   * live in `WebviewDocument`: the nonce is per view (a nonce per render would
   * make every render a *different* document and defeat the comparison, which
   * is how the reload loop started), and `paint()` refuses to re-assign a
   * document that has not changed, because an assignment reloads the view.
   */
  private readonly webviewDocument = new WebviewDocument(STYLESHEET);

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: LibraryViewDeps,
  ) {}

  public dispose(): void {
    if (this.searchTimer !== undefined) {
      clearTimeout(this.searchTimer);
      this.searchTimer = undefined;
    }
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // A resolved view is a fresh, empty webview; see the note in `onDidDispose`.
    this.webviewDocument.invalidate();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, MEDIA_DIRECTORY)],
    };
    view.webview.onDidReceiveMessage((raw: unknown) => {
      void this.handle(raw);
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        // The next `resolveWebviewView` gets a brand-new, empty webview: what was
        // pushed to the old one says nothing about it, so the comparison in
        // `paint()` must start from nothing again.
        this.webviewDocument.invalidate();
      }
    });
    // First paint from the cached snapshot, so the view is never blank while the
    // index is being read.
    this.paint();
    void this.refresh();
  }

  /** Re-read the index (from the cache when the revision is unchanged) and paint. */
  public refresh(): Promise<void> {
    if (this.rendering !== undefined) {
      return this.rendering;
    }
    const projectRoot = this.deps.projectRoot();
    this.rendering = loadSnapshot(projectRoot === undefined ? {} : { projectRoot })
      .then((snapshot) => {
        this.snapshot = snapshot;
      })
      .catch((error: unknown) => {
        this.deps.output?.appendLine(`mcpp library: ${error instanceof Error ? error.message : String(error)}`);
        this.snapshot = { entries: [], roots: [], revision: "error" };
      })
      .then(() => {
        this.rendering = undefined;
        this.paint();
      });
    return this.rendering;
  }

  private async handle(raw: unknown): Promise<void> {
    const message = decodeLibraryMessage(raw);
    if (message === undefined) {
      return;
    }
    switch (message.type) {
      case "refresh":
        await this.refresh();
        return;
      case "search":
        this.query = message.query;
        this.scheduleSearch();
        return;
      case "networkSearch":
        await this.setNetworkSearch(message.enabled);
        return;
      case "open":
        await this.deps.openDetail(message.id);
        return;
      default:
        return;
    }
  }

  /** `mcpp.library.networkSearch`: persisted, then honoured on the next query. */
  private async setNetworkSearch(enabled: boolean): Promise<void> {
    this.extra = [];
    this.searchNote = undefined;
    try {
      await write("mcpp.library.networkSearch", enabled, "user");
    } catch (error) {
      this.deps.output?.appendLine(
        `mcpp library: could not write mcpp.library.networkSearch: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.searchNote = t("The setting could not be written; the toggle was not saved.");
    }
    if (enabled) {
      await this.runCrossRegistrySearch();
    } else {
      this.paint();
    }
  }

  private scheduleSearch(): void {
    if (this.searchTimer !== undefined) {
      clearTimeout(this.searchTimer);
    }
    if (!this.networkSearch()) {
      this.extra = [];
      this.searchNote = undefined;
      return;
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      void this.runCrossRegistrySearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  private networkSearch(): boolean {
    return read<boolean>("mcpp.library.networkSearch") === true;
  }

  /**
   * The cross-registry tier: `mcpp search <keyword>`.
   *
   * Best effort by design (§10.2): it may use the network, its output is human
   * text (upstream request U.8 asks for `--format json`), and any failure keeps
   * the local results and *says so* rather than failing silently. Only ids the
   * local index does not already have are added.
   */
  private async runCrossRegistrySearch(): Promise<void> {
    const query = this.query.trim();
    if (query.length < 2) {
      this.extra = [];
      this.searchNote = undefined;
      this.paint();
      return;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t("Searching all registries…") },
      () =>
        runProcess(this.deps.mcppExecutable(), ["search", query], this.deps.projectRoot(), {
          timeoutMs: SEARCH_TIMEOUT_MS,
          maxBufferMiB: read<number>("mcpp.runtime.maxOutputMiB"),
        }),
    );
    if (result.exitCode !== 0) {
      this.extra = [];
      this.searchNote = t(
        "Searching all registries failed (exit {0}); showing the local index only.",
        result.exitCode,
      );
      this.paint();
      return;
    }
    const known = new Set((this.snapshot?.entries ?? []).map((entry) => entry.id));
    this.extra = parseSearchOutput(result.stdout)
      .filter((hit) => !known.has(hit.id))
      .map((hit) => ({
        id: hit.id,
        name: hit.id.includes(".") ? hit.id.slice(hit.id.indexOf(".") + 1) : hit.id,
        ...(hit.id.includes(".") ? { namespace: hit.id.slice(0, hit.id.indexOf(".")) } : {}),
        ...(hit.version === undefined ? {} : { version: hit.version }),
        surfaces: [],
        badges: [],
        haystack: `${hit.id} ${hit.description ?? ""}`.toLowerCase(),
        ...(hit.description === undefined ? {} : { description: hit.description }),
        added: false,
        unreadable: false,
        crossRegistry: true,
      }));
    this.searchNote =
      this.extra.length === 0
        ? t("No further packages were found in the other registries.")
        : t("{0} further package(s) came from the other registries.", this.extra.length);
    this.paint();
  }

  private labels(): Record<string, string> {
    return {
      [LIBRARY_UI.htmlLang]: htmlLanguage(),
      [LIBRARY_UI.title]: t("Library"),
      [LIBRARY_UI.search]: t("Search packages"),
      [LIBRARY_UI.networkSearch]: t("Search all registries"),
      [LIBRARY_UI.networkSearchHint]: t(
        "Off by default: this tier runs mcpp search, which may use the network and is read from human output on a best-effort basis. Failures fall back to the local index.",
      ),
      [LIBRARY_UI.versionLatest]: t("latest {0}"),
      [LIBRARY_UI.surfaceExternal]: t("upstream mcpp.toml"),
      [LIBRARY_UI.badgeExamples]: t("✓ Has examples"),
      [LIBRARY_UI.badgeCn]: t("China mirror"),
      [LIBRARY_UI.badgeOpenkalEcosystem]: t("openkal-ecosystem"),
      [LIBRARY_UI.badgeOpenkalCompat]: t("openkal-compat"),
      [LIBRARY_UI.badgeOpenkalPosix]: t("POSIX environment"),
      [LIBRARY_UI.badgeOpenkalPlatform]: t("uses platform interfaces"),
      [LIBRARY_UI.added]: t("Added"),
      [LIBRARY_UI.unreadable]: t("Descriptor not readable"),
      [LIBRARY_UI.noResults]: t("No package matches this search."),
      [LIBRARY_UI.noIndex]: t(
        "No mcpp index was found. Run mcpp: Refresh the mcpp Package Index once, or set mcpp.library.indexPath to an index checkout.",
      ),
      [LIBRARY_UI.dataSource]: t("Data source"),
      [LIBRARY_UI.count]: t("{0} of {1} packages"),
      [LIBRARY_UI.open]: t("Open the detail page for {0}"),
      [LIBRARY_UI.crossRegistry]: t("other registry"),
      [LIBRARY_UI.refresh]: t("Refresh"),
    };
  }

  /**
   * Put the current model on screen — but only when it says something new.
   *
   * `webview.html = …` reloads the document, so pushing an identical one would
   * throw away the scroll position and the half-typed query for nothing. With
   * a per-view nonce, "identical" means identical: the same model renders byte
   * for byte the same document, and a render that produced it is dropped in
   * `WebviewDocument.paint()`.
   */
  private paint(): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    const document = renderLibraryHtml(
      this.model(),
      this.webviewDocument.assets(vscode.Uri.joinPath(this.context.extensionUri, MEDIA_DIRECTORY), view.webview),
    );
    this.webviewDocument.paint(view.webview, document);
  }

  private model(): LibraryModel {
    const snapshot = this.snapshot;
    const ui = this.labels();
    if (snapshot === undefined) {
      return this.emptyModel(ui, t("Reading the index…"), t("Reading the index…"));
    }
    const entries = snapshot.entries;
    const rows = [...entries.map(rowOf), ...this.extra];
    const notice =
      snapshot.roots.length === 0
        ? ui[LIBRARY_UI.noIndex]
        : entries.length === 0
          ? t("The index folders contain no descriptors.")
          : ui[LIBRARY_UI.noResults];
    return {
      ui,
      rows,
      query: this.query,
      networkSearch: this.networkSearch(),
      networkSearchSetting: "mcpp.library.networkSearch",
      dataSource: this.dataSource(snapshot.roots, entries.length),
      countTemplate: ui[LIBRARY_UI.count],
      total: rows.length,
      ...(rows.length === 0 ? { notice } : {}),
    };
  }

  private emptyModel(ui: Record<string, string>, notice: string, dataSource: string): LibraryModel {
    return {
      ui,
      rows: [],
      query: "",
      networkSearch: this.networkSearch(),
      networkSearchSetting: "mcpp.library.networkSearch",
      dataSource,
      countTemplate: ui[LIBRARY_UI.count],
      total: 0,
      notice,
    };
  }

  /** The footer, in plain words: where the rows came from and whether it is offline. */
  private dataSource(roots: readonly IndexRoot[], total: number): string {
    const registries = roots.map((root) => root.registry).join(", ");
    const base =
      roots.length === 0
        ? t("No local index was read.")
        : t(
            "{0} descriptor(s) from {1} local index folder(s): {2}. Read offline.",
            total,
            roots.length,
            registries,
          );
    const sentence = `${t("Data source")}: ${base}`;
    return this.searchNote === undefined ? sentence : `${sentence} ${this.searchNote}`;
  }
}

/** One entry as the row the document renders. */
function rowOf(entry: LibraryEntry): LibraryRow {
  return {
    id: entry.id,
    haystack: searchText(entry),
    ...(entry.namespace === undefined ? {} : { namespace: entry.namespace }),
    name: entry.name,
    ...(entry.version === undefined ? {} : { version: entry.version }),
    ...(entry.surface === undefined ? {} : { surface: entry.surface }),
    surfaces: entry.surfaces,
    badges: badgesOf(entry),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    added: entry.added,
    unreadable: entry.unreadable === true,
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
