import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  LIBRARY_UI,
  badgeLabels,
  decodeLibraryMessage,
  renderLibraryHtml,
  type LibraryAssets,
  type LibraryModel,
} from "../../src/library/libraryHtml";

const ASSETS: LibraryAssets = {
  cspSource: "vscode-webview://library",
  nonce: "nonce-library123",
  styleUri: "vscode-webview://library/media/library.css",
};

const UI: Record<string, string> = {
  [LIBRARY_UI.htmlLang]: "en",
  [LIBRARY_UI.title]: "Library",
  [LIBRARY_UI.search]: "Search packages",
  [LIBRARY_UI.networkSearch]: "Search all registries",
  [LIBRARY_UI.networkSearchHint]: "Off by default.",
  [LIBRARY_UI.versionLatest]: "latest {0}",
  [LIBRARY_UI.surfaceExternal]: "upstream mcpp.toml",
  [LIBRARY_UI.badgeExamples]: "✓ Has examples",
  [LIBRARY_UI.badgeCn]: "China mirror",
  [LIBRARY_UI.badgeOpenkalEcosystem]: "openkal-ecosystem",
  [LIBRARY_UI.badgeOpenkalCompat]: "openkal-compat",
  [LIBRARY_UI.badgeOpenkalPosix]: "POSIX environment",
  [LIBRARY_UI.badgeOpenkalPlatform]: "uses platform interfaces",
  [LIBRARY_UI.added]: "Added",
  [LIBRARY_UI.unreadable]: "Descriptor not readable",
  [LIBRARY_UI.crossRegistry]: "other registry",
  [LIBRARY_UI.noResults]: "No package matches this search.",
  [LIBRARY_UI.noIndex]: "No mcpp index was found.",
  [LIBRARY_UI.count]: "{0} of {1} packages",
  [LIBRARY_UI.open]: "Open the detail page for {0}",
  [LIBRARY_UI.refresh]: "Refresh",
};

function model(patch: Partial<LibraryModel> = {}): LibraryModel {
  return {
    ui: UI,
    rows: [
      {
        id: "compat.argparse",
        namespace: "compat",
        name: "argparse",
        version: "3.2",
        surface: "header",
        surfaces: ["header"],
        badges: ["examples", "cn"],
        haystack: "compat.argparse argparse — header-only argument parser for modern c++ mit mcpplibs",
        description: "argparse — header-only argument parser for modern C++",
        added: true,
        unreadable: false,
      },
      {
        id: "mcpplibs.cmdline",
        namespace: "mcpplibs",
        name: "cmdline",
        version: "0.0.2",
        surface: "module",
        surfaces: ["module"],
        badges: [],
        haystack: "mcpplibs.cmdline command line parsing mcpplibs",
        description: "Command line parsing",
        added: false,
        unreadable: false,
      },
    ],
    query: "",
    networkSearch: false,
    networkSearchSetting: "mcpp.library.networkSearch",
    dataSource: "Data source: 2 descriptor(s) from 1 local index folder(s): mcpplibs. Read offline.",
    countTemplate: UI[LIBRARY_UI.count],
    total: 2,
    ...patch,
  };
}

test("the document is a strict, self-contained webview", () => {
  const html = renderLibraryHtml(model(), ASSETS);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(
    html,
    /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src vscode-webview:\/\/library; script-src 'nonce-nonce-library123'; img-src vscode-webview:\/\/library">/,
  );
  assert.match(html, /<script nonce="nonce-library123">/);
  assert.match(html, /<link rel="stylesheet" href="vscode-webview:\/\/library\/media\/library.css">/);
  // No external resources, and no inline styles anywhere.
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /<img/);
});

