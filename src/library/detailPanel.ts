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

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { runMcpp } from "../cli/process";
import { read } from "../config/access";
import { languagePreference, t } from "../i18n/t";
import { localeFromEditorLanguage } from "../i18n/translate";
import { WebviewDocument } from "../webview/document";
import { projectDependencyState, readProjectDeclarations, operationMatches } from "./projectState";
import type { LibraryRow } from "./libraryHtml";
import { addDependency } from "./addDependency";
import {
  badgesOf,
  descriptorDependencies,
  lockPackageVersions,
  mergeSurfaces,
  parseXpkgJson,
  platformKey,
  surfaceLabel,
  usageLinesFor,
  type LibraryEntry,
  type Surface,
} from "./indexModel";
import { cachedDescriptorText, loadSnapshot, readDescriptorText, readExampleFiles } from "./indexLocator";
import { bundledExample, bundledExampleText, EXAMPLE_SCHEME } from "./examples";
import {
  DETAIL_UI,
  decodeDetailMessage,
  renderDetailHtml,
  detailClientState,
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
  mcppExecutable: (projectRoot?: string) => string;
  chooseProject?: () => Promise<string | undefined>;
  onPackageOpened?: (key: string) => void;
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
  onProjectFilesRead?: (root: string, manifest: string, lock: string) => void;
}

/** Build the opener once; `extension.ts` passes `openLibraryDetail` to the view. */
export function createLibraryDetailOpener(
  context: vscode.ExtensionContext,
  deps: DetailPanelDeps,
): LibraryDetailOpener {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(EXAMPLE_SCHEME, {
    provideTextDocumentContent: (uri) => bundledExampleText(uri.path) ?? "",
  }));
  const session: DetailSession = {
    context,
    deps,
    panel: undefined,
    id: undefined,
    busy: false,
    generation: 0,
    projectRoot: deps.projectRoot(),
    painted: false,
    webviewDocument: new WebviewDocument(STYLESHEET),
  };
  context.subscriptions.push({
    dispose: () => {
      session.panel?.dispose();
      session.panel = undefined;
    },
  });
  const opener = (id: string, preview?: LibraryRow) => open(session, id, preview);
  opener.refresh = async () => {
    if (session.id === undefined || session.panel === undefined) { return; }
    const root = deps.projectRoot();
    if (root !== session.projectRoot) {
      session.projectRoot = root; session.generation++; session.result = undefined;
      if (session.model) { paintModel(session, { ...session.model, generation: session.generation, projectRoot: root, projectState: undefined, installed: undefined, loading: true, blockedReason: t("Reading package details…"), result: undefined }); }
    }
    await render(session, session.id);
  };
  return opener;
}

export interface LibraryDetailOpener {
  (id: string, preview?: LibraryRow): Promise<void>;
  refresh(): Promise<void>;
}

/** One panel per window, remembered so a second `open` reveals rather than stacks. */
export interface DetailSession {
  context: vscode.ExtensionContext;
  deps: DetailPanelDeps;
  panel: vscode.WebviewPanel | undefined;
  id: string | undefined;
  /** `mcpp add` in flight: a second click must not start a second command. */
  busy: boolean;
  generation: number;
  renderRequest?: number;
  projectRoot?: string;
  preview?: LibraryRow;
  model?: DetailModel;
  painted: boolean;
  lastHtml?: string;
  result?: DetailResult;
  /**
   * The document and its nonce, kept per session so re-opening the *same*
   * package renders byte for byte the same document and does not reload the
   * page (which would throw away the reader's scroll position).
   */
  webviewDocument: WebviewDocument;
}

/** The parse result per descriptor, so re-opening a package costs no process. */
const parsed = new Map<string, XpkgInfo | undefined>();

