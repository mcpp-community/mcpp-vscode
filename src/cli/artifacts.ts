/**
 * Size estimate for a project's `target/` directory (plan §3.4.1).
 *
 * mcpp states that the contents of `target/` are **not an interface**, so this is
 * an estimate for the cache view only: it never parses mcpp's fingerprints and
 * never guesses which artifacts are stale. The authoritative "what would be
 * removed" answer is `mcpp clean --dry-run`.
 *
 * Pure `node:fs`, never throws, and bounded: a hostile or huge `target/` cannot
 * hang the extension host. Symlinks are counted as zero-byte entries and are
 * never followed (a link back to an ancestor would otherwise loop forever).
 */

import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

import { formatBytes } from "../util/format";

export interface ArtifactGroup {
  name: string;
  bytes: number;
  files: number;
}

export interface ArtifactEstimate {
  /** Absolute path of `target/`, whether or not it exists. */
  path: string;
  exists: boolean;
  totalBytes: number;
  files: number;
  /** One entry per directory directly under `<root>/target`. */
  byTopLevel: ArtifactGroup[];
  /** Set when the walk stopped early; the numbers are then a floor. */
  truncated?: "entries" | "depth";
}

const DEFAULT_MAX_ENTRIES = 200_000;
const DEFAULT_MAX_DEPTH = 6;

function budget(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

/**
 * Walk `<projectRoot>/target` with a bounded budget. Never throws.
 *
 * Returns `exists: false` with zeros when `target/` is missing, is not a
 * directory, or is itself a symlink.
 */
export function estimateArtifacts(
  projectRoot: string,
  options: { maxEntries?: number; maxDepth?: number } = {},
): ArtifactEstimate {
  return measureDirectory(path.join(projectRoot, "target"), options);
}

/**
 * The same bounded walk, for a directory that is already known by path.
 *
 * The cache view needs it for the pre-v1 cache path `mcpp cache dir` reports
 * (plan §3.4 / §8 G6): that directory lives outside the workspace, so it cannot
 * be reached through {@link estimateArtifacts}. The same rules apply — bounded,
 * never followed through symlinks, and it reports a floor instead of throwing
 * when the walk stops early.
 */
export function measureDirectory(
  root: string,
  options: { maxEntries?: number; maxDepth?: number } = {},
): ArtifactEstimate {
  const maxEntries = budget(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxDepth = budget(options.maxDepth, DEFAULT_MAX_DEPTH);

  const missing: ArtifactEstimate = {
    path: root,
    exists: false,
    totalBytes: 0,
    files: 0,
    byTopLevel: [],
  };
  let targetStat;
  try {
    targetStat = lstatSync(root);
  } catch {
    return missing;
  }
  // A symlinked `target/` is not followed either, so it reports as absent.
  if (!targetStat.isDirectory()) {
    return missing;
  }

  const byTopLevel: ArtifactGroup[] = [];
  let totalBytes = 0;
  let files = 0;
  let visited = 0;
  let truncated: "entries" | "depth" | undefined;

  const add = (group: ArtifactGroup | undefined, bytes: number, count: number): void => {
    totalBytes += bytes;
    files += count;
    if (group !== undefined) {
      group.bytes += bytes;
      group.files += count;
    }
  };

  const hasEntries = (directory: string): boolean => {
    try {
      return readdirSync(directory, { withFileTypes: true }).length > 0;
    } catch {
      return false;
    }
  };

  const walk = (directory: string, depth: number, group: ArtifactGroup | undefined): void => {
    if (truncated === "entries") {
      return;
    }
    if (depth > maxDepth) {
      // Only report depth truncation when something was actually left behind.
      if (hasEntries(directory)) {
        truncated = truncated ?? "depth";
      }
      return;
    }
    let dirents;
    try {
      dirents = readdirSync(directory, { withFileTypes: true });
    } catch {
      // Unreadable directory: tolerate it, the estimate is a floor anyway.
      return;
    }
    for (const dirent of dirents) {
      if (visited >= maxEntries) {
        truncated = "entries";
        return;
      }
      visited += 1;

      const full = path.join(directory, dirent.name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        // Raced with a concurrent `mcpp clean`, or a permission error: skip it.
        continue;
      }
      if (stat.isSymbolicLink()) {
        // Never followed; counted as an entry of zero bytes.
        add(group, 0, 1);
        continue;
      }
      if (stat.isDirectory()) {
        let child = group;
        if (depth === 0) {
          child = { name: dirent.name, bytes: 0, files: 0 };
          byTopLevel.push(child);
        }
        walk(full, depth + 1, child);
        continue;
      }
      // Regular files carry a size; fifos/sockets/devices are counted at 0.
      add(group, stat.isFile() ? stat.size : 0, 1);
    }
  };

  walk(root, 0, undefined);

  byTopLevel.sort(
    (left, right) =>
      right.bytes - left.bytes || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );

  const estimate: ArtifactEstimate = {
    path: root,
    exists: true,
    totalBytes,
    files,
    byTopLevel,
  };
  if (truncated !== undefined) {
    estimate.truncated = truncated;
  }
  return estimate;
}

/** One human line for the cache view / status bar, e.g. `"1.43 GiB in 3 groups"`. */
export function formatArtifactEstimate(estimate: ArtifactEstimate): string {
  if (!estimate.exists) {
    return "no target/ directory";
  }
  const groups = estimate.byTopLevel.length;
  const base = `${formatBytes(estimate.totalBytes)} in ${groups} group${groups === 1 ? "" : "s"}`;
  return estimate.truncated === undefined ? base : `${base} (truncated: ${estimate.truncated})`;
}
