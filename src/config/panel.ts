/**
 * The VS Code half of the configuration panel: `mcpp: Open the settings panel`.
 *
 * The panel is deliberately narrow. It is a **reading aid** for the 60+ settings
 * in `data/config-registry.json`: it groups them, shows each one's effective
 * value and where that value comes from, and explains when a change takes
 * effect. It does not replace the Settings editor — every row has a link that
 * opens the native one — and it names the boundary out loud: it writes
 * `mcpp.*` only, never `mcppls.*`, which belongs to the C++ Modules extension.
 *
 * Safety rules this file is responsible for:
 *
 * - a key is written only if the registry declares it (so `mcpp.*` only);
 * - a value is validated against the registry before it is written, so the
 *   panel cannot be the thing that puts a bad value in `settings.json`;
 * - a `resource`-scoped setting is never written to a workspace level without a
 *   folder URI (VS Code has nowhere to put it);
 * - a rejected write (a read-only level, a folder that went away) is swallowed:
 *   the panel re-sends the effective model, and the user sees the real state.
 *
 * `src/config/panelHtml.ts` owns the document; this module owns the data and the
 * messages. The webview answers every action with `{ type: "model", model }`.
 */

import * as path from "node:path";
import * as vscode from "vscode";

import { TOOL_COMMANDS } from "../commands/ids";
import { languagePreference, t } from "../i18n/t";
import { localeFromEditorLanguage } from "../i18n/translate";
import { MCPPLS_EXTENSION_ID } from "../mcppls/contract";
import { WebviewDocument } from "../webview/document";
import { effective, onDidChange, write, type WriteTarget } from "./access";
import {
  PANEL_UI,
  decodePanelMessage,
  renderPanelHtml,
  type PanelModel,
  type PanelPreset,
  type PanelRow,
  type PanelSection,
} from "./panelHtml";
import { PRESETS, presetValues } from "./presets";
import { GROUPS, SECTION, SETTINGS, setting, settingsInGroup, subKey, type SettingEntry } from "./registry";
import { validateValue } from "./validate";

/** `@ext:` queries need `publisher.name`, which is not in any registry. */
const EXTENSION_ID = "mcpp-community.mcpp-vscode";
const PANEL_VIEW_TYPE = "mcpp.settingsPanel";
const OPEN_SETTINGS = "workbench.action.openSettings";
const MEDIA_DIRECTORY = "media";
const STYLESHEET = "settings.css";

/**
 * The slice of `vscode.ExtensionContext` this module needs. `extensionUri` is
 * optional so the declared shape stays callable from tests and from hosts that
 * do not have one; when it is missing the media directory is derived from
 * `__dirname` (`dist/src/config/` → the extension root).
 */
export interface PanelHostContext {
  subscriptions: { push(...items: unknown[]): unknown };
  extensionUri?: vscode.Uri;
}

interface PanelSession {
  panel: vscode.WebviewPanel;
  resource?: vscode.Uri;
  host: PanelHostContext;
  /**
   * The document and its per-panel nonce. The panel's html is assigned exactly
   * once per open — every later update travels by `postMessage` — but the kit
   * is still used so every webview host in this extension holds its document
   * the same way (one nonce minting point, one assignment site).
   */
  webviewDocument: WebviewDocument;
}

/** One panel per window: reopening reveals and refreshes the existing one. */
let session: PanelSession | undefined;

/**
 * Register `mcpp.openSettings`. The command takes no arguments; the panel's
 * resource (the folder whose values it shows) follows the active editor when it
 * is inside a workspace folder, otherwise the first folder.
 */