export async function open(session: DetailSession, id: string, preview?: LibraryRow): Promise<void> {
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
      session.generation++;
      session.painted = false;
      session.lastHtml = undefined;
      // The next open creates a brand-new webview: what was on screen says
      // nothing about it, so the document comparison starts from nothing.
      session.webviewDocument.invalidate();
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      void handle(session, raw);
    });
  }
  const panel = session.panel;
  const changed = session.id !== id;
  session.id = id;
  session.preview = preview;
  session.deps.onPackageOpened?.(id);
  if (changed) { session.generation++; session.result = undefined; }
  const nextProject = session.deps.projectRoot();
  if (nextProject !== session.projectRoot) { session.generation++; session.result = undefined; }
  session.projectRoot = nextProject;
  panel.title = preview?.id ?? path.basename(id, ".lua");
  if (changed || !session.painted) {
    const loading = emptyModel(preview?.id ?? path.basename(id, ".lua"), labels(), t("Reading package details…"));
    loading.key = id; loading.generation = session.generation; loading.projectRoot = session.projectRoot;
    loading.loading = true; loading.blockedReason = t("Reading package details…");
    paintModel(session, loading);
  }
  panel.reveal(vscode.ViewColumn.Active, false);
  await render(session, id);
}

async function handle(session: DetailSession, raw: unknown): Promise<void> {
  const message = decodeDetailMessage(raw);
  if (message === undefined || session.panel === undefined || session.id === undefined) { return; }
  const envelope = raw as { pageKey?: unknown; generation?: unknown };
  if (message.type === "mounted") {
    if (session.model) { paintModel(session, session.model, true); }
    return;
  }
  if (envelope.pageKey !== session.id || envelope.generation !== session.generation) { return; }
  const operation = { key: session.id, projectRoot: session.projectRoot, generation: session.generation };
  const current = () => operationMatches(operation, { key: session.id ?? "", projectRoot: session.projectRoot, generation: session.generation });
  switch (message.type) {
    case "selectProject": {
      const root = await session.deps.chooseProject?.();
      if (root !== undefined && current()) {
        session.projectRoot = root; session.generation++; session.result = undefined;
        if (session.model) { paintModel(session, { ...session.model, generation: session.generation, projectRoot: root, projectState: undefined, installed: undefined, loading: true, blockedReason: t("Reading package details…"), result: undefined }); }
        await render(session, session.id);
      }
      return;
    }
    case "showOutput": session.deps.output.show(true); return;
    case "openManifest":
      if (session.projectRoot) { await vscode.window.showTextDocument(vscode.Uri.file(path.join(session.projectRoot, "mcpp.toml"))); }
      return;
    case "retry":
      if (session.result?.state === "error") { session.result = undefined; }
      await render(session, session.id); return;
    case "openDependency":
      if (session.model?.dependencies.some((dependency) => dependency.key === message.key)) { await open(session, message.key); }
      return;
    case "openFile": {
      if (!session.model?.snippets.some((snippet) => snippet.fileKey === message.key)) { return; }
      await vscode.window.showTextDocument(message.key.startsWith(`${EXAMPLE_SCHEME}:`) ? vscode.Uri.parse(message.key) : vscode.Uri.file(message.key)); return;
    }
    case "copy": {
      let result: string;
      try { await vscode.env.clipboard.writeText(message.text); result = t("Copied"); }
      catch { result = t("Copy failed"); }
      if (current()) { void session.panel?.webview.postMessage({ type: "copyResult", key: operation.key, generation: operation.generation, token: message.token, message: result }); }
      return;
    }
    case "openUrl": {
      // Only links in this package's model can ask the host to open a browser.
      if (message.url !== session.model?.repo && message.url !== session.model?.indexUrl) { return; }
      let opened = false;
      try { opened = await vscode.env.openExternal(vscode.Uri.parse(message.url)); } catch { /* report below */ }
      let copied = false;
      if (!opened) { try { await vscode.env.clipboard.writeText(message.url); copied = true; } catch { /* accurate feedback below */ } }
      if (current()) { void session.panel?.webview.postMessage({ type: "linkResult", key: operation.key, generation: operation.generation,
        message: opened ? t("Opened in your browser.") : copied ? t("Could not open the browser. Link copied to clipboard.") : t("Could not open the browser or copy the link: {0}", message.url) }); }
      return;
    }
    case "add": {
      const model = session.model;
      if (session.busy || !model || model.blockedReason || model.preview || !model.currentVersions.includes(message.version)) { return; }
      const state = model.dependencyGroups?.[message.dev ? "dev" : "normal"] ?? model.projectState;
      const other = model.dependencyGroups?.[message.dev ? "normal" : "dev"];
      if (state?.ambiguous || state?.declared && state.sourceType !== "registry" || !state?.declared && other?.declared) { return; }
      session.busy = true;
      session.result = { state: "pending", message: t("Adding dependency…") };
      paintModel(session, { ...model, busy: true, result: session.result });
      try {
        const executable = session.deps.mcppExecutable(operation.projectRoot);
        const snapshot = await loadSnapshot({ projectRoot: operation.projectRoot });
        const declarations = readProjectDeclarations(operation.projectRoot ? readTextTolerantly(path.join(operation.projectRoot, "mcpp.toml")) : "");
        const catalog = snapshot.entries.map((entry) => entry.id);
        const fresh = projectDependencyState(model.id, declarations, [], catalog, message.dev ? "dev" : "normal");
        const otherGroup = projectDependencyState(model.id, declarations, [], catalog, message.dev ? "normal" : "dev");
        if (fresh.ambiguous || fresh.declared && fresh.sourceType !== "registry" || !fresh.declared && otherGroup.declared) {
          if (current()) { session.result = { state: "error", message: t("The dependency declaration changed. Review mcpp.toml before adding it.") }; }
          return;
        }
        const outcome = await addDependency({
          mcppExecutable: () => executable,
          projectRoot: () => operation.projectRoot,
          isTrusted: session.deps.isTrusted,
          output: session.deps.output,
          quiet: true,
        }, { id: model.id, version: message.version, dev: message.dev });
        if (outcome.ok) { session.deps.onDependenciesChanged?.(); }
        if (current() && session.panel) {
          session.result = { state: outcome.ok ? "ok" : "error", message: outcome.message };
        } else {
          void (outcome.ok ? vscode.window.showInformationMessage(outcome.message) : vscode.window.showErrorMessage(outcome.message));
        }
      } catch (error) {
        session.deps.output.appendLine(String(error));
        if (current()) { session.result = { state: "error", message: t("Could not add the dependency. See output for details.") }; }
      } finally {
        session.busy = false;
        if (session.panel && session.id) { await render(session, session.id); }
      }
      return;
    }
  }
}

