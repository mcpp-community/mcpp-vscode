import assert from "node:assert/strict";
import test from "node:test";

import {
  PANEL_UI,
  decodePanelMessage,
  renderPanelHtml,
  type PanelAssets,
  type PanelModel,
  type PanelRow,
} from "../../src/config/panelHtml";

const ASSETS: PanelAssets = {
  cspSource: "vscode-webview://panel",
  nonce: "nonce-abc123",
  styleUri: "vscode-webview://panel/media/settings.css",
  scriptUri: "",
};

const UI: Record<string, string> = {
  [PANEL_UI.title]: "mcpp settings",
  [PANEL_UI.boundary]: "Only mcpp settings are changed here.",
  [PANEL_UI.openMcpplsSettings]: "Open the C++ Modules settings",
  [PANEL_UI.resourceLabel]: "Values shown for {0}",
  [PANEL_UI.search]: "Search settings",
  [PANEL_UI.onlyModified]: "Only modified",
  [PANEL_UI.showAdvanced]: "Show advanced settings",
  [PANEL_UI.target]: "Save settings to",
  [PANEL_UI.targetUser]: "User settings",
  [PANEL_UI.targetWorkspace]: "Workspace settings",
  [PANEL_UI.targetWorkspaceUnavailable]: "No workspace folder is open",
  [PANEL_UI.presets]: "Presets",
  [PANEL_UI.modified]: "Changed from the default",
  [PANEL_UI.deprecated]: "Deprecated",
  [PANEL_UI.invalid]: "Invalid",
  [PANEL_UI.appliesNextBuild]: "Takes effect on the next build",
  [PANEL_UI.appliesNextClean]: "Takes effect on the next clean",
  [PANEL_UI.appliesViewReload]: "Reload the window to see this",
  [PANEL_UI.sourceDefault]: "Default",
  [PANEL_UI.sourceUser]: "User",
  [PANEL_UI.sourceWorkspace]: "Workspace",
  [PANEL_UI.sourceWorkspaceFolder]: "Workspace folder",
  [PANEL_UI.sourceInvalid]: "Invalid",
  [PANEL_UI.reset]: "Reset",
  [PANEL_UI.resetInvalid]: "Reset the invalid value to the default",
  [PANEL_UI.openNative]: "Open in the Settings editor",
  [PANEL_UI.arrayHint]: "One value per line",
  [PANEL_UI.noMatches]: "No settings match the search",
  [PANEL_UI.toggleSection]: "Toggle this section",
};

function row(overrides: Partial<PanelRow> & { key: string }): PanelRow {
  return {
    title: overrides.key,
    description: "A description.",
    type: "boolean",
    value: false,
    scope: "resource",
    applies: "immediate",
    source: "default",
    tier: "public",
    since: "0.5.0",
    ...overrides,
  };
}

function page(rows: PanelRow[], extra: Partial<PanelModel> = {}): string {
  const model: PanelModel = {
    sections: [{ id: "cache", title: "Cache", rows }],
    presets: [{ id: "defaults", title: "Defaults", description: "Back to the shipped defaults." }],
    ui: UI,
    ...extra,
  };
  return renderPanelHtml(model, ASSETS);
}

/** The opening tag of the row element for `key`. */
function rowTag(html: string, key: string): string {
  const start = html.indexOf(`data-row="${key}"`);
  assert.ok(start >= 0, `no row rendered for ${key}`);
  const from = html.lastIndexOf("<div", start);
  return html.slice(from, html.indexOf(">", start) + 1);
}

