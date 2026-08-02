import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type { ToolIdentity } from "./analysis";
import { runProcess, type ProcessResult } from "./process";

export function llvmToolsVersionSpec(identity: ToolIdentity): string {
  return `${identity.major}.${identity.minor}.${identity.patch}`;
}

const COMPILER_PATH_VERSION_REGEX = /[\\/]xim-x-llvm[\\/](\d+(?:\.\d+){1,3})[\\/]bin[\\/]clang(?:\+\+|-cl)?(?:\.exe)?$/i;

export function extractVersionFromCompilerPath(compilerPath: string): string | undefined {
  const match = compilerPath.match(COMPILER_PATH_VERSION_REGEX);
  return match?.[1];
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");
}

export function deriveInstalledClangdPath(
  compilerPath: string,
  version: string,
): string[] {
  const windows = isWindowsPath(compilerPath);
  const pathApi = windows ? path.win32 : path.posix;
  const candidateMatch = compilerPath.match(
    /^(.*?[\\/])xim-x-llvm[\\/]\d+(?:\.\d+){1,3}[\\/]bin[\\/]clang(?:\+\+|-cl)?(?:\.exe)?$/i,
  );
  const basePath = candidateMatch?.[1];
  const extension = /\.exe$/i.test(compilerPath) ? ".exe" : "";

  const candidates: string[] = [];
  if (basePath !== undefined) {
    candidates.push(
      pathApi.join(basePath, "xim-x-llvm-tools", version, "bin", `clangd${extension}`),
    );
  }

  // Also try user xlings registry path if compiler is in mcpp registry
  const userMatch = compilerPath.match(
    /^(.*?)([\\/])\.mcpp[\\/]registry[\\/]data[\\/]xpkgs[\\/]xim-x-llvm[\\/]\d+(?:\.\d+){1,3}[\\/]bin[\\/]clang(?:\+\+|-cl)?(?:\.exe)?$/i,
  );
  if (userMatch !== null) {
    candidates.push(
      `${userMatch[1]}${userMatch[2]}.xlings${userMatch[2]}data${userMatch[2]}xpkgs${userMatch[2]}xim-x-llvm-tools${userMatch[2]}${version}${userMatch[2]}bin${userMatch[2]}clangd${extension}`,
    );
  }

  return candidates;
}

export function xlingsInstallArgs(version?: string): string[] {
  if (version !== undefined) {
    return ["install", `xim:llvm-tools@${version}`];
  }
  return ["update", "llvm-tools"];
}

export function findXlingsExecutable(): string | undefined {
  const home = os.homedir();
  const knownPaths = [
    path.join(home, ".xlings", "subos", "current", "bin", "xlings"),
    path.join(home, ".xlings", "bin", "xlings"),
  ];
  if (process.platform === "win32") {
    knownPaths.push(
      path.join(home, ".xlings", "subos", "current", "bin", "xlings.exe"),
    );
  }

  // Check known install paths first
  for (const candidate of knownPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to PATH, but only when "xlings" actually resolves there. Always
  // returning "xlings" hid the not-installed case, so callers could never show
  // the "xlings 未安装" guidance.
  return xlingsResolvableOnPath() ? "xlings" : undefined;
}

function xlingsResolvableOnPath(): boolean {
  const names = process.platform === "win32"
    ? ["xlings.exe", "xlings.cmd", "xlings.bat"]
    : ["xlings"];
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const name of names) {
      if (existsSync(path.join(dir, name))) {
        return true;
      }
    }
  }
  return false;
}

export async function runXlingsCommand(
  xlingsPath: string,
  args: string[],
  cwd?: string,
): Promise<ProcessResult> {
  return runProcess(xlingsPath, args, cwd);
}