function paintModel(session: DetailSession, model: DetailModel, replay = false): void {
  const panel = session.panel;
  if (!panel) { return; }
  session.model = model;
  const html = renderDetailHtml(model, session.webviewDocument.assets(vscode.Uri.joinPath(session.context.extensionUri, MEDIA_DIRECTORY), panel.webview));
  if (session.lastHtml === html && !replay) { return; }
  session.lastHtml = html;
  if (!session.painted && !replay) {
    session.webviewDocument.paint(panel.webview, html); session.painted = true;
  } else {
    void panel.webview.postMessage({ type: "detailUpdate", html, state: detailClientState(model) });
  }
}

async function render(session: DetailSession, id: string): Promise<void> {
  const panel = session.panel;
  const generation = session.generation;
  const request = session.renderRequest = (session.renderRequest ?? 0) + 1;
  const root = session.projectRoot;
  if (!panel) { return; }
  let model: DetailModel;
  try { model = await buildModel(session, id, request); }
  catch (error) {
    session.deps.output.appendLine(String(error));
    model = emptyModel(path.basename(id, ".lua"), labels(), t("Could not read package details. See output for details."));
    model.blockedReason = model.parseNotice;
    model.result = { state: "error", message: model.parseNotice ?? "" };
  }
  if (session.panel !== panel || session.id !== id || generation !== session.generation || request !== session.renderRequest || root !== session.projectRoot) { return; }
  paintModel(session, { ...model, key: id, generation, busy: session.busy, result: session.result ?? model.result });
}

