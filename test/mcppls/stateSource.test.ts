import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The settings that shape the C++ Modules view, asserted on the source itself.
 *
 * `src/mcppls/stateSource.ts` has no seam a pure test could drive: the decision
 * it makes — read `extension.exports` or not — *is* the `vscode` boundary. So
 * this gate is checked where it is written. It is deliberately about structure,
 * not wording, so it keeps working when the sentence around the gate changes.
 */

const SOURCE = path.join(process.cwd(), "src", "mcppls", "stateSource.ts");

function source(): string {
  return readFileSync(SOURCE, "utf8");
}

/** The text without comments, so a doc comment cannot satisfy or break the scan. */
function code(): string {
  return source()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("mcpp.languageService.readState is read, and its gate precedes every use of extension.exports", () => {
  const text = code();
  const gate = text.indexOf('read<boolean>("mcpp.languageService.readState")');
  assert.ok(gate >= 0, "stateSource.ts must read mcpp.languageService.readState to switch the read off");

  const uses = [...text.matchAll(/\.exports\b/g)].map((match) => match.index ?? -1);
  assert.ok(uses.length > 0, "the file must still read extension.exports, or the gate proves nothing");
  for (const index of uses) {
    assert.ok(
      index > gate,
      "every use of extension.exports must come after the readState gate, or the setting cannot switch the read off",
    );
  }

  // The gate returns "not available" with a reason rather than falling through
  // to a partial read.
  const after = text.slice(gate, gate + 400);
  assert.match(after, /available:\s*false/);
  assert.match(after, /reason:/);
});

test("every failure path in stateSource.ts stays non-throwing", () => {
  const boundary = code().slice(code().indexOf("export function readLanguageServerState"));
  assert.ok(boundary.includes("try {"), "the exports read must stay inside try/catch");
  assert.ok(boundary.includes("catch"), "the exports read must have a catch that returns a reason");
  assert.ok(!/\bthrow\b/.test(boundary), "readLanguageServerState must never throw");
});
