import { existsSync, statSync } from "node:fs";
import path from "node:path";

export interface McppProjectDiscovery {
  root: string;
  manifestPath: string;
}

/**
 * How far the upward walk may go. `workspaceFolder` is the shipped behaviour;
 * `filesystem` also reaches a project outside the opened folder
 * (`mcpp.project.discoveryBoundary`). The walk itself never reads a setting —
 * the `vscode` layer resolves the boundary and passes it in, which keeps this
 * module pure and testable.
 */
export type DiscoveryBoundary = "workspaceFolder" | "filesystem";

/** `mcpp.project.discoveryBoundary`; anything unknown is the safe default. */
export function discoveryBoundaryOf(value: unknown): DiscoveryBoundary {
  return value === "filesystem" ? "filesystem" : "workspaceFolder";
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
  boundary: DiscoveryBoundary = "workspaceFolder",
): McppProjectDiscovery | undefined {
  let current = path.resolve(startPath);
  // `filesystem` drops the boundary entirely and keeps walking to the root.
  const stop = boundary === "filesystem" || workspaceRoot === undefined
    ? undefined
    : path.resolve(workspaceRoot);

  try {
    if (statSync(current).isFile()) {
      current = path.dirname(current);
    }
  } catch {
    // A newly-created workspace path may not exist yet; treat it as a directory.
  }

  if (stop !== undefined && !isPathWithin(current, stop)) {
    return undefined;
  }

  while (true) {
    const manifestPath = path.join(current, "mcpp.toml");
    if (existsSync(manifestPath)) {
      return { root: current, manifestPath };
    }
    if (stop !== undefined && current === stop) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
