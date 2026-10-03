/**
 * The package detail page: a `WebviewPanel` in the **editor area** (plan §12.1).
 *
 * The sidebar answers "which package"; this page answers "what is it, how do I
 * use it, how do I add it". It is where the authoritative reader finally runs:
 * `mcpp xpkg parse <descriptor.lua> --json` (see `src/library/xpkg.ts`), on
 * demand, for the one package the reader opened — never once per row.
 *
 * Boundaries, in the same spirit as `src/cache/cachePanel.ts`:
 *
 * - **One panel per window.** Opening another package re-renders the existing
 *   panel instead of stacking a second one.
 * - **A failure still renders.** A descriptor that cannot be parsed, an example
 *   that disappeared, or a failed `mcpp add` each produce a document with the
 *   reason in it.
 * - **Nothing is written here.** The add button delegates to
 *   `src/library/addDependency.ts`, which runs `mcpp add`; `mcpp.toml` is mcpp's
 *   file.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { runMcpp } from "../cli/process";
import { read } from "../config/access";
import { languagePreference, t } from "../i18n/t";
import { localeFromEditorLanguage } from "../i18n/translate";
import { WebviewDocument } from "../webview/document";
import { addDependency } from "./addDependency";
import {
  badgesOf,
  codeSnippets,
  descriptorDependencies,
  installedFor,
  lockPackageVersions,
  mergeSurfaces,
  parseXpkgJson,
  platformKey,
  surfaceLabel,
  syntheticUsageLines,
  usageLinesFor,
  type LibraryEntry,
  type Surface,
} from "./indexModel";
import { cachedDescriptorText, loadSnapshot, readDescriptorText, readExampleFiles } from "./indexLocator";
import {
  DETAIL_UI,
  decodeDetailMessage,
  renderDetailHtml,
  type DetailInstalled,
  type DetailModel,
  type DetailVersionGroup,
  type DetailResult,
} from "./detailHtml";
import { compareVersions, versionGroups, type XpkgInfo } from "./xpkg";

const PANEL_VIEW_TYPE = "mcpp.libraryDetail";
const MEDIA_DIRECTORY = "media";
const STYLESHEET = "library.css";

/** `mcpp xpkg parse` is a local, read-only command; this is generous. */
const PARSE_TIMEOUT_MS = 20_000;

export interface DetailPanelDeps {
  mcppExecutable: () => string;
  projectRoot: () => string | undefined;
  output: vscode.OutputChannel;
  isTrusted: () => boolean;
  /**
   * Called after a successful `mcpp add`. `mcpp add` writes `mcpp.toml` on disk
   * without the editor saving a document, so no save event fires; the sidebar's
   * "已添加" state would otherwise stay stale. `extension.ts` wires this to the
   * library view's `refresh()`.
   */
  onDependenciesChanged?: () => void;
}

/** Build the opener once; `extension.ts` passes `openLibraryDetail` to the view. */
export function createLibraryDetailOpener(
  context: vscode.ExtensionContext,
  deps: DetailPanelDeps,
): (id: string) => Promise<void> {
  const session: DetailSession = {
    context,
    deps,
    panel: undefined,
    id: undefined,
    busy: false,
    webviewDocument: new WebviewDocument(STYLESHEET),
  };
  context.subscriptions.push({
    dispose: () => {
      session.panel?.dispose();
      session.panel = undefined;
    },
  });
  return (id: string) => open(session, id);
}

/** One panel per window, remembered so a second `open` reveals rather than stacks. */
export interface DetailSession {
  context: vscode.ExtensionContext;
  deps: DetailPanelDeps;
  panel: vscode.WebviewPanel | undefined;
  id: string | undefined;
  /** `mcpp add` in flight: a second click must not start a second command. */
  busy: boolean;
  /**
   * The document and its nonce, kept per session so re-opening the *same*
   * package renders byte for byte the same document and does not reload the
   * page (which would throw away the reader's scroll position).
   */
  webviewDocument: WebviewDocument;
}

