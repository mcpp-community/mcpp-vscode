import assert from "node:assert/strict";
import test from "node:test";

import {
  DETAIL_UI,
  decodeDetailMessage,
  renderDetailHtml,
  type DetailAssets,
  type DetailModel,
} from "../../src/library/detailHtml";

const ASSETS: DetailAssets = {
  cspSource: "vscode-webview://detail",
  nonce: "nonce-detail123",
  styleUri: "vscode-webview://detail/media/library.css",
};

const UI: Record<string, string> = {
  [DETAIL_UI.htmlLang]: "en",
  [DETAIL_UI.title]: "Library package {0}",
  [DETAIL_UI.overview]: "Build shape",
  [DETAIL_UI.license]: "License",
  [DETAIL_UI.repo]: "Repository",
  [DETAIL_UI.openRepo]: "Open the repository",
  [DETAIL_UI.registry]: "Registry",
  [DETAIL_UI.surface]: "Use",
  [DETAIL_UI.surfaceExternal]: "upstream mcpp.toml",
  [DETAIL_UI.standard]: "Standard",
  [DETAIL_UI.versions]: "Versions ({0})",
  [DETAIL_UI.versionsAll]: "Versions",
  [DETAIL_UI.versionsCurrent]: "this platform",
  [DETAIL_UI.versionsNone]: "This index publishes no version for any platform.",
  [DETAIL_UI.dependencies]: "Dependencies",
  [DETAIL_UI.dependenciesNone]: "This descriptor declares no dependencies.",
  [DETAIL_UI.dependenciesHint]: "What the descriptor declares.",
  [DETAIL_UI.resolved]: "resolved {0}",
  [DETAIL_UI.dev]: "dev",
  [DETAIL_UI.code]: "Example code",
  [DETAIL_UI.codeNone]: "This package has no test project in the index.",
  [DETAIL_UI.codeSource]: "{0} · line {1}",
  [DETAIL_UI.codeProject]: "Example project: {0} — built and run by the index's CI.",
  [DETAIL_UI.add]: "Add to mcpp.toml",
  [DETAIL_UI.addDev]: "dev dependency",
  [DETAIL_UI.addLatest]: "The version is required.",
  [DETAIL_UI.addNoVersion]: "This index publishes no version for this platform.",
  [DETAIL_UI.command]: "Command",
  [DETAIL_UI.indexLink]: "Open on the index site",
  [DETAIL_UI.badgeExamples]: "✓ Has examples",
  [DETAIL_UI.badgeCn]: "China mirror",
  [DETAIL_UI.badgeOpenkalEcosystem]: "openkal-ecosystem",
  [DETAIL_UI.badgeOpenkalCompat]: "openkal-compat",
  [DETAIL_UI.badgeOpenkalPosix]: "POSIX environment",
  [DETAIL_UI.badgeOpenkalPlatform]: "uses platform interfaces",
  [DETAIL_UI.targets]: "Targets",
  [DETAIL_UI.includeDirs]: "Include directories",
};

function model(patch: Partial<DetailModel> = {}): DetailModel {
  return {
    ui: UI,
    id: "compat.argparse",
    name: "argparse",
    description: "argparse — header-only argument parser for modern C++",
    licenses: ["MIT"],
    repo: "https://github.com/p-ranav/argparse",
    registry: "mcpplibs",
    surface: "header",
    surfaces: ["header"],
    badges: ["examples", "cn", "openkal-compat", "openkal-posix"],
    versions: [
      { platform: "linux", versions: ["3.2"], current: true },
      { platform: "windows", versions: [], current: false },
    ],
    currentVersions: ["3.2"],
    latest: "3.2",
    standard: "c++23",
    dependencies: [{ id: "compat.vulkan", version: "1.4.357.3" }],
    includeDirs: ["*/include"],
    targets: ["argparse"],
    snippets: [
      {
        file: "tests/examples/argparse/tests/parse.cpp",
        startLine: 1,
        lines: ["// Behavioral test", '#include <argparse/argparse.hpp>', "int main() { return 0; }"],
        usageLine: 2,
      },
    ],
    exampleProject: "argparse",
    indexUrl: "https://mcpplibs.github.io/mcpp-index/packages/compat.argparse/",
    commandTemplate: "mcpp add {0}@{1}",
    commandDevTemplate: "mcpp add {0}@{1} --dev",
    dataSource: "Read offline from /index/pkgs/c/compat.argparse.lua in the mcpplibs index (1 index folder(s) found).",
    ...patch,
  };
}

