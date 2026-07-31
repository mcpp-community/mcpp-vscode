import {
  existsSync,
  statSync,
} from "node:fs";
import path from "node:path";

export interface McppProjectDiscovery {
  root: string;
  manifestPath: string;
  compilationDatabasePath: string;
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function findNearestMcppProject(startPath: string): McppProjectDiscovery | undefined {
  let current = path.resolve(startPath);

  try {
    if (statSync(current).isFile()) {
      current = path.dirname(current);
    }
  } catch {
    // 新创建的 VS Code 工作区路径可能尚不存在，此时按目录处理。
  }

  while (true) {
    const manifestPath = path.join(current, "mcpp.toml");
    if (existsSync(manifestPath)) {
      return {
        root: current,
        manifestPath,
        compilationDatabasePath: path.join(current, "compile_commands.json"),
      };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function deriveClangdCandidates(compilerPath: string): string[] {
  const windows = isWindowsPath(compilerPath);
  const pathApi = windows ? path.win32 : path.posix;
  const compilerName = pathApi.basename(compilerPath);
  const extension = /\.exe$/i.test(compilerName) ? ".exe" : "";
  const sibling = pathApi.join(pathApi.dirname(compilerPath), `clangd${extension}`);
  const xlingsMatch = compilerPath.match(
    /^(.*?)([\\/])xim-x-llvm[\\/](\d+(?:\.\d+){1,3})[\\/]bin[\\/]clang(?:\+\+|-cl)(\.exe)?$/i,
  );

  const xlingsCandidate = xlingsMatch === null
    ? undefined
    : `${xlingsMatch[1]}${xlingsMatch[2]}xim-x-llvm-tools${xlingsMatch[2]}${xlingsMatch[3]}${xlingsMatch[2]}bin${xlingsMatch[2]}clangd${xlingsMatch[4] ?? ""}`;
  const userXlingsMatch = compilerPath.match(
    /^(.*?)([\\/])\.mcpp[\\/]registry[\\/]data[\\/]xpkgs[\\/]xim-x-llvm[\\/](\d+(?:\.\d+){1,3})[\\/]bin[\\/]clang(?:\+\+|-cl)(\.exe)?$/i,
  );
  const userXlingsCandidate = userXlingsMatch === null
    ? undefined
    : `${userXlingsMatch[1]}${userXlingsMatch[2]}.xlings${userXlingsMatch[2]}data${userXlingsMatch[2]}xpkgs${userXlingsMatch[2]}xim-x-llvm-tools${userXlingsMatch[2]}${userXlingsMatch[3]}${userXlingsMatch[2]}bin${userXlingsMatch[2]}clangd${userXlingsMatch[4] ?? ""}`;

  return unique([
    sibling,
    ...(xlingsCandidate === undefined ? [] : [xlingsCandidate]),
    ...(userXlingsCandidate === undefined ? [] : [userXlingsCandidate]),
    "clangd",
  ]);
}
