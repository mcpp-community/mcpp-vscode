import assert from "node:assert/strict";
import test from "node:test";

import { clampOutput, escapeHtml, firstLine, formatArguments, splitList, stripAnsi } from "../../src/util/text";

test("stripAnsi removes colour codes", () => {
  assert.equal(stripAnsi("\u001b[32mok\u001b[0m"), "ok");
  assert.equal(stripAnsi("plain"), "plain");
});

test("clampOutput keeps the tail, because that is where the answer is", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`);
  const clamped = clampOutput(lines.join("\n"), { maxLines: 3 });
  assert.equal(clamped.truncated, true);
  assert.equal(clamped.droppedLines, 7);
  assert.equal(clamped.text, "line 7\nline 8\nline 9");
});

test("clampOutput leaves a short output untouched", () => {
  const clamped = clampOutput("only\nlines", { maxLines: 10, maxChars: 1000 });
  assert.equal(clamped.truncated, false);
  assert.equal(clamped.droppedLines, 0);
  assert.equal(clamped.text, "only\nlines");
});

test("clampOutput also bounds characters", () => {
  const clamped = clampOutput("abcdefghij", { maxLines: 100, maxChars: 4 });
  assert.equal(clamped.truncated, true);
  assert.equal(clamped.text, "ghij");
});

test("clampOutput normalises CRLF and strips ANSI before measuring", () => {
  const clamped = clampOutput("a\r\n\u001b[31mb\u001b[0m", { maxLines: 2, maxChars: 100 });
  assert.equal(clamped.text, "a\nb");
});

test("firstLine trims and stops at the newline", () => {
  assert.equal(firstLine("  hello  \nworld"), "hello");
  assert.equal(firstLine("only"), "only");
});

test("escapeHtml neutralises markup", () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("splitList trims, drops blanks and tolerates undefined", () => {
  assert.deepEqual(splitList("mcpp, cmake ,,xmake"), ["mcpp", "cmake", "xmake"]);
  assert.deepEqual(splitList(undefined), []);
  assert.deepEqual(splitList(""), []);
});

test("formatArguments quotes entries containing whitespace", () => {
  assert.equal(formatArguments(["-j", "4"]), "-j 4");
  assert.equal(formatArguments(["--flag=a b"]), '"--flag=a b"');
  assert.equal(formatArguments([]), "");
});
