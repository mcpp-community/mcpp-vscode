import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { parseMcppToml } from "./mcppTomlParser";

export interface McppProjectDiscovery {
  root: string;
  manifestPath: string;
  compilationDatabasePath: string;
}

export function manifestProjectRoot(manifestPath: string): string {
  return path.dirname(path.resolve(manifestPath));
}

export function shouldReconcileDeletedManifest(
  currentProjectRoot: string | undefined,
  manifestPath: string,
): boolean {
  return currentProjectRoot !== undefined
    && path.resolve(currentProjectRoot) === manifestProjectRoot(manifestPath);
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function isPathWithinProject(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

interface ManifestShape {
  hasPackage: boolean;
  hasWorkspace: boolean;
}

function readManifestShape(manifestPath: string): ManifestShape {
  try {
    const document = parseMcppToml(readFileSync(manifestPath, "utf8").split(/\r?\n/));
    let hasPackage = false;
    let hasWorkspace = false;
    let insideSection = false;
    for (const node of document.nodes) {
      if (node.type === "section") {
        insideSection = true;
        if (node.segments.length === 1) {
          hasPackage ||= node.segments[0].name === "package";
          hasWorkspace ||= node.segments[0].name === "workspace";
        }
        continue;
      }
      // mcpp 同样接受顶层 dotted key 和 inline table 写法。
      if (!insideSection) {
        hasPackage ||= node.keyPath[0]?.name === "package";
        hasWorkspace ||= node.keyPath[0]?.name === "workspace";
      }
    }
    return { hasPackage, hasWorkspace };
  } catch {
    // 无法读取时保留原发现结果，让 mcpp 自己给出清单诊断。
    return { hasPackage: false, hasWorkspace: false };
  }
}

export function projectAffectedByManifest(
  manifestPath: string,
  currentProject: McppProjectDiscovery | undefined,
  manifestProject: McppProjectDiscovery | undefined,
): McppProjectDiscovery | undefined {
  const manifestRoot = manifestProjectRoot(manifestPath);
  const shape = readManifestShape(manifestPath);
  if (
    shape.hasWorkspace
    && currentProject !== undefined
    && currentProject.root !== manifestRoot
    && isPathWithinProject(currentProject.root, manifestRoot)
  ) {
    // member 会继承 workspace 根配置，根清单变化必须刷新当前 member 的 CDB。
    return currentProject;
  }
  return manifestProject;
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
    // 新创建的 VS Code 工作区路径可能尚不存在，此时按目录处理。
  }

  if (boundary !== undefined && !isPathWithinProject(current, boundary)) {
    return undefined;
  }

  while (true) {
    const manifestPath = path.join(current, "mcpp.toml");
    if (existsSync(manifestPath)) {
      // #387 的 virtual workspace fan-out 只在各 member 根发布 CDB；
      // 虚拟根不是 clangd 可消费的单一 package 工程。
      const shape = readManifestShape(manifestPath);
      if (shape.hasWorkspace && !shape.hasPackage) {
        return undefined;
      }
      return {
        root: current,
        manifestPath,
        compilationDatabasePath: path.join(current, "compile_commands.json"),
      };
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
