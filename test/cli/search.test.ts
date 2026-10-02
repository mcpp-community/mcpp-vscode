import assert from "node:assert/strict";
import test from "node:test";

import {
  indexCompletionRequest,
  parseSearchOutput,
  searchArguments,
  shouldSearch,
  withDeadline,
} from "../../src/cli/search";

/**
 * A capture of `mcpp search z --all-versions` from mcpp 2026.9.30.2: single
 * versions end the line with `(x.y.z)`, `--all-versions` lines list several
 * comma-separated versions (with a trailing `...`), and xim-only entries carry
 * no version at all.
 */
const REAL_CAPTURE = [
  "  compat:gzip-hpp       gzip-hpp — header-only gzip/deflate compression wrappers over zlib  (0.1.0)",
  "  compat:libpng         PNG reference library — portable PNG encode/decode (depends on zlib)  (1.6.43)",
  "  compat:zlib           A compression library  (1.3.2)",
  "  freedesktop:wayland-protocols-unstable  wayland-protocols unstable — the zwp_*/zxdg_* protocols still in flux  (1.49.1, 1.49)",
  "  mcpplibs:aarch64-virt-rt  Board support for QEMU's aarch64 virt machine  (0.2.1, 0.2.0, 0.1.1, ...)",
  "  scode:zlib            A Massively Spiffy Yet Delicately Unobtrusive Compression Library",
  "  xim:zlib              A massively spiffy yet delicately unobtrusive compression library",
].join("\n");

test("parses a real capture newest-first and skips narration and unversioned lines", () => {
  const versions = parseSearchOutput(REAL_CAPTURE);
  assert.deepEqual(
    versions.map((entry) => entry.version),
    ["1.49.1", "1.49", "1.6.43", "1.3.2", "0.2.1", "0.2.0", "0.1.1", "0.1.0"],
  );
  // `...` (the "more versions exist" marker) must not become a version.
  assert.ok(versions.every((entry) => /^\d/.test(entry.version)));
  assert.equal(versions.find((entry) => entry.version === "1.3.2")?.summary, "A compression library");
  assert.equal(versions.find((entry) => entry.version === "0.1.0")?.summary, "gzip-hpp — header-only gzip/deflate compression wrappers over zlib");
});

test("accepts leading narration around the package list", () => {
  const withNarration = [
    "Refreshing package index ...",
    "",
    REAL_CAPTURE,
    "",
    "note: run mcpp search --all-versions for the full list",
  ].join("\n");
  assert.equal(parseSearchOutput(withNarration).length, parseSearchOutput(REAL_CAPTURE).length);
});

test("de-duplicates repeated versions across lines", () => {
  const output = [
    "  compat:zlib   A compression library  (1.3.2)",
    "  compat:zlib   A compression library  (1.3.2)",
    "  compat:zlib   A compression library  (1.2.9)",
  ].join("\n");
  assert.deepEqual(parseSearchOutput(output).map((entry) => entry.version), ["1.3.2", "1.2.9"]);
});

test("orders versions semver-ish, not lexically", () => {
  const output = [
    "  a:one   A library  (1.9.0)",
    "  a:one   A library  (1.10.0)",
    "  a:one   A library  (1.9)",
  ].join("\n");
  assert.deepEqual(parseSearchOutput(output).map((entry) => entry.version), ["1.10.0", "1.9.0", "1.9"]);
});

test("returns nothing for empty, whitespace-only and narration-only input", () => {
  assert.deepEqual(parseSearchOutput(""), []);
  assert.deepEqual(parseSearchOutput("   \n\n  "), []);
  const narration = [
    "Refreshing package index ...",
    "note: 0 packages matched",
    "warning: using the cached index",
    "  some:thing   looks like a package but has no version",
  ].join("\n");
  assert.deepEqual(parseSearchOutput(narration), []);
  // 括号里不是版本号也不行。
  assert.deepEqual(parseSearchOutput("  a:b   description (not a version)"), []);
});

test("tolerates carriage returns and terminal colours", () => {
  const output = "  compat:zlib   A compression library  (1.3.2)\r\n\u001b[32m  compat:zlib   A compression library  (1.2.9)\u001b[0m";
  assert.deepEqual(parseSearchOutput(output).map((entry) => entry.version), ["1.3.2", "1.2.9"]);
});

test("searchArguments asks for every version", () => {
  assert.deepEqual(searchArguments("zlib"), ["search", "zlib", "--all-versions"]);
  assert.deepEqual(searchArguments("compat.zlib"), ["search", "compat.zlib", "--all-versions"]);
});

test("shouldSearch is enabled && trusted && !offline", () => {
  for (const enabled of [true, false]) {
    for (const trusted of [true, false]) {
      for (const offline of [true, false]) {
        assert.equal(
          shouldSearch("zlib", { enabled, trusted, offline }),
          enabled && trusted && !offline,
          `enabled=${enabled} trusted=${trusted} offline=${offline}`,
        );
      }
    }
  }
  // 唯独"全开"才查询：这也是方案里默认关（enabled=false）的落点。
  assert.equal(shouldSearch("zlib", { enabled: true, trusted: true, offline: false }), true);
  assert.equal(shouldSearch("zlib", { enabled: true, trusted: false, offline: false }), false);
  assert.equal(shouldSearch("zlib", { enabled: true, trusted: true, offline: true }), false);
  assert.equal(shouldSearch("zlib", { enabled: false, trusted: true, offline: false }), false);
});

test("indexCompletionRequest carries the switches into argv and the timeout", () => {
  const on = { enabled: true, trusted: true, offline: false, timeoutSeconds: 5 };
  assert.deepEqual(indexCompletionRequest("zlib", on), {
    name: "zlib",
    args: ["search", "zlib", "--all-versions"],
    timeoutMs: 5000,
  });

  // The default is off, and every one of the three switches alone withholds the
  // request — no argv, no process.
  assert.equal(indexCompletionRequest("zlib", { ...on, enabled: false }), undefined);
  assert.equal(indexCompletionRequest("zlib", { ...on, trusted: false }), undefined);
  assert.equal(indexCompletionRequest("zlib", { ...on, offline: true }), undefined);

  // The registry's minimum is 1 second; a hand-edited non-number falls back to
  // the declared default of 20 seconds rather than to "no timeout".
  assert.equal(indexCompletionRequest("zlib", { ...on, timeoutSeconds: 0 })?.timeoutMs, 1000);
  assert.equal(indexCompletionRequest("zlib", { ...on, timeoutSeconds: -3 })?.timeoutMs, 1000);
  assert.equal(indexCompletionRequest("zlib", { ...on, timeoutSeconds: 20 })?.timeoutMs, 20_000);
  assert.equal(
    indexCompletionRequest("zlib", { ...on, timeoutSeconds: Number.NaN })?.timeoutMs,
    20_000,
  );
});

test("withDeadline returns the work's value and gives up when work never settles", async () => {
  assert.equal(await withDeadline(Promise.resolve("done"), 1000), "done");
  const neverSettles = new Promise<string>(() => undefined);
  assert.equal(await withDeadline(neverSettles, 20), undefined);
});