test("every interpolated value is escaped, and nothing else can close the script", () => {
  const hostile = renderLibraryHtml(
    model({
      // A translation is data too: it must not be able to close the script either.
      countTemplate: "</script><b>{0}",
      rows: [
        {
          id: '</script><img src=x onerror="alert(1)">',
          namespace: '" onmouseover="evil',
          name: "x",
          surface: "external",
          surfaces: ["external"],
          badges: [],
          haystack: "hostile description",
          description: "a & b <c> 'd' \"e\"",
          added: false,
          unreadable: true,
        },
      ],
    }),
    ASSETS,
  );
  // The raw tag never survives; the payload is inert inside the escaped attribute.
  assert.doesNotMatch(hostile, /<img src=x/);
  assert.match(hostile, /&lt;\/script&gt;&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(hostile, /&quot; onmouseover=&quot;evil/);
  assert.match(hostile, /a &amp; b &lt;c&gt; &#39;d&#39; &quot;e&quot;/);
  // An unreadable descriptor is labelled, not merely coloured.
  assert.match(hostile, /class="badge badge-warn" data-badge="unreadable">Descriptor not readable</);
  // The only `</script>` in the document is the one that ends our own script,
  // even though both the row and the count template carried one.
  assert.equal(hostile.split("</script>").length - 1, 1);
  // The embedded client state is `<`-escaped, so it cannot end the script element.
  assert.match(hostile, /\\u003c\/script>/);
});

test("a row carries the state the client filters on, as text", () => {
  const html = renderLibraryHtml(model(), ASSETS);
  assert.match(html, /data-row="compat\.argparse"/);
  assert.match(html, /data-namespace="compat"/);
  assert.match(html, /data-added="true"/);
  assert.match(html, /data-surfaces="header"/);
  assert.match(html, /class="badge badge-added" data-badge="added">Added</);
  // The version is right-aligned and labelled "latest", the way §10.2 asks.
  assert.match(html, /class="row-version"[^>]*>latest 3\.2</);
  // The description is clamped by class, and the full text stays in the title.
  assert.match(html, /class="row-description" title="argparse — header-only/);
  assert.match(html, /class="row-surface" data-surface="header">#include</);
  assert.match(html, /✓ Has examples/);
  assert.match(html, /China mirror/);
});

test("the toolbar is a search box and the network toggle, with no chip row", () => {
  // The filter chips used to sit between the two and, on a real index, wrapped
  // into three lines of buttons above the list. The namespace is part of every
  // row's haystack, so search reaches it; "Added" is a badge on the row.
  const html = renderLibraryHtml(model(), ASSETS);
  assert.match(html, /<input id="library-search"[^>]*placeholder="Search packages"/);
  assert.doesNotMatch(html, /class="chip/);
  assert.doesNotMatch(html, /data-chip/);
  assert.doesNotMatch(html, /class="chips"/);
  // The toggle still follows the search box, and no chip markup is left between.
  const toolbar = html.slice(html.indexOf('class="toolbar"'), html.indexOf("</div>", html.indexOf('class="toolbar"')));
  assert.match(toolbar, /library-search/);
  assert.match(toolbar, /library-network/);
});
test("the network toggle is off by default and names the setting it drives", () => {
  const off = renderLibraryHtml(model(), ASSETS);
  assert.match(off, /<input id="library-network" type="checkbox" data-setting="mcpp\.library\.networkSearch">/);
  assert.match(off, /Search all registries/);
  assert.doesNotMatch(off, /id="library-network"[^>]*checked/);

  const on = renderLibraryHtml(model({ networkSearch: true }), ASSETS);
  assert.match(on, /id="library-network"[^>]*checked/);
});

test("the header count starts at what the first render keeps, and the footer names the source", () => {
  // The count is the *query*'s count now: the filter chips that used to narrow it
  // are gone, so an empty search keeps every row.
  const html = renderLibraryHtml(model(), ASSETS);
  assert.match(html, /id="library-count">2 of 2 packages</);
  assert.match(html, /Data source: 2 descriptor\(s\) from 1 local index folder\(s\): mcpplibs\. Read offline\./);
  assert.match(html, /data-action="refresh"/);
});

test("an empty view still says something", () => {
  const html = renderLibraryHtml(model({ rows: [], total: 0, notice: "No mcpp index was found." }), ASSETS);
  assert.match(html, /id="library-empty" class="empty">No mcpp index was found\.</);
  assert.doesNotMatch(html, /id="library-list"/);
});

test("badgeLabels reads the ui record in badge order", () => {
  assert.deepEqual(
    badgeLabels(["examples", "cn", "openkal-compat", "openkal-posix"], (key) => UI[key] ?? key),
    ["✓ Has examples", "China mirror", "openkal-compat", "POSIX environment"],
  );
});

test("decodeLibraryMessage accepts exactly four shapes", () => {
  assert.deepEqual(decodeLibraryMessage({ type: "refresh" }), { type: "refresh" });
  assert.deepEqual(decodeLibraryMessage({ type: "search", query: "" }), { type: "search", query: "" });
  assert.deepEqual(decodeLibraryMessage({ type: "networkSearch", enabled: true }), {
    type: "networkSearch",
    enabled: true,
  });
  assert.deepEqual(decodeLibraryMessage({ type: "open", id: "compat.argparse" }), {
    type: "open",
    id: "compat.argparse",
  });

  for (const raw of [
    undefined,
    null,
    "ready",
    [],
    { type: "unknown" },
    // The chips are gone, so the `filter` message they sent is not a shape.
    { type: "filter", chip: "added" },
    { type: "open" },
    { type: "open", id: "" },
    { type: "networkSearch", enabled: "yes" },
    { type: "search" },
    // The document used to announce itself with this, and the host used to answer
    // by re-rendering — which reloads the view, which announced itself again.
    { type: "ready" },
    { type: "ready", extra: "field" },
  ]) {
    assert.equal(decodeLibraryMessage(raw), undefined, `unexpected decode of ${JSON.stringify(raw)}`);
  }
});

test("the document announces nothing, so it cannot make the host re-render it", () => {
  const html = renderLibraryHtml(model(), ASSETS);
  // The client script posts search / filter / networkSearch / open / refresh and
  // nothing else. A "ready" post is what turned a render into a reload loop:
  // `webview.html = …` reloads the document, so a document that answers its own
  // load with "render me again" never stops loading.
  assert.doesNotMatch(html, /post\(\{\s*type:\s*"ready"/);
  assert.match(html, /post\(\{\s*type:\s*"refresh"\s*\}\)/);
});

test("the stylesheet uses theme tokens only, and clamps the description to two lines", () => {
  const css = readFileSync(path.join(process.cwd(), "media", "library.css"), "utf8");
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const literals = withoutComments.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
  assert.deepEqual(literals, [], `library.css must not hard-code a colour: ${literals.join(", ")}`);
  assert.match(withoutComments, /-webkit-line-clamp: 2/);
  assert.match(withoutComments, /var\(--vscode-/);
  // Colour is never the only signal: the added state is a bordered badge class.
  assert.match(withoutComments, /\.badge-added/);
});

test("the client script is syntactically valid JavaScript", () => {
  // A syntax error in the inline script would silently break the webview, and no
  // other test would notice: the document still contains all the right markup.
  const html = renderLibraryHtml(model({ query: "compat" }), ASSETS);
  const script = /<script nonce="[^"]*">([\s\S]*)<\/script>/.exec(html);
  assert.ok(script !== null, "the document must carry its inline script");
  assert.doesNotThrow(() => new Function(script[1]));
  // The client only ever writes through these two APIs, never through innerHTML.
  assert.doesNotMatch(script[1], /innerHTML/);
  assert.match(script[1], /textContent/);
});
