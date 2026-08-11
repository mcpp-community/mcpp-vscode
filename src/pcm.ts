import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { CompilationDatabaseAnalysis } from "./analysis";

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function stageAvailableProjectPcms(analysis: CompilationDatabaseAnalysis): number {
  const sources = analysis.modulePcmSourceDirectories ?? [];
  const destinations = analysis.modulePcmConsumerDirectories ?? [];
  let copied = 0;

  for (const sourceDirectory of sources) {
    if (!existsSync(sourceDirectory)) {
      continue;
    }
    const pcms = readdirSync(sourceDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pcm"));
    for (const destinationDirectory of destinations) {
      if (sameDirectory(sourceDirectory, destinationDirectory) || pcms.length === 0) {
        continue;
      }
      mkdirSync(destinationDirectory, { recursive: true });
      for (const pcm of pcms) {
        const source = path.join(sourceDirectory, pcm.name);
        const destination = path.join(destinationDirectory, pcm.name);
        if (existsSync(destination) && statSync(source).mtimeMs <= statSync(destination).mtimeMs) {
          continue;
        }
        copyFileSync(source, destination);
        copied += 1;
      }
    }
  }

  return copied;
}
