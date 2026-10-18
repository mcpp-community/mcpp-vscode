import { watchFile, unwatchFile, type Stats } from "node:fs";
import path from "node:path";

/** Two small stat polls keep project state fresh even when the host exhausts inotify watchers. */
export function watchProjectFiles(root: string, changed: () => void, interval = 1000): { dispose(): void } {
  const files = ["mcpp.toml", "mcpp.lock"].map((name) => path.join(root, name));
  const listener = (current: Stats, previous: Stats): void => {
    if (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs || current.size !== previous.size || current.nlink !== previous.nlink) {
      changed();
    }
  };
  for (const file of files) { watchFile(file, { persistent: false, interval }, listener); }
  return { dispose: () => { for (const file of files) { unwatchFile(file, listener); } } };
}
