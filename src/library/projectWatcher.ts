import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Compare the two small project files, including states observed by a rendered detail.
 * Native events may be unavailable and a file can appear/disappear between ticks.
 */
export function watchProjectFiles(root: string, changed: () => void, interval = 1000): { dispose(): void; check(): Promise<void>; observe(manifest: string, lock: string): void } {
  const files = ["mcpp.toml", "mcpp.lock"].map((name) => path.join(root, name));
  let previous: string | undefined;
  let disposed = false;
  let checking: Promise<void> | undefined;
  let again = false;
  const fingerprint = (texts: readonly string[]) => createHash("sha256").update(JSON.stringify(texts)).digest("hex");
  const check = (): Promise<void> => {
    if (disposed) { return Promise.resolve(); }
    if (checking) { again = true; return checking; }
    checking = (async () => {
      do {
        again = false;
        const texts = await Promise.all(files.map((file) => fs.readFile(file, "utf8").catch(() => "")));
        if (disposed) { return; }
        const next = fingerprint(texts);
        const different = previous !== undefined && next !== previous;
        previous = next;
        if (different) { changed(); }
      } while (again && !disposed);
    })().finally(() => { checking = undefined; });
    return checking;
  };
  const timer = setInterval(() => { void check(); }, interval);
  void check();
  return { check, observe: (manifest, lock) => { if (!disposed) { previous = fingerprint([manifest, lock]); } }, dispose: () => { disposed = true; clearInterval(timer); } };
}