/** The parse result per descriptor, so re-opening a package costs no process. */
const parsed = new Map<string, XpkgInfo | undefined>();

export async function open(session: DetailSession, id: string): Promise<void> {
  if (session.panel === undefined) {
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      t("Library"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(session.context.extensionUri, MEDIA_DIRECTORY)],
        retainContextWhenHidden: false,
      },
    );
    session.panel = panel;
    panel.onDidDispose(() => {
      session.panel = undefined;
      session.id = undefined;
      // The next open creates a brand-new webview: what was on screen says
      // nothing about it, so the document comparison starts from nothing.
      session.webviewDocument.invalidate();
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      void handle(session, raw);
    });
  }
  const panel = session.panel;
  session.id = id;
  panel.title = id;
  panel.reveal(vscode.ViewColumn.Active, false);
  await render(session, id);
}

async function handle(session: DetailSession, raw: unknown): Promise<void> {
  const message = decodeDetailMessage(raw);
  if (message === undefined || session.panel === undefined) {
    return;
  }
  switch (message.type) {
    case "openUrl": {
      // `decodeDetailMessage` already restricted this to https.
      await openExternal(session, message.url);
      return;
    }
    case "copy": {
      // The command preview and the usage lines: both are text a reader pastes
      // somewhere else, and a click that answers with nothing looks like a dead
      // button (the lesson `openExternal` learned in §20.2).
      try {
        await vscode.env.clipboard.writeText(message.text);
        postResult(session, { state: "ok", message: t("Copied to the clipboard.") });
      } catch (error) {
        session.deps.output.appendLine(
          `mcpp library: copying to the clipboard failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        postResult(session, { state: "error", message: t("Could not write the clipboard.") });
      }
      return;
    }
    case "add": {
      if (session.busy || session.id === undefined) {
        return;
      }
      session.busy = true;
      let result: DetailResult;
      try {
        const outcome = await addDependency(
          {
            mcppExecutable: session.deps.mcppExecutable,
            projectRoot: session.deps.projectRoot,
            output: session.deps.output,
            isTrusted: session.deps.isTrusted,
          },
          { id: session.id, version: message.version, dev: message.dev },
        );
        result = { state: outcome.ok ? "ok" : "error", message: outcome.message };
        if (outcome.ok) {
          session.deps.onDependenciesChanged?.();
        }
      } finally {
        session.busy = false;
      }
      if (session.panel === undefined) {
        return;
      }
      postResult(session, result, result.state === "ok" ? message.version : undefined);
      return;
    }
    default:
      return;
  }
}

/**
 * Open a link, and say what happened.
 *
 * This used to be `void vscode.env.openExternal(…)`: the boolean it resolves to
 * was dropped, so a host with no browser (or no way to reach one) answered a
 * click with nothing at all — indistinguishable from a dead button. Now the page
 * is told either way, a failure is copied to the clipboard so the click is still
 * worth something, and the output channel keeps a record.
 */
async function openExternal(session: DetailSession, url: string): Promise<void> {
  let opened = false;
  try {
    opened = await vscode.env.openExternal(vscode.Uri.parse(url));
  } catch (error) {
    session.deps.output?.appendLine(
      `mcpp library: opening ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (opened) {
    postResult(session, { state: "ok", message: t("Opened {0} in your browser.", url) });
    return;
  }
  session.deps.output?.appendLine(`mcpp library: VS Code could not open ${url}; copying it instead.`);
  try {
    await vscode.env.clipboard.writeText(url);
  } catch {
    // A clipboard that refuses is not worth a second error.
  }
  postResult(session, {
    state: "error",
    message: t("VS Code could not open {0}. The link is on your clipboard.", url),
  });
}

/**
 * The page's status line, in the same shape the add flow uses.
 *
 * `added` tells the page that the project now depends on that version, so it can
 * move its "added" marker and re-label the button without rebuilding the
 * document — which would throw away the reader's scroll position and their
 * version selection, the one thing running `mcpp add` must not do.
 */
function postResult(session: DetailSession, result: DetailResult, added?: string): void {
  void session.panel?.webview.postMessage({
    type: "result",
    result,
    ...(added === undefined ? {} : { added: { version: added } }),
  });
}

async function render(session: DetailSession, id: string): Promise<void> {
  const panel = session.panel;
  if (panel === undefined) {
    return;
  }
  const model = await buildModel(session, id);
  if (session.panel !== panel || session.id !== id) {
    return;
  }
  const html = renderDetailHtml(
    model,
    session.webviewDocument.assets(
      vscode.Uri.joinPath(session.context.extensionUri, MEDIA_DIRECTORY),
      panel.webview,
    ),
  );
  session.webviewDocument.paint(panel.webview, html);
}

async function buildModel(session: DetailSession, id: string): Promise<DetailModel> {
  const projectRoot = session.deps.projectRoot();
  const snapshot = await loadSnapshot(projectRoot === undefined ? {} : { projectRoot });
  const entry = snapshot.entries.find((candidate) => candidate.id === id);
  // The root the descriptor lives under, matched by path: two roots may share a
  // directory name, and the site link belongs to the one that holds the file.
  const root = entry === undefined ? undefined : snapshot.roots.find((candidate) => entry.file.startsWith(candidate.path));
  const ui = labels();
  if (entry === undefined) {
    return emptyModel(id, ui, t("This package is not in the local index any more."));
  }
  const text = cachedDescriptorText(id) ?? (await readDescriptorText(entry.file)) ?? "";
  const platform = platformKey(process.platform);
  // Keyed by the index revision as well as the path, so a refreshed index is not
  // answered from a parse of the previous one.
  const cacheKey = `${snapshot.revision}\u0000${entry.file}`;
  let info = parsed.get(cacheKey);
  if (!parsed.has(cacheKey)) {
    info = await readXpkg(session, entry);
    parsed.set(cacheKey, info);
  }

  const versions = info === undefined ? entry.versions : info.versions;
  const groups: DetailVersionGroup[] = versionGroups(versions, platform).map((group) => ({
    platform: group.platform,
    versions: group.versions,
    current: group.platform === platform,
  }));
  const currentVersions = platform === undefined ? [] : (versions[platform] ?? []);
  const latest = currentVersions.length === 0 ? undefined : sortVersions(currentVersions)[0];

  const exampleFiles = entry.example === undefined ? [] : await readExampleFiles(snapshot.roots, entry.example);
  const snippets = codeSnippets(exampleFiles, { context: 2, maxSnippets: 3, maxLines: 20 });
  // §22: the example project's real `import`/`#include` lines when it states
  // them, else the honest synthetic form for the surface the parse resolved.
  const realUsage = usageLinesFor(exampleFiles, entry.id);
  const usage = realUsage.length > 0 ? realUsage : syntheticUsageLines(mergeSurfaces(info, text), entry.id);

  // The lock answers what a build actually resolved for each declared edge —
  // the same matching rule `installedFor` uses for this package itself.
  const lock = lockPackageVersions(readInstalledLock(session));
  const dependencies = descriptorDependencies(text).map((dependency) => {
    const short = dependency.id.slice(dependency.id.lastIndexOf(".") + 1);
    const resolved = lock.find((entry) => entry.id === dependency.id || entry.id === short)?.version;
    return resolved === undefined ? { ...dependency } : { ...dependency, resolved };
  });
  const model: DetailModel = {
    ui,
    id: entry.id,
    name: entry.name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    licenses: entry.licenses,
    ...(entry.repo === undefined ? {} : { repo: entry.repo }),
    registry: entry.registry,
    ...(entry.surface === undefined ? {} : { surface: entry.surface }),
    surfaces: entry.surfaces,
    badges: badgesOf(entry),
    versions: groups,
    currentVersions: sortVersions(currentVersions),
    ...(latest === undefined ? {} : { latest }),
    // §22: the page finally learns what the project already has. Without this
    // the button said "Add" to a package mcpp.toml listed all along.
    ...readInstalled(session, entry.id),
    ...(info?.standard === undefined ? {} : { standard: info.standard }),
    dependencies,
    includeDirs: info?.includeDirs ?? [],
    targets: (info?.targets ?? []).map((target) => target.name ?? "").filter((name) => name.length > 0),
    snippets,
    ...(entry.example === undefined ? {} : { exampleProject: entry.example.project }),
    usage,
    // One discreet link, and only when this root really is the index that
    // publishes those package pages (see `IndexRoot.site`).
    ...(root?.site === undefined ? {} : { indexUrl: `${root.site}/${entry.id}/` }),
    commandTemplate: t("mcpp add {0}@{1}"),
    commandDevTemplate: t("mcpp add {0}@{1} --dev"),
    ...(info === undefined
      ? {
          parseNotice: session.deps.isTrusted()
            ? t(
                "mcpp xpkg parse could not read this descriptor; the versions below come from its text, which is less authoritative.",
              )
            : t("This workspace is not trusted, so mcpp is not run; the versions below come from the descriptor's text."),
        }
      : {}),
    dataSource: dataSource(entry, snapshot.roots.length),
  };
  return model;
}

/** Run the authoritative reader for one descriptor; never throws. */
async function readXpkg(session: DetailSession, entry: LibraryEntry): Promise<XpkgInfo | undefined> {
  // `mcpp.path` is resource-scoped, so an untrusted workspace must not name
  // the program: the refusal degrades to the descriptor's own text.
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: t("Reading {0}…", entry.id) },
    () =>
      runMcpp(session.deps.isTrusted(), session.deps.mcppExecutable(), ["xpkg", "parse", entry.file, "--json"], session.deps.projectRoot(), {
        timeoutMs: PARSE_TIMEOUT_MS,
        maxBufferMiB: read<number>("mcpp.runtime.maxOutputMiB"),
      }),
  );
  if (result === undefined) {
    return undefined;
  }
  if (result.exitCode !== 0) {
    session.deps.output.appendLine(`mcpp xpkg parse ${entry.file} failed with exit code ${result.exitCode}`);
    if (result.stderr.trim().length > 0) {
      session.deps.output.appendLine(result.stderr.trimEnd());
    }
    return undefined;
  }
  return parseXpkgJson(result.stdout);
}

function dataSource(entry: LibraryEntry, roots: number): string {
  return t(
    "Read offline from {0} in the {1} index ({2} index folder(s) found).",
    entry.file,
    entry.registry,
    roots,
  );
}

/** A model that still renders: the page says why it is empty instead of going blank. */
function emptyModel(id: string, ui: Record<string, string>, notice: string): DetailModel {
  return {
    ui,
    id,
    name: id,
    licenses: [],
    registry: "",
    surfaces: [],
    badges: [],
    versions: [],
    currentVersions: [],
    dependencies: [],
    includeDirs: [],
    targets: [],
    snippets: [],
    usage: [],
    commandTemplate: t("mcpp add {0}@{1}"),
    commandDevTemplate: t("mcpp add {0}@{1} --dev"),
    parseNotice: notice,
    dataSource: t("No descriptor was read."),
  };
}

/**
 * The workspace's own answer about one package (§20.1, wired in §22):
 * `mcpp.toml` first, `mcpp.lock` second, both read tolerantly — a missing or
 * unreadable file is simply "not installed", never a broken page. The spread
 * sets `installed` only when there is one.
 */
function readInstalled(session: DetailSession, id: string): { installed?: DetailInstalled } {
  const root = session.deps.projectRoot();
  if (root === undefined) {
    return {};
  }
  const toml = readTextTolerantly(path.join(root, "mcpp.toml"));
  const lock = readTextTolerantly(path.join(root, "mcpp.lock"));
  const installed = installedFor(id, toml, lock);
  return installed === undefined ? {} : { installed };
}

/** An unreadable or missing file reads as empty text; the view degrades, not breaks. */
function readTextTolerantly(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The workspace's `mcpp.lock` text, empty when there is none to read. */
function readInstalledLock(session: DetailSession): string {
  const root = session.deps.projectRoot();
  return root === undefined ? "" : readTextTolerantly(path.join(root, "mcpp.lock"));
}

/** Every visible string, resolved once per model. */
function labels(): Record<string, string> {
  return {
    [DETAIL_UI.htmlLang]: htmlLanguage(),
    [DETAIL_UI.title]: t("Library package {0}"),
    [DETAIL_UI.overview]: t("Build shape"),
    [DETAIL_UI.license]: t("License"),
    [DETAIL_UI.repo]: t("Repository"),
    [DETAIL_UI.openRepo]: t("Open the repository"),
    [DETAIL_UI.registry]: t("Registry"),
    [DETAIL_UI.surface]: t("Use"),
    [DETAIL_UI.surfaceExternal]: t("upstream mcpp.toml"),
    [DETAIL_UI.standard]: t("Standard"),
    [DETAIL_UI.versions]: t("Versions ({0})"),
    [DETAIL_UI.versionsAll]: t("Versions"),
    [DETAIL_UI.versionsCurrent]: t("this platform"),
    [DETAIL_UI.versionsNone]: t("This index publishes no version for any platform."),
    [DETAIL_UI.versionsPick]: t("Click a version to aim the command above at it."),
    [DETAIL_UI.dependencies]: t("Dependencies"),
    [DETAIL_UI.dependenciesNone]: t("This descriptor declares no dependencies."),
    [DETAIL_UI.dependenciesHint]: t(
      "What the descriptor declares. The resolved version lives in a project's mcpp.lock, not here.",
    ),
    [DETAIL_UI.resolved]: t("resolved {0}"),
    [DETAIL_UI.code]: t("Example code"),
    [DETAIL_UI.codeNone]: t("This package has no test project in the index, so there is no example to show."),
    [DETAIL_UI.codeSource]: t("{0} · line {1}"),
    [DETAIL_UI.codeProject]: t("Example project: {0} — built and run by the index's CI, not written for this page."),
    [DETAIL_UI.add]: t("Add to mcpp.toml"),
    [DETAIL_UI.addDev]: t("dev dependency"),
    [DETAIL_UI.addLatest]: t("The version is required: mcpp accepts an exact version only."),
    [DETAIL_UI.switchTo]: t("Switch to {0}"),
    [DETAIL_UI.alreadyAdded]: t("Already added"),
    [DETAIL_UI.installed]: t("added"),
    [DETAIL_UI.opening]: t("Opening {0}…"),
    [DETAIL_UI.addNoVersion]: t("This index publishes no version for this platform, so there is nothing to add."),
    [DETAIL_UI.command]: t("Command"),
    [DETAIL_UI.usage]: t("Bring it into your code"),
    [DETAIL_UI.copy]: t("Copy"),
    [DETAIL_UI.copied]: t("Copied to the clipboard."),
    [DETAIL_UI.copying]: t("Copying…"),
    [DETAIL_UI.indexLink]: t("Open on the index site"),
    [DETAIL_UI.badgeExamples]: t("✓ Has examples"),
    [DETAIL_UI.badgeCn]: t("China mirror"),
    [DETAIL_UI.badgeOpenkalEcosystem]: t("openkal-ecosystem"),
    [DETAIL_UI.badgeOpenkalCompat]: t("openkal-compat"),
    [DETAIL_UI.badgeOpenkalPosix]: t("POSIX environment"),
    [DETAIL_UI.badgeOpenkalPlatform]: t("uses platform interfaces"),
    [DETAIL_UI.targets]: t("Targets"),
    [DETAIL_UI.includeDirs]: t("Include directories"),
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

/** Kept next to the model so the surface vocabulary has one import site. */
export { surfaceLabel };
export type { Surface };

/** Greatest first — the order `xpkg.latestVersion` picks from. */
function sortVersions(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a));
}
