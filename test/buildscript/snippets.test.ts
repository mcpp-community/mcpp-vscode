import assert from "node:assert/strict";
import test from "node:test";

import { ACTION_ROLES, API } from "../../src/buildscript/api";
import {
  actionSnippets,
  buildScriptSnippets,
  directiveCallSnippets,
  snippetsForScope,
} from "../../src/buildscript/snippets";

test("every snapshot directive but action has exactly one call snippet", () => {
  const expected = new Set(
    API.directives.map((entry) => entry.wire.replace(/-/g, "_")).filter((name) => name !== "action"),
  );
  const snippets = directiveCallSnippets();
  assert.equal(snippets.length, expected.size);
  assert.deepEqual(
    [...new Set(snippets.map((snippet) => snippet.filterText))].sort(),
    [...expected].sort(),
  );
  // A declaration is not a call: `mcpp::action` must not get an `action(...)` stub.
  assert.ok(!snippets.some((snippet) => snippet.filterText === "action"));
});

test("a directive snippet is the typed spelling with one editable argument", () => {
  const snippet = directiveCallSnippets().find((entry) => entry.filterText === "link_script");
  assert.ok(snippet !== undefined, "link_script disappeared from the snippet list");
  assert.equal(snippet.label, "link_script(...)");
  assert.equal(snippet.insertText, 'link_script("${1:value}")');
  assert.match(snippet.detail, /mcpp:link-script=/);
});

test("the action snippets carry a role, and the prepare one carries output_dir", () => {
  const snippets = actionSnippets();
  assert.equal(snippets.length, 2);
  for (const snippet of snippets) {
    assert.equal(snippet.filterText, "action");
    assert.match(snippet.insertText, /\.submit\(\);/);
    assert.match(snippet.insertText, /mcpp::roles::/);
  }
  const prepare = snippets.find((snippet) => snippet.label.includes("prepare"));
  assert.ok(prepare !== undefined);
  assert.match(prepare.insertText, /mcpp::roles::prepare/);
  assert.match(prepare.insertText, /\.output_dir\("/);
  assert.match(prepare.detail, /R3\.3/);

  const general = snippets.find((snippet) => snippet.label.includes("typed"));
  assert.ok(general !== undefined);
  // The role choice lists the engine's five roles.
  for (const role of ACTION_ROLES) {
    assert.ok(general.insertText.includes(role), `${role} is missing from the role choice`);
  }
});

test("snippetsForScope narrows on the typed mcpp:: prefix", () => {
  const all = buildScriptSnippets();
  assert.equal(snippetsForScope("").length, all.length);
  const link = snippetsForScope("link_");
  assert.ok(link.length > 0);
  assert.ok(link.every((snippet) => snippet.filterText.startsWith("link_")));
  assert.ok(!link.some((snippet) => snippet.filterText === "action"));
  assert.equal(snippetsForScope("action").length, actionSnippets().length);
  assert.deepEqual(snippetsForScope("zzz_not_a_directive"), []);
});

test("every snippet is insertable: it has a placeholder and a non-empty body", () => {
  for (const snippet of buildScriptSnippets()) {
    assert.ok(snippet.insertText.length > 0, `${snippet.label} has no insert text`);
    assert.match(snippet.insertText, /\$\{1[:|]/, `${snippet.label} has no first placeholder`);
    assert.ok(snippet.label.length > 0);
    assert.ok(snippet.detail.length > 0);
  }
});
