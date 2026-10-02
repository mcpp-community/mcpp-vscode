import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * A ceiling on untranslated user-visible strings.
 *
 * The English text is the key for every runtime string (`src/i18n/t.ts`), so a
 * hard-coded sentence is invisible to `tools/l10n-check.mjs` **and** ignores
 * `mcpp.ui.language`. Converting them all is mechanical work; letting new ones
 * appear is not acceptable, so this test freezes the current number and fails if
 * it grows. Lowering the number is the point.
 */

/**
 * Counted on 2026-10-02 for the 0.5.0 branch: **162** lines in `src/` still carry a
 * Chinese literal, concentrated in `src/cli/controller.ts` and `src/extension.ts`.
 * Every one of them is a gap recorded as §8 G11 in
 * `.agents/docs/2026-10-02-implementation-plan.md`; the number only goes down.
 */
const CEILING = 162;

const SCANNED_DIRECTORIES = ["src"];

function sourceFiles(dir: string, found: string[] = []): string[] {
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

test("the number of untranslated user-visible strings never grows", () => {
  const hits = hardcodedChineseLines();
  assert.ok(
    hits.length <= CEILING,
    `hard-coded Chinese grew from ${CEILING} to ${hits.length} lines; route new strings through t(). ` +
      `Worst offenders: ${hits.slice(0, 5).map((hit) => `${hit.file}:${hit.line}`).join(", ")}`,
  );
});

test("the scan actually finds the strings it is meant to watch", () => {
  // A scan that silently stops matching would make the ceiling meaningless.
  assert.ok(hardcodedChineseLines().length > 100, "the scan found almost nothing, so it is broken");
});