test("the detail page is a strict, self-contained webview", () => {
  const html = renderDetailHtml(model(), ASSETS);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(
    html,
    /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src vscode-webview:\/\/detail; script-src 'nonce-nonce-detail123'; img-src vscode-webview:\/\/detail">/,
  );
  assert.match(html, /<script nonce="nonce-detail123">/);
  assert.match(html, /<link rel="stylesheet" href="vscode-webview:\/\/detail\/media\/library.css">/);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.match(html, /<body class="detail">/);
});

test("the overview names the vocabulary the index site uses", () => {
  const html = renderDetailHtml(model(), ASSETS);
  assert.match(html, /<span class="badge">Registry: mcpplibs<\/span>/);
  assert.match(html, /<span class="badge">Use: #include<\/span>/);
  assert.match(html, /<span class="badge">Standard: c\+\+23<\/span>/);
  assert.match(html, /✓ Has examples/);
  assert.match(html, /China mirror/);
  assert.match(html, /openkal-compat/);
  assert.match(html, /POSIX environment/);
  assert.match(html, /MIT/);
  assert.match(html, /href="https:\/\/github\.com\/p-ranav\/argparse"/);
  assert.match(html, /href="https:\/\/mcpplibs\.github\.io\/mcpp-index\/packages\/compat\.argparse\/"/);
});

test("the version matrix marks the current platform, empty groups and all", () => {
  const html = renderDetailHtml(model(), ASSETS);
  assert.match(html, /Versions \(linux\)/);
  assert.match(
    html,
    /<span class="detail-version-group" data-current><span class="detail-platform">linux<\/span><span class="detail-version">3\.2<\/span><span class="detail-current">this platform<\/span>/,
  );
  assert.match(html, /<span class="detail-version-group"><span class="detail-platform">windows<\/span><span class="detail-version">—<\/span>/);

  const none = renderDetailHtml(model({ versions: [], currentVersions: [], latest: undefined }), ASSETS);
  assert.match(none, /This index publishes no version for any platform\./);

  // No group is "current" when the host platform is not one the index knows.
  const elsewhere = renderDetailHtml(
    model({ versions: [{ platform: "windows", versions: ["3.2"], current: false }] }),
    ASSETS,
  );
  assert.match(elsewhere, /<h2>Versions<\/h2>/);
});

test("the example block is highlighted, escaped and marked at the usage line", () => {
  const hostile = renderDetailHtml(
    model({
      snippets: [
        {
          file: "a.cpp",
          startLine: 1,
          lines: ['#include <x.h> // </script><b>', "import a.b;", ""],
          usageLine: 2,
        },
      ],
    }),
    ASSETS,
  );
  assert.match(hostile, /class="tok-punctuation">#<\/span>/);
  assert.match(hostile, /class="tok-keyword">include<\/span>/);
  assert.match(hostile, /class="tok-comment">\/\/ &lt;\/script&gt;&lt;b&gt;<\/span>/);
  assert.match(hostile, /class="tok-keyword">import<\/span>/);
  assert.match(hostile, /<span class="code-line" data-usage>/);
  assert.match(hostile, /a\.cpp · line 1/);
  assert.match(hostile, /Example project: argparse/);
  assert.equal(hostile.split("</script>").length - 1, 1, "the hostile comment cannot close our script");

  const none = renderDetailHtml(model({ snippets: [], exampleProject: undefined }), ASSETS);
  assert.match(none, /This package has no test project in the index\./);
});

test("dependencies are listed as declared, and the resolved column is left out when unknown", () => {
  const html = renderDetailHtml(model(), ASSETS);
  assert.match(html, /<code>compat\.vulkan<\/code> — 1\.4\.357\.3/);
  assert.match(html, /What the descriptor declares\./);
  const resolved = renderDetailHtml(
    model({ dependencies: [{ id: "compat.zlib", version: "1.3", dev: true, resolved: "1.2.13" }] }),
    ASSETS,
  );
  assert.match(resolved, /<code>compat\.zlib<\/code> — 1\.3 · dev · resolved 1\.2\.13/);
  const none = renderDetailHtml(model({ dependencies: [] }), ASSETS);
  assert.match(none, /This descriptor declares no dependencies\./);
});

test("the add button carries the exact command, and is disabled when there is no version", () => {
  const html = renderDetailHtml(model(), ASSETS);
  assert.match(html, /<select id="detail-version"[^>]*>/);
  assert.match(html, /<option value="3\.2" selected>3\.2<\/option>/);
  assert.match(html, /id="detail-command" data-template="mcpp add \{0\}@\{1\}"/);
  assert.match(html, /data-template-dev="mcpp add \{0\}@\{1\} --dev"/);
  assert.match(html, /<button type="button" id="detail-add">Add to mcpp\.toml<\/button>/);
  assert.match(html, /<input id="detail-dev" type="checkbox"/);

  const none = renderDetailHtml(model({ latest: undefined, currentVersions: [] }), ASSETS);
  assert.match(none, /<button type="button" id="detail-add" disabled>/);
  assert.match(none, /This index publishes no version for this platform\./);
});

test("a parse failure is stated on the page instead of leaving it blank", () => {
  const html = renderDetailHtml(
    model({ parseNotice: "mcpp xpkg parse could not read this descriptor." }),
    ASSETS,
  );
  assert.match(html, /mcpp xpkg parse could not read this descriptor\./);
  assert.match(html, /Read offline from/);
});

test("an index url is optional: a registry without a site gets no link", () => {
  const html = renderDetailHtml(model({ indexUrl: undefined, registry: "xim-pkgindex" }), ASSETS);
  assert.doesNotMatch(html, /mcpplibs\.github\.io/);
  assert.doesNotMatch(html, /<a [^>]*>Open on the index site<\/a>/);
  // The repo link is still there: only the index-site link is registry-dependent.
  assert.match(html, /<a href="https:\/\/github\.com\/p-ranav\/argparse"/);
});

test("decodeDetailMessage accepts exactly three shapes, and only https urls", () => {
  assert.deepEqual(decodeDetailMessage({ type: "ready" }), { type: "ready" });
  assert.deepEqual(decodeDetailMessage({ type: "add", version: "3.2", dev: false }), {
    type: "add",
    version: "3.2",
    dev: false,
  });
  assert.deepEqual(decodeDetailMessage({ type: "openUrl", url: "https://example.invalid/x" }), {
    type: "openUrl",
    url: "https://example.invalid/x",
  });

  for (const raw of [
    undefined,
    null,
    42,
    [],
    { type: "unknown" },
    { type: "add", version: "", dev: false },
    { type: "add", version: "3.2" },
    { type: "add", version: "3.2", dev: "yes" },
    { type: "openUrl", url: "http://example.invalid/x" },
    { type: "openUrl", url: "file:///etc/passwd" },
    { type: "openUrl", url: "command:mcpp.build" },
    { type: "openUrl" },
  ]) {
    assert.equal(decodeDetailMessage(raw), undefined, `unexpected decode of ${JSON.stringify(raw)}`);
  }
});

test("the page reuses the sidebar's stylesheet and token classes", () => {
  const html = renderDetailHtml(model(), ASSETS);
  assert.match(html, /media\/library\.css/);
  // Token colours are classes, never inline styles.
  assert.match(html, /class="tok-keyword"/);
  assert.doesNotMatch(html, /color:\s*#/);
});

test("the client script is syntactically valid JavaScript", () => {
  const html = renderDetailHtml(model(), ASSETS);
  const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html);
  assert.ok(script !== null, "the document must carry its inline script");
  assert.doesNotThrow(() => new Function(script[1]));
  assert.doesNotMatch(script[1], /innerHTML/);
  assert.match(script[1], /textContent/);
});