export function registerSettingsPanel(host: PanelHostContext): void {
  host.subscriptions.push(
    vscode.commands.registerCommand(TOOL_COMMANDS.openSettings, () => {
      open(host);
    }),
    onDidChange(() => {
      if (session !== undefined) {
        postModel(session);
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

function open(host: PanelHostContext): void {
  if (session !== undefined) {
    session.panel.reveal();
    postModel(session);
    return;
  }
  const resource = resourceUri();
  const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, t("mcpp settings"), vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [mediaRoot(host)],
    retainContextWhenHidden: false,
  });
  const active: PanelSession = { panel, resource, host, webviewDocument: new WebviewDocument(STYLESHEET) };
  session = active;
  const model = buildModel(resource);
  const html = renderPanelHtml(model, {
    ...active.webviewDocument.assets(mediaRoot(host), panel.webview),
    // The client script is inline and nonced; the CSP names no external script
    // source, so this stays empty on purpose.
    scriptUri: "",
  });
  active.webviewDocument.paint(panel.webview, html);
  panel.webview.onDidReceiveMessage((raw: unknown) => {
    void handle(active, raw);
  });
  panel.onDidDispose(() => {
    if (session === active) {
      session = undefined;
    }
  });
}

async function handle(active: PanelSession, raw: unknown): Promise<void> {
  const message = decodePanelMessage(raw);
  if (message === undefined) {
    return;
  }
  try {
    switch (message.type) {
      case "ready":
        break;
      case "update":
        await applyUpdate(active, message.key, message.value, message.target);
        break;
      case "reset":
        await resetEverywhere(message.key, active.resource);
        break;
      case "preset":
        await applyPreset(message.id, active.resource);
        break;
      case "openNative":
        await vscode.commands.executeCommand(OPEN_SETTINGS, `@ext:${EXTENSION_ID} ${message.key}`);
        break;
      case "openMcpplsSettings":
        await vscode.commands.executeCommand(OPEN_SETTINGS, `@ext:${MCPPLS_EXTENSION_ID}`);
        break;
    }
  } catch {
    // A write can fail for reasons that are the user's business, not the
    // panel's: a read-only settings level, a folder that disappeared. The model
    // sent below shows the value that is actually in effect.
  }
  postModel(active);
}

async function applyUpdate(
  active: PanelSession,
  key: string,
  value: unknown,
  target: "user" | "workspace",
): Promise<void> {
  const entry = setting(key);
  if (entry === undefined) {
    return;
  }
  const validated = validateValue(entry, value);
  if (!validated.ok || !writable(entry, target, active.resource)) {
    return;
  }
  await write(entry.key, validated.value, target, active.resource);
}

/** A resource-scoped setting needs a folder URI for any workspace-level write. */
function writable(entry: SettingEntry, target: WriteTarget, resource?: vscode.Uri): boolean {
  return !(entry.scope === "resource" && target !== "user" && resource === undefined);
}

function configurationTarget(target: WriteTarget): vscode.ConfigurationTarget {
  switch (target) {
    case "workspace":
      return vscode.ConfigurationTarget.Workspace;
    case "workspaceFolder":
      return vscode.ConfigurationTarget.WorkspaceFolder;
    default:
      return vscode.ConfigurationTarget.Global;
  }
}

/**
 * Remove one level's override. `configuration.update(key, undefined, target)` is
 * the only way to delete a value; leaving the level alone is not enough, because
 * a workspace value would then keep shadowing the default.
 */
async function resetKey(key: string, target: WriteTarget, resource?: vscode.Uri): Promise<void> {
  const entry = setting(key);
  if (entry === undefined || !writable(entry, target, resource)) {
    return;
  }
  await vscode.workspace
    .getConfiguration(SECTION, resource ?? null)
    .update(subKey(key), undefined, configurationTarget(target));
}

/** "Reset" means "back to the default", so every level that could hold it is cleared. */
async function resetEverywhere(key: string, resource?: vscode.Uri): Promise<void> {
  const targets: WriteTarget[] =
    resource === undefined ? ["user", "workspace"] : ["user", "workspace", "workspaceFolder"];
  for (const target of targets) {
    try {
      await resetKey(key, target, resource);
    } catch {
      // An unwritable level is skipped; the others still get cleared.
    }
  }
}

async function applyPreset(id: string, resource?: vscode.Uri): Promise<void> {
  // `defaults` carries no values by design; it is the one preset that resets.
  if (id === "defaults") {
    for (const entry of SETTINGS) {
      await resetEverywhere(entry.key, resource);
    }
    return;
  }
  const target: WriteTarget = resource === undefined ? "user" : "workspace";
  for (const { key, value } of presetValues(id)) {
    const entry = setting(key);
    if (entry === undefined || !writable(entry, target, resource)) {
      continue;
    }
    const validated = validateValue(entry, value);
    if (!validated.ok) {
      continue;
    }
    try {
      await write(entry.key, validated.value, target, resource);
    } catch {
      // Keep applying the rest of the preset rather than stopping halfway.
    }
  }
}

/**
 * The whole model. Labels go through `t()`, so the panel follows the editor's
 * language exactly like the runtime messages do; registry titles and
 * descriptions are the same English strings `package.nls.*` carries, and fall
 * back to English until their translations land in `data/i18n`.
 */
function buildModel(resource?: vscode.Uri): PanelModel {
  const sections: PanelSection[] = GROUPS.map((group) => ({
    id: group.id,
    title: t(group.title),
    rows: settingsInGroup(group.id).map((entry) => buildRow(entry, resource)),
  })).filter((section) => section.rows.length > 0);
  const presets: PanelPreset[] = PRESETS.map((preset) => ({
    id: preset.id,
    title: t(preset.title),
    description: t(preset.description),
  }));
  const model: PanelModel = { sections, presets, ui: panelLabels() };
  const label = resource === undefined ? undefined : folderLabel(resource);
  if (label !== undefined) {
    model.resourceLabel = label;
  }
  return model;
}

function buildRow(entry: SettingEntry, resource?: vscode.Uri): PanelRow {
  const current = effective<PanelRow["value"]>(entry.key, resource);
  const row: PanelRow = {
    key: entry.key,
    title: t(entry.title),
    description: t(entry.description),
    type: entry.type,
    value: current.value,
    scope: entry.scope,
    applies: entry.applies,
    // `effective()` also reports `language`, which is a level, not a source the
    // panel can show a button for; it reads as a plain user-level value.
    source: current.source === "language" ? "default" : current.source,
    tier: entry.tier,
    since: entry.since,
  };
  if (entry.enum !== undefined) {
    // Enum values are identifiers (`auto`, `workspaceFolder`, `warning`); the
    // registry has no separate label for them and inventing copy here would
    // give the panel words the Settings editor does not use.
    row.options = entry.enum.map((value) => ({ value, label: value }));
  }
  if (entry.minimum !== undefined) {
    row.minimum = entry.minimum;
  }
  if (entry.maximum !== undefined) {
    row.maximum = entry.maximum;
  }
  if (entry.deprecated === true) {
    row.deprecated = true;
    if (entry.deprecationMessage !== undefined) {
      row.deprecationMessage = t(entry.deprecationMessage);
    }
  }
  return row;
}

/**
 * Every visible string, resolved once per model. These are the literals
 * `tools/l10n-check.mjs` holds to `data/i18n/zh-cn.json`.
 */
function panelLabels(): Record<string, string> {
  return {
    [PANEL_UI.htmlLang]: htmlLanguage(),
    [PANEL_UI.title]: t("mcpp settings"),
    [PANEL_UI.boundary]: t(
      "This panel changes mcpp-vscode settings only; the C++ Modules extension ({0}) keeps its own mcppls.* settings and this panel never writes them.",
      MCPPLS_EXTENSION_ID,
    ),
    [PANEL_UI.openMcpplsSettings]: t("Open the C++ Modules settings"),
    [PANEL_UI.resourceLabel]: t("Values shown for {0}"),
    [PANEL_UI.search]: t("Search settings"),
    [PANEL_UI.onlyModified]: t("Only modified"),
    [PANEL_UI.showAdvanced]: t("Show advanced settings"),
    [PANEL_UI.target]: t("Save settings to"),
    [PANEL_UI.targetUser]: t("User settings"),
    [PANEL_UI.targetWorkspace]: t("Workspace settings"),
    [PANEL_UI.targetWorkspaceUnavailable]: t("No workspace folder is open"),
    [PANEL_UI.presets]: t("Presets"),
    [PANEL_UI.modified]: t("Changed from the default"),
    [PANEL_UI.deprecated]: t("Deprecated"),
    [PANEL_UI.invalid]: t("Invalid"),
    [PANEL_UI.appliesNextBuild]: t("Takes effect on the next build"),
    [PANEL_UI.appliesNextClean]: t("Takes effect on the next clean"),
    [PANEL_UI.appliesViewReload]: t("Reload the window to see this"),
    [PANEL_UI.sourceDefault]: t("Default"),
    [PANEL_UI.sourceUser]: t("User"),
    [PANEL_UI.sourceWorkspace]: t("Workspace"),
    [PANEL_UI.sourceWorkspaceFolder]: t("Workspace folder"),
    [PANEL_UI.sourceInvalid]: t("Invalid"),
    [PANEL_UI.reset]: t("Reset"),
    [PANEL_UI.resetInvalid]: t("Reset the invalid value to the default"),
    [PANEL_UI.openNative]: t("Open in the Settings editor"),
    [PANEL_UI.arrayHint]: t("One value per line"),
    [PANEL_UI.noMatches]: t("No settings match the search"),
    [PANEL_UI.toggleSection]: t("Toggle this section"),
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

function postModel(active: PanelSession): void {
  void active.panel.webview.postMessage({ type: "model", model: buildModel(active.resource) });
}

/**
 * The folder whose values the panel shows. An active editor inside a workspace
 * folder wins (that is the project the user is looking at); otherwise the first
 * folder. `undefined` means "no resource", and then only user-level writes are
 * offered.
 */
function resourceUri(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active !== undefined) {
    const folder = vscode.workspace.getWorkspaceFolder(active);
    if (folder !== undefined) {
      return folder.uri;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function folderLabel(resource: vscode.Uri): string {
  return vscode.workspace.getWorkspaceFolder(resource)?.name ?? path.basename(resource.fsPath);
}

function mediaRoot(host: PanelHostContext): vscode.Uri {
  const extensionUri = host.extensionUri ?? vscode.extensions.getExtension(EXTENSION_ID)?.extensionUri;
  if (extensionUri !== undefined) {
    return vscode.Uri.joinPath(extensionUri, MEDIA_DIRECTORY);
  }
  // `dist/src/config/` -> the extension root, where `media/` ships.
  return vscode.Uri.file(path.join(__dirname, "..", "..", "..", MEDIA_DIRECTORY));
}
