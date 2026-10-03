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
  [DETAIL_UI.versionsPick]: "Click a version to aim the command above at it.",
  [DETAIL_UI.dependencies]: "Dependencies",
  [DETAIL_UI.dependenciesNone]: "This descriptor declares no dependencies.",
  [DETAIL_UI.dependenciesHint]: "What the descriptor declares.",
  [DETAIL_UI.resolved]: "resolved {0}",
  [DETAIL_UI.code]: "Example code",
  [DETAIL_UI.codeNone]: "This package has no test project in the index.",
  [DETAIL_UI.codeSource]: "{0} · line {1}",
  [DETAIL_UI.codeProject]: "Example project: {0} — built and run by the index's CI.",
  [DETAIL_UI.add]: "Add to mcpp.toml",
  [DETAIL_UI.switchTo]: "Switch to {0}",
  [DETAIL_UI.alreadyAdded]: "Already added",
  [DETAIL_UI.installed]: "added",
  [DETAIL_UI.opening]: "Opening {0}…",
  [DETAIL_UI.addDev]: "dev dependency",
  [DETAIL_UI.addLatest]: "The version is required.",
  [DETAIL_UI.addNoVersion]: "This index publishes no version for this platform.",
  [DETAIL_UI.command]: "Command",
  [DETAIL_UI.usage]: "Bring it into your code",
  [DETAIL_UI.copy]: "Copy",
  [DETAIL_UI.copied]: "Copied to the clipboard.",
  [DETAIL_UI.copying]: "Copying…",
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
    usage: [],
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
  // The repository and the index page are buttons in the action row, not links at
  // the end of the facts line: they are things to *do*, and one row of them is
  // easier to find than a link that wraps with the metadata.
  assert.match(html, /<button type="button" data-secondary data-open-url="https:\/\/github\.com\/p-ranav\/argparse">Open the repository<\/button>/);
  assert.match(
    html,
    /<button type="button" data-secondary data-open-url="https:\/\/mcpplibs\.github\.io\/mcpp-index\/packages\/compat\.argparse\/">Open on the index site<\/button>/,
  );
  const actions = html.slice(html.indexOf('class="detail-actions"'), html.indexOf("</div>", html.indexOf('class="detail-actions"')));
  assert.match(actions, /id="detail-add"/);
  assert.match(actions, /Open the repository/);
  assert.match(actions, /Open on the index site/);
  assert.doesNotMatch(html, /<a href="https:/, "no bare link is left in the facts line");
});

test("the version matrix marks the current platform, empty groups and all", () => {
  const html = renderDetailHtml(model(), ASSETS);
  assert.match(html, /Versions \(linux\)/);
  // Each version is a button that aims the command at the top of the page at
  // itself, and the one the page opens on is marked.
  assert.match(
    html,
    /<li class="detail-version-group" data-current><span class="detail-platform">linux<\/span><span class="detail-version-list"><button type="button" class="detail-version" data-version="3\.2" data-selected>3\.2<\/button><\/span><span class="detail-current">this platform<\/span><\/li>/,
  );
  assert.match(
    html,
    /<li class="detail-version-group"><span class="detail-platform">windows<\/span><span class="detail-version-list"><span class="detail-version-empty">—<\/span><\/span><\/li>/,
  );
  assert.match(html, /Click a version to aim the command above at it\./);

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
    model({ dependencies: [{ id: "compat.zlib", version: "1.3", resolved: "1.2.13" }] }),
    ASSETS,
  );
  assert.match(resolved, /<code>compat\.zlib<\/code> — 1\.3 · resolved 1\.2\.13/);
  const none = renderDetailHtml(model({ dependencies: [] }), ASSETS);
  assert.match(none, /This descriptor declares no dependencies\./);
});

test("the add button carries the exact command, and is disabled when there is no version", () => {
  const html = renderDetailHtml(model(), ASSETS);
  // One place chooses the version (the matrix) and one place shows what the
  // choice produces; there is no second, redundant `<select>` any more.
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /id="detail-command" data-selected-version="3\.2" data-template="mcpp add \{0\}@\{1\}"/);
  assert.match(html, /data-template-dev="mcpp add \{0\}@\{1\} --dev"/);
  assert.match(html, /<button type="button" id="detail-add" class="detail-add">Add to mcpp\.toml<\/button>/);
  assert.match(html, /<input id="detail-dev" type="checkbox"/);

  // The primary block comes before the sections, right under the header.
  const primary = html.indexOf('data-section="add"');
  const versions = html.indexOf('data-section="versions"');
  assert.ok(primary !== -1 && versions !== -1 && primary < versions, "the action must sit above the version matrix");

  const none = renderDetailHtml(model({ latest: undefined, currentVersions: [] }), ASSETS);
  assert.match(none, /<button type="button" id="detail-add" class="detail-add" disabled>/);
  assert.match(none, /This index publishes no version for this platform\./);
});

test("a package the project already has says so, and the button offers the switch", () => {
  // Same version as the manifest: nothing to do, and the button says so — with
  // `data-installed`, which paints it the thinned green of a done thing.
  const same = renderDetailHtml(model({ installed: { version: "3.2", dev: false } }), ASSETS);
  assert.match(
    same,
    /<button type="button" id="detail-add" class="detail-add" disabled data-installed>Already added<\/button>/,
  );
  assert.match(same, /data-version="3\.2" data-selected data-installed>3\.2<\/button><span class="detail-installed">added<\/span>/);

  // A different version: the button names the switch, and the marker stays on the
  // version the project actually has.
  const other = renderDetailHtml(
    model({
      latest: "3.3",
      currentVersions: ["3.3", "3.2"],
      versions: [{ platform: "linux", versions: ["3.3", "3.2"], current: true }],
      installed: { version: "3.2", dev: false },
    }),
    ASSETS,
  );
  assert.match(other, /<button type="button" id="detail-add" class="detail-add">Switch to 3\.3<\/button>/);
  assert.doesNotMatch(other, /id="detail-add"[^>]*disabled/);
  assert.match(other, /data-version="3\.2"[^>]*data-installed>3\.2<\/button><span class="detail-installed">added<\/span>/);

  // Not a dependency at all: the original label, and no marker anywhere.
  const fresh = renderDetailHtml(model(), ASSETS);
  assert.match(fresh, />Add to mcpp\.toml<\/button>/);
  // The script can move a marker, so the check is on the markup, not the page.
  assert.doesNotMatch(fresh, /class="detail-installed"/);
});

