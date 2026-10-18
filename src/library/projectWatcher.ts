import { promises as fs } from "node:fs";
import path from "node:path";

/** Two stat checks keep project state fresh even when the host exhausts native watchers.
 * Native events also call check(), so a file observed between polling ticks cannot
 * disappear unnoticed before the next tick (particularly a newly-created lockfile).
 */
export function watchProjectFiles(root: string, changed: () => void, interval = 1000): { dispose(): void; check(): Promise<void> } {
  const files = ["mcpp.toml", "mcpp.lock"].map((name) => path.join(root, name));
  let previous: string | undefined;
  let disposed = false;
  let checking: Promise<void> | undefined;
  let again = false;
  const check = (): Promise<void> => {
    if (disposed) { return Promise.resolve(); }
    if (checking) { again = true; return checking; }
    checking = (async () => {
      do {
        again = false;
        const fingerprints = await Promise.all(files.map(async (file) => {
          const stat = await fs.stat(file).catch(() => undefined);
          return stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}` : "missing";
        }));
        if (disposed) { return; }
        const next = fingerprints.join("|");
        const different = previous !== undefined && next !== previous;
        previous = next;
        if (different) { changed(); }
      } while (again && !disposed);
    })().finally(() => { checking = undefined; });
    return checking;
  };
  const timer = setInterval(() => { void check(); }, interval);
  void check();
  return { check, dispose: () => { disposed = true; clearInterval(timer); } };
}
