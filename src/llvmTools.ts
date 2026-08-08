import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import type { ToolIdentity } from "./analysis";
import {
  runProcess,
  type ProcessResult,
  type ProcessRunner,
} from "./process";

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

export interface FindXlingsOptions {
  /** Override for tests: base home directory instead of os.homedir(). */
  home?: string;
  /** Override for tests: environment instead of process.env. */
  env?: NodeJS.ProcessEnv;
}

export function findXlingsExecutable(options?: FindXlingsOptions): string | undefined {
  const home = options?.home ?? os.homedir();
  const env = options?.env ?? process.env;
  const knownPaths = [
    path.join(home, ".xlings", "subos", "current", "bin", "xlings"),
    path.join(home, ".xlings", "bin", "xlings"),
  ];
  if (process.platform === "win32") {
    knownPaths.push(
      path.join(home, ".xlings", "subos", "current", "bin", "xlings.exe"),
    );
  }

  // mcpp (install.sh / AUR / mcpp-m) bundles xlings inside its own registry
  // sandbox instead of installing to ~/.xlings. The AUR launcher pins the
  // path via MCPP_VENDORED_XLINGS; otherwise it lives at
  // $MCPP_HOME/registry/bin/xlings. Without probing both, the one-click
  // module setup can never auto-install llvm-tools after a standard install.
  const vendored = env.MCPP_VENDORED_XLINGS?.trim();
  if (vendored !== undefined && vendored.length > 0) {
    knownPaths.push(vendored);
  }
  const mcppHome = env.MCPP_HOME?.trim();
  const extension = process.platform === "win32" ? ".exe" : "";
  knownPaths.push(
    path.join(
      mcppHome !== undefined && mcppHome.length > 0 ? mcppHome : path.join(home, ".mcpp"),
      "registry",
      "bin",
      `xlings${extension}`,
    ),
  );

  // Check known install paths first
  for (const candidate of knownPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to PATH, but only when "xlings" actually resolves there. Always
  // returning "xlings" hid the not-installed case, so callers could never show
  // the "xlings 未安装" guidance.
  return xlingsResolvableOnPath(env.PATH) ? "xlings" : undefined;
}

function xlingsResolvableOnPath(pathValue?: string): boolean {
  const names = process.platform === "win32"
    ? ["xlings.exe", "xlings.cmd", "xlings.bat"]
    : ["xlings"];
  const pathEnv = pathValue ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
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

const XLINGS_BINARY_LINE = /^\s*xlings binary\s*=\s*(.+?)\s*$/im;

// Source of truth is mcpp itself, not the filesystem or PATH: `mcpp self env`
// reports the exact xlings bundled with THIS mcpp (mcpp is a project-level
// environment; it owns its tool paths). Works for install.sh, AUR and any
// custom MCPP_PREFIX layout. Falls back to the historical path heuristics for
// standalone ~/.xlings installs and for mcpp versions without the line.
export async function resolveXlingsExecutable(
  mcppExecutable: string,
  runner: ProcessRunner = runProcess,
): Promise<string | undefined> {
  const result = await runner(mcppExecutable, ["self", "env"]);
  const match = `${result.stdout}\n${result.stderr}`.match(XLINGS_BINARY_LINE);
  const reported = match?.[1]?.trim();
  if (reported !== undefined && reported.length > 0 && existsSync(reported)) {
    return reported;
  }
  return findXlingsExecutable();
}

export async function runXlingsCommand(
  xlingsPath: string,
  args: string[],
  cwd?: string,
): Promise<ProcessResult> {
  return runProcess(xlingsPath, args, cwd);
}