test("the client can re-decide the button, and a link click is never silent", () => {
  const html = renderDetailHtml(model({ installed: { version: "3.1", dev: false } }), ASSETS);
  // The labels and the installed version travel with the page: the button's
  // meaning changes with the selection, and the selection lives in the client.
  assert.match(html, /"installed":"3\.1"/);
  assert.match(html, /"switchTo":"Switch to \{0\}"/);
  assert.match(html, /"alreadyAdded":"Already added"/);
  assert.match(html, /"opening":"Opening \{0\}…"/);
  // The marker word belongs to the client too: `markInstalled()` writes it
  // after a successful add, and an empty string there is a marker nobody can
  // read (the §22 fix).
  assert.match(html, /"installed":"added"/);
  assert.match(html, /"copying":"Copying…"/);
  const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html);
  assert.ok(script !== null);
  assert.match(script[1], /function updateButton\(\)/);
  assert.match(script[1], /showResult\(\{ state: "pending"/);
  assert.match(script[1], /updateButton\(\);/);
  // The inert state is the one that paints green, so the client has to toggle
  // the attribute exactly when it toggles the disabled state.
  assert.match(script[1], /setAttribute\("data-installed", ""\)/);
  assert.match(script[1], /removeAttribute\("data-installed"\)/);
});

test("the usage lines and the command each carry their own copy button (§22)", () => {
  const html = renderDetailHtml(
    model({ usage: ["import openkal.types;", "#include <argparse/argparse.hpp>"] }),
    ASSETS,
  );
  assert.match(html, />Bring it into your code</);
  assert.match(
    html,
    /<p class="detail-usage-line"><code>import openkal\.types;<\/code><button type="button" class="detail-copy" data-copy="import openkal\.types;">Copy<\/button><\/p>/,
  );
  assert.match(html, /data-copy="#include &lt;argparse\/argparse\.hpp&gt;"/);
  // The command's copy button sits beside the paragraph, not inside it, so
  // `command.textContent` is exactly the command a click copies.
  assert.match(html, /<div class="detail-command-row">/);
  assert.match(
    html,
    /<\/p>\s*<button type="button" class="detail-copy" data-copy-command>Copy<\/button>\s*<\/div>/,
  );
  // A page with nothing to import says nothing rather than inventing a line.
  const bare = renderDetailHtml(model({ usage: [] }), ASSETS);
  assert.doesNotMatch(bare, /detail-usage-line/);
  assert.doesNotMatch(bare, />Bring it into your code</);
  // The client asks the host to copy, and says so while it waits.
  const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html);
  assert.ok(script !== null);
  assert.match(script[1], /post\(\{ type: "copy", text: text \}\)/);
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
  assert.doesNotMatch(html, /Open on the index site/);
  // The repository button is still there: only the index-site button is
  // registry-dependent.
  assert.match(html, /data-open-url="https:\/\/github\.com\/p-ranav\/argparse"/);
});

test("decodeDetailMessage accepts exactly three shapes, and only https urls", () => {
  assert.deepEqual(decodeDetailMessage({ type: "add", version: "3.2", dev: false }), {
    type: "add",
    version: "3.2",
    dev: false,
  });
  assert.deepEqual(decodeDetailMessage({ type: "openUrl", url: "https://example.invalid/x" }), {
    type: "openUrl",
    url: "https://example.invalid/x",
  });
  assert.deepEqual(decodeDetailMessage({ type: "copy", text: "mcpp add compat.argparse@3.2" }), {
    type: "copy",
    text: "mcpp add compat.argparse@3.2",
  });
  // A long-but-real payload (a padded command, a wrapped usage line) still
  // copies; only a document trying to park a novel is refused.
  const longCopy = decodeDetailMessage({ type: "copy", text: "mcpp add " + "x".repeat(2_000) });
  assert.equal(longCopy?.type, "copy");

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
    // Clipboard content is the user's own click, but a novel is not: the cap
    // keeps a hostile document from parking megabytes in the clipboard.
    { type: "copy" },
    { type: "copy", text: "" },
    { type: "copy", text: 42 },
    { type: "copy", text: "x".repeat(16_385) },
    // The page used to announce its own load. The host answered with an empty
    // `return`, so nothing looped here — but the shape is the one that made the
    // library view reload itself forever, so the message is gone.
    { type: "ready" },
  ]) {
    assert.equal(decodeDetailMessage(raw), undefined, `unexpected decode of ${JSON.stringify(raw)}`);
  }
});

test("the client script is syntactically valid JavaScript, and posts no ready", () => {
  // A syntax error in the inline script would leave a page that renders
  // perfectly and does nothing, and no other test would notice.
  const html = renderDetailHtml(model(), ASSETS);
  const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html);
  assert.ok(script !== null, "the document must carry its inline script");
  assert.doesNotThrow(() => new Function(script[1]));
  assert.doesNotMatch(script[1], /innerHTML/);
  assert.doesNotMatch(script[1], /"ready"/);
  assert.match(script[1], /data-version/);
  assert.match(script[1], /textContent/);
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
