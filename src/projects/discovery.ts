import { existsSync, statSync } from "node:fs";
import path from "node:path";

export interface McppProjectDiscovery {
  root: string;
  manifestPath: string;
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function findNearestMcppProject(
  startPath: string,
  workspaceRoot?: string,
): McppProjectDiscovery | undefined {
  let current = path.resolve(startPath);
  const boundary = workspaceRoot === undefined ? undefined : path.resolve(workspaceRoot);

  try {
    if (statSync(current).isFile()) {
      current = path.dirname(current);
    }
  } catch {
    // A newly-created workspace path may not exist yet; treat it as a directory.
  }

  if (boundary !== undefined && !isPathWithin(current, boundary)) {
    return undefined;
  }

  while (true) {
    const manifestPath = path.join(current, "mcpp.toml");
    if (existsSync(manifestPath)) {
      return { root: current, manifestPath };
    }
    if (boundary !== undefined && current === boundary) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