async function buildModel(session: DetailSession, id: string, request: number): Promise<DetailModel> {
  const projectRoot = session.projectRoot;
  const generation = session.generation;
  const snapshot = await loadSnapshot(projectRoot === undefined ? {} : { projectRoot });
  const entry = snapshot.entries.find((candidate) => candidate.file === id || candidate.id === id);
  // The root the descriptor lives under, matched by path: two roots may share a
  // directory name, and the site link belongs to the one that holds the file.
  const root = entry === undefined ? undefined : snapshot.roots.find((candidate) => { const relative = path.relative(candidate.path, entry.file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); });
  const ui = labels();
  if (entry === undefined) {
    const preview = session.preview;
    const model = emptyModel(preview?.id ?? path.basename(id, ".lua"), ui, preview ? t("This is a search preview. Set an index path containing this package to read its complete details.") : t("This package is not in the local index any more."));
    model.preview = preview !== undefined;
    model.previewVersion = preview?.version;
    model.description = preview?.description;
    model.registry = preview?.source ?? "";
    model.projectRoot = projectRoot;
    model.blockedReason = preview ? t("Search previews cannot be added. Open a complete local descriptor first.") : t("The package descriptor is missing. Reread the local index.");
    return model;
  }
  const text = cachedDescriptorText(entry.file) ?? (await readDescriptorText(entry.file)) ?? "";
  const platform = platformKey(process.platform);
  // Keyed by the index revision as well as the path, so a refreshed index is not
  // answered from a parse of the previous one.
  const cacheKey = `${snapshot.revision}\u0000${entry.file}\u0000${session.deps.isTrusted()}\u0000${session.deps.mcppExecutable(projectRoot)}\u0000${projectRoot ?? ""}`;
  let info = parsed.get(cacheKey);
  if (!parsed.has(cacheKey)) {
    if (session.id === id && session.generation === generation && session.renderRequest === request && session.model?.loading) {
      const lightweight: DetailModel = {
        ...emptyModel(entry.id, ui, t("Reading package details…")),
        key: id, generation, projectRoot, platform: platform ?? process.platform,
        description: entry.description, registry: entry.registry, surface: entry.surface, surfaces: entry.surfaces,
        licenses: entry.licenses, repo: entry.repo, badges: badgesOf(entry),
        currentVersions: entry.versions[platform ?? ""] ?? [], latest: entry.version,
        versions: versionGroups(entry.versions, platform).map((group) => ({ ...group, current: group.platform === platform })),
        loading: true, blockedReason: t("Reading package details…"), dataSource: dataSource(entry, snapshot.roots.length),
      };
      paintModel(session, lightweight);
    }
    info = await readXpkg(session, entry, projectRoot);
    if (info !== undefined) { parsed.set(cacheKey, info); }
    while (parsed.size > 100) { parsed.delete(parsed.keys().next().value!); }
  }

  const versions = info === undefined ? entry.versions : info.versions;
  const groups: DetailVersionGroup[] = versionGroups(versions, platform).map((group) => ({
    platform: group.platform,
    versions: group.versions,
    current: group.platform === platform,
  }));
  const currentVersions = platform === undefined ? [] : (versions[platform] ?? []);
  const latest = currentVersions.length === 0 ? undefined : sortVersions(currentVersions)[0];

  const localExamples = entry.example === undefined ? [] : await readExampleFiles(root ? [root] : [], entry.example);
  const bundled = root?.kind === "official" && localExamples.length === 0 ? bundledExample(entry.id) : undefined;
  const exampleFiles = localExamples.length ? localExamples : bundled?.files ?? [];
  const snippets = exampleFiles.slice(0, 2).map((file) => ({
    file: file.path, startLine: 1, usageLine: 0, lines: file.text.split(/\r?\n/).slice(0, 80),
  })).map((snippet) => ({
    ...snippet, ...(bundled ? { fileKey: `${EXAMPLE_SCHEME}:/${snippet.file}` } : root ? { fileKey: path.join(root.path, snippet.file) } : {}),
  }));
  // Only verified lines from real example source are copyable.
  const realUsage = usageLinesFor(exampleFiles, entry.id);
  const usage = realUsage;

  // The lock answers what a build actually resolved for each declared edge —
  // the same matching rule `installedFor` uses for this package itself.
  const lockText = projectRoot ? readTextTolerantly(path.join(projectRoot, "mcpp.lock")) : "";
  const manifestText = projectRoot ? readTextTolerantly(path.join(projectRoot, "mcpp.toml")) : "";
  if (projectRoot) { session.deps.onProjectFilesRead?.(projectRoot, manifestText, lockText); }
  const lock = lockPackageVersions(lockText);
  const declarations = readProjectDeclarations(manifestText);
  const catalog = snapshot.entries.map((entry) => entry.id);
  const dependencyGroups = {
    normal: projectDependencyState(entry.id, declarations, lock, catalog, "normal"),
    dev: projectDependencyState(entry.id, declarations, [], catalog, "dev"),
    build: projectDependencyState(entry.id, declarations, [], catalog, "build"),
  };
  const dependencyKind = dependencyGroups.normal.declared ? "normal" : dependencyGroups.dev.declared ? "dev" : dependencyGroups.build.declared ? "build" : "normal";
  const state = dependencyGroups[dependencyKind];
  const dependencies = descriptorDependencies(text).map((dependency) => {
    const resolved = lock.find((entry) => entry.id === dependency.id)?.version;
    const local = snapshot.entries.find((entry) => entry.id === dependency.id);
    return { ...dependency, ...(resolved ? { resolved } : {}), ...(local ? { key: local.file } : {}) };
  });
  const model: DetailModel = {
    ui,
    projectRoot,
    manifestAvailable: !!projectRoot && existsSync(path.join(projectRoot, "mcpp.toml")),
    platform: platform ?? process.platform,
    projectState: state,
    dependencyGroups,
    dependencyKind,
    blockedReason: !session.deps.isTrusted() ? t("Trust this workspace to run mcpp and add dependencies.")
      : !projectRoot || !existsSync(path.join(projectRoot, "mcpp.toml")) ? t("Select an mcpp project before adding this library.")
      : platform === undefined ? t("The current environment platform is not recognized by this index.")
      : latest === undefined ? info === undefined ? t("Version availability could not be confirmed. Retry reading this descriptor.") : t("No version is published for the current environment platform.")
      : undefined,
    versionNotice: info === undefined ? t("Versions are from descriptor text; mcpp will confirm availability when adding.") : undefined,
    id: entry.id,
    name: entry.name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    licenses: entry.licenses,
    ...(entry.repo === undefined ? {} : { repo: entry.repo }),
    registry: entry.registry,
    ...(mergeSurfaces(info, text)[0] === undefined ? {} : { surface: mergeSurfaces(info, text)[0] }),
    surfaces: mergeSurfaces(info, text),
    badges: badgesOf(entry),
    versions: groups,
    currentVersions: sortVersions(currentVersions),
    ...(latest === undefined ? {} : { latest }),
    ...(info?.standard === undefined ? {} : { standard: info.standard }),
    dependencies,
    includeDirs: info?.includeDirs ?? [],
    targets: (info?.targets ?? []).map((target) => target.name ?? "").filter((name) => name.length > 0),
    snippets,
    ...(bundled ? { exampleProject: bundled.project, exampleProvenance: t("Bundled official index tests · commit {0}", bundled.commit.slice(0, 12)) } : entry.example ? { exampleProject: entry.example.project } : {}),
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
async function readXpkg(session: DetailSession, entry: LibraryEntry, projectRoot?: string): Promise<XpkgInfo | undefined> {
  // `mcpp.path` is resource-scoped, so an untrusted workspace must not name
  // the program: the refusal degrades to the descriptor's own text.
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: t("Reading {0}…", entry.id) },
    () =>
      runMcpp(session.deps.isTrusted(), session.deps.mcppExecutable(projectRoot), ["xpkg", "parse", entry.file, "--json"], projectRoot, {
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

function readTextTolerantly(file: string): string {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}

/** Every visible string, resolved once per model. */
function labels(): Record<string, string> {
  return {
    [DETAIL_UI.htmlLang]: htmlLanguage(),
    [DETAIL_UI.platforms]: t("Platforms and versions"),
    [DETAIL_UI.kind]: t("Dependency type"),
    [DETAIL_UI.kindNormal]: t("Project dependency"),
    [DETAIL_UI.kindDev]: t("Development dependency"),
    [DETAIL_UI.kindBuild]: t("Build dependency"),
    [DETAIL_UI.addDevAction]: t("Add development dependency"),
    [DETAIL_UI.buildHint]: t("Build dependencies are used by the build script. Copy this entry into mcpp.toml; mcpp add does not support this group yet."),
    [DETAIL_UI.moveHint]: t("Changing this declaration requires a manifest edit. Copy the entry and update its dependency group in mcpp.toml."),
    [DETAIL_UI.chooseProject]: t("Choose project"),
    [DETAIL_UI.platform]: t("Environment platform"),
    [DETAIL_UI.version]: t("Version"),
    [DETAIL_UI.otherPlatforms]: t("Other platforms (read only)"),
    [DETAIL_UI.declared]: t("Declared"),
    [DETAIL_UI.locked]: t("Resolved in lockfile"),
    [DETAIL_UI.sourceDependency]: t("Source dependency"),
    [DETAIL_UI.unknownUsage]: t("No verified import or header path is available locally. See the repository or index site for usage."),
    [DETAIL_UI.usageSource]: t("From the index's example source"),
    [DETAIL_UI.source]: t("Source and diagnostics"),
    [DETAIL_UI.loading]: t("Reading package details…"),
    [DETAIL_UI.pending]: t("Adding dependency…"),
    [DETAIL_UI.groupChange]: t("Changing dependency groups is not supported here. Edit mcpp.toml to move the declaration."),
    [DETAIL_UI.output]: t("Show output"),
    [DETAIL_UI.retry]: t("Retry reading details"),
    [DETAIL_UI.openManifest]: t("Open mcpp.toml"),
    [DETAIL_UI.openFile]: t("Open source file"),
    [DETAIL_UI.preview]: t("Search preview: only the fields returned by mcpp search are available."),
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
      "Descriptor-level dependencies; the selected version may differ. Resolved values refer to this project's lockfile.",
    ),
    [DETAIL_UI.resolved]: t("resolved {0}"),
    [DETAIL_UI.code]: t("Example code"),
    [DETAIL_UI.codeNone]: t("This package has no test project in the index, so there is no example to show."),
    [DETAIL_UI.codeSource]: t("{0} · line {1}"),
    [DETAIL_UI.codeProject]: t("Example project: {0} — built and run by the index's CI, not written for this page."),
    [DETAIL_UI.add]: t("Add dependency"),
    [DETAIL_UI.addDev]: t("dev dependency"),
    [DETAIL_UI.addLatest]: t("The version is required: mcpp accepts an exact version only."),
    [DETAIL_UI.switchTo]: t("Switch to {0}"),
    [DETAIL_UI.alreadyAdded]: t("Already declared"),
    [DETAIL_UI.installed]: t("added"),
    [DETAIL_UI.opening]: t("Opening {0}…"),
    [DETAIL_UI.addNoVersion]: t("This index publishes no version for this platform, so there is nothing to add."),
    [DETAIL_UI.command]: t("Command"),
    [DETAIL_UI.usage]: t("Usage"),
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