test("the document carries the nonce in the CSP and on the script tag", () => {
  const html = page([row({ key: "mcpp.path" })]);
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("style-src vscode-webview://panel;"));
  assert.ok(html.includes("script-src 'nonce-nonce-abc123'"));
  assert.ok(html.includes("img-src vscode-webview://panel\""));
  assert.ok(html.includes('<script nonce="nonce-abc123">'));
  assert.ok(!/https?:\/\//.test(html), "no external resources");
  assert.ok(!/ style="/.test(html), "no inline style attributes");
});

test("a title or description containing markup is escaped", () => {
  const html = page([
    row({
      key: "mcpp.path",
      title: 'Path <script>alert("x")</script>',
      description: "A <b>bold</b> description",
    }),
  ]);
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("Path &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("A &lt;b&gt;bold&lt;/b&gt; description"));
});

test("an advanced row is not visible by default", () => {
  const html = page([
    row({ key: "mcpp.path" }),
    row({ key: "mcpp.runtime.timeoutSeconds", type: "number", value: 30, tier: "advanced" }),
  ]);
  assert.ok(rowTag(html, "mcpp.runtime.timeoutSeconds").includes("hidden"));
  assert.ok(!rowTag(html, "mcpp.path").includes("hidden"));
  assert.ok(html.includes('id="panel-show-advanced"'));
});

test("a deprecated row is marked and shows its message", () => {
  const html = page([
    row({
      key: "mcpp.tomlCompletion",
      tier: "advanced",
      deprecated: true,
      deprecationMessage: "Use mcpp.toml.completion instead.",
    }),
  ]);
  assert.ok(html.includes("Use mcpp.toml.completion instead."));
  assert.ok(rowTag(html, "mcpp.tomlCompletion").includes('data-deprecated="true"'));
  assert.ok(html.includes('data-badge="deprecated"'));
});

test("an invalid row is marked and its control is disabled", () => {
  const html = page([row({ key: "mcpp.task.buildArgs", type: "array", value: [], source: "invalid" })]);
  assert.ok(rowTag(html, "mcpp.task.buildArgs").includes('data-source="invalid"'));
  assert.ok(html.includes('data-badge="invalid">Invalid</span>'));
  assert.ok(html.includes('data-action="reset"'));
  const control = html.slice(html.indexOf('data-row="mcpp.task.buildArgs"'));
  assert.ok(/data-kind="array"[^>]*disabled/.test(control), "the value input is closed");
});

test("the search, filter, preset and section controls are present", () => {
  const html = page([row({ key: "mcpp.path" })]);
  for (const needle of [
    'id="panel-search"',
    'id="panel-only-modified"',
    'id="panel-show-advanced"',
    'id="panel-target"',
    'data-preset="defaults"',
    "data-section-toggle",
    "data-section=",
    'id="panel-open-mcppls"',
    'id="panel-empty"',
    'data-action="reset"',
    'data-action="openNative"',
  ]) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
});

test("rows show the effective source and the applies hint", () => {
  const html = page([
    row({ key: "mcpp.task.buildArgs", type: "array", value: ["--release"], source: "workspace", applies: "next-build" }),
    row({ key: "mcpp.path" }),
  ]);
  assert.ok(rowTag(html, "mcpp.task.buildArgs").includes('data-source="workspace"'));
  assert.ok(html.includes('data-badge="source">Workspace</span>'));
  assert.ok(html.includes('<p class="row-applies">Takes effect on the next build</p>'));
  assert.ok(html.includes('<p class="row-applies" hidden></p>'), "an immediate setting carries no hint");
});

test("the panel names the mcppls boundary and links to its settings", () => {
  const html = page([row({ key: "mcpp.path" })]);
  assert.ok(html.includes("Only mcpp settings are changed here."));
  assert.ok(html.includes("Open the C++ Modules settings"));
});

test("a folder label is interpolated and enables workspace writes", () => {
  const withFolder = page([row({ key: "mcpp.path" })], { resourceLabel: "greeter" });
  assert.ok(withFolder.includes("Values shown for greeter"));
  assert.ok(/<option value="workspace" selected/.test(withFolder));

  const withoutFolder = page([row({ key: "mcpp.path" })]);
  assert.ok(/<option value="workspace" disabled/.test(withoutFolder));
  assert.ok(/<option value="user" selected/.test(withoutFolder));
});

test("decodePanelMessage accepts every valid shape", () => {
  assert.deepEqual(decodePanelMessage({ type: "ready" }), { type: "ready" });
  assert.deepEqual(decodePanelMessage({ type: "openMcpplsSettings" }), { type: "openMcpplsSettings" });
  assert.deepEqual(decodePanelMessage({ type: "update", key: "mcpp.cache.staleDays", value: 7, target: "user" }), {
    type: "update",
    key: "mcpp.cache.staleDays",
    value: 7,
    target: "user",
  });
  assert.deepEqual(
    decodePanelMessage({ type: "update", key: "mcpp.views.cache.ageBuckets", value: ["1d"], target: "workspace" }),
    { type: "update", key: "mcpp.views.cache.ageBuckets", value: ["1d"], target: "workspace" },
  );
  assert.deepEqual(decodePanelMessage({ type: "reset", key: "mcpp.cache.staleDays" }), {
    type: "reset",
    key: "mcpp.cache.staleDays",
  });
  assert.deepEqual(decodePanelMessage({ type: "preset", id: "quiet" }), { type: "preset", id: "quiet" });
  assert.deepEqual(decodePanelMessage({ type: "openNative", key: "mcpp.path" }), {
    type: "openNative",
    key: "mcpp.path",
  });
});

test("decodePanelMessage rejects garbage", () => {
  const rejected: unknown[] = [
    null,
    undefined,
    42,
    "update",
    [],
    {},
    { type: "update" },
    { type: "update", key: "" },
    { type: "update", key: 7, value: 1, target: "user" },
    { type: "update", key: "mcpp.path", value: 1 },
    { type: "update", key: "mcpp.path", target: "user" },
    { type: "update", key: "mcpp.path", value: 1, target: "elsewhere" },
    { type: "reset" },
    { type: "reset", key: 7 },
    { type: "preset" },
    { type: "preset", id: "" },
    { type: "openNative" },
    { type: "nope" },
  ];
  for (const raw of rejected) {
    assert.equal(decodePanelMessage(raw), undefined, `accepted ${JSON.stringify(raw)}`);
  }
});

test("decodePanelMessage rebuilds the message and drops foreign fields", () => {
  assert.deepEqual(decodePanelMessage({ type: "reset", key: "mcpp.path", extra: true }), {
    type: "reset",
    key: "mcpp.path",
  });
});
