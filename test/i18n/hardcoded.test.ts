import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * No untranslated user-visible string may live in `src/`.
 *
 * The English text is the key for every runtime string (`src/i18n/t.ts`), so a
 * hard-coded sentence is invisible to `tools/l10n-check.mjs` **and** ignores
 * `mcpp.ui.language`: it shows Chinese on an English UI. The ceiling that used to
 * freeze the count at 162 is now **zero** — the scan is a gate, not a ratchet.
 */

const SCANNED_DIRECTORIES = ["src"];

export function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, found);
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/** Lines carrying a CJK character outside a comment. */
export function hardcodedChineseLines(root = process.cwd()): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const dir of SCANNED_DIRECTORIES) {
    for (const file of sourceFiles(path.join(root, dir))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, index) => {
        const trimmed = text.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          return;
        }
        if (/[\u4e00-\u9fff]/.test(text)) {
          hits.push({ file: path.relative(root, file), line: index + 1, text: trimmed });
        }
      });
    }
  }
  return hits;
}

test("src/ carries no untranslated user-visible string", () => {
  const hits = hardcodedChineseLines();
  assert.equal(
    hits.length,
    0,
    `found ${hits.length} hard-coded Chinese line(s); route them through t(): ` +
      hits.slice(0, 5).map((hit) => `${hit.file}:${hit.line}`).join(", "),
  );
});

test("the scan still inspects every source file", () => {
  // The zero above is only meaningful while the scan keeps looking at the same
  // tree: a walk that stopped early would report success for the wrong reason.
  const files = sourceFiles(path.join(process.cwd(), "src"));
  assert.ok(files.length >= 50, `the scan inspected only ${files.length} file(s)`);
  assert.ok(files.every((file) => file.endsWith(".ts")), "the scan picked up a non-source file");
  for (const expected of [
    path.join("src", "cli", "controller.ts"),
    path.join("src", "extension.ts"),
    path.join("src", "toml", "completion.ts"),
    path.join("src", "views", "languageServerView.ts"),
  ]) {
    assert.ok(files.includes(path.join(process.cwd(), expected)), `the scan skipped ${expected}`);
  }
});

test("the scan still finds the strings it is meant to watch", () => {
  // Plant the two shapes the scan must tell apart in a throw-away tree: a
  // hard-coded CJK literal (a hit) and a Chinese comment (not a hit).
  const root = mkdtempSync(path.join(tmpdir(), "mcpp-i18n-scan-"));
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "planted.ts"),
      [
        `const translated = t("Plant me");`,
        `// 这行只是注释，不是用户可见字符串`,
        `const hardcoded = "种下我";`,
        "",
      ].join("\n"),
    );
    const hits = hardcodedChineseLines(root);
    assert.equal(hits.length, 1, "the scan must still flag a hard-coded CJK literal");
    assert.equal(hits[0].file, path.join("src", "planted.ts"));
    assert.match(hits[0].text, /种下我/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
