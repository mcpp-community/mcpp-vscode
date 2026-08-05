import path from "node:path";

export type CompilerKind = "llvm" | "gcc" | "msvc" | "unknown";
export type ModuleCapability = "full" | "syntax-only" | "unavailable";
export type ModulesSupportMode = "auto" | "on" | "off";
export type CheckResult =
  | "ready"
  | "pcm-mismatch"
  | "module-unavailable"
  | "wrong-language-mode"
  | "check-failed";

export interface CompilationDatabaseAnalysis {
  kind: CompilerKind;
  capability: ModuleCapability;
  compilerPath?: string;
  sourceFile?: string;
  directory?: string;
  arguments?: string[];
  hasPrebuiltModules?: boolean;
  reason: string;
}

export interface ToolIdentity {
  major: number;
  minor: number;
  patch: number;
  revision?: string;
}

export interface ToolIdentityComparison {
  compatible: boolean;
  reason: string;
}

export interface ClangdArgumentOptions {
  compilerPath: string;
  compilationArguments?: readonly string[];
  modulesSupport: ModulesSupportMode;
  clangdIdentity?: ToolIdentity;
  platform: NodeJS.Platform;
  hasPrebuiltModules?: boolean;
  workspaceFolder?: string;
}

export interface ClangdConfigurationPlan {
  path: string;
  arguments: string[];
  changed: boolean;
}

interface CompilationCommand {
  directory?: unknown;
  file?: unknown;
  arguments?: unknown;
  command?: unknown;
}

function unavailable(reason: string): CompilationDatabaseAnalysis {
  return {
    kind: "unknown",
    capability: "unavailable",
    reason,
  };
}

function splitCommand(command: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote !== "'" && character === "\\" && index + 1 < command.length) {
      const next = command[index + 1];
      if (next === "\\" || next === "'" || next === '"' || /\s/.test(next)) {
        token += next;
        index += 1;
        continue;
      }
      token += character;
      continue;
    }

    if (character === "'" || character === '"') {
      if (quote === character) {
        quote = undefined;
      } else if (quote === undefined) {
        quote = character;
      } else {
        token += character;
      }
      continue;
    }

    if (/\s/.test(character) && quote === undefined) {
      if (token.length > 0) {
        result.push(token);
        token = "";
      }
      continue;
    }

    token += character;
  }

  if (token.length > 0) {
    result.push(token);
  }

  return result;
}

function commandArguments(command: CompilationCommand): string[] | undefined {
  if (
    Array.isArray(command.arguments)
    && command.arguments.length > 0
    && command.arguments.every((argument) => typeof argument === "string")
  ) {
    return command.arguments;
  }

  if (typeof command.command === "string") {
    const argumentsFromCommand = splitCommand(command.command);
    return argumentsFromCommand.length > 0 ? argumentsFromCommand : undefined;
  }

  return undefined;
}

function compilerKind(compilerPath: string): CompilerKind {
  const executable = path.win32.basename(compilerPath).toLowerCase();
  const name = executable.endsWith(".exe") ? executable.slice(0, -4) : executable;

  if (name === "clang" || name === "clang++" || name === "clang-cl") {
    return "llvm";
  }
  if (name === "gcc" || name === "g++" || name === "c++") {
    return "gcc";
  }
  if (name === "cl") {
    return "msvc";
  }
  return "unknown";
}

export function analyzeCompilationDatabase(contents: string): CompilationDatabaseAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return unavailable("compile_commands.json 不是有效的 JSON");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return unavailable("compile_commands.json 至少需要包含一条编译命令");
  }

  const candidates: CompilationDatabaseAnalysis[] = [];

  for (const value of parsed) {
    if (value === null || typeof value !== "object") {
      continue;
    }

    const command = value as CompilationCommand;
    const args = commandArguments(command);
    if (args === undefined) {
      continue;
    }

    const kind = compilerKind(args[0]);
    if (kind === "unknown") {
      continue;
    }

    const hasPrebuiltModules = args.some((argument) => (
      argument.startsWith("-fmodule-file=")
      || argument.startsWith("-fprebuilt-module-path=")
    ));
    candidates.push({
      kind,
      capability: kind === "llvm" ? "full" : "syntax-only",
      compilerPath: args[0],
      sourceFile: typeof command.file === "string" ? command.file : undefined,
      directory: typeof command.directory === "string" ? command.directory : undefined,
      arguments: args,
      hasPrebuiltModules,
      reason: kind === "llvm"
        ? "Clang 编译命令可以由 clangd 使用"
        : `${kind.toUpperCase()} 模块产物不能由 clangd 使用`,
    });
  }

  if (candidates.length === 0) {
    return unavailable("compile_commands.json 不包含受支持的编译器命令");
  }

  const score = (candidate: CompilationDatabaseAnalysis): number => {
    const sourceFile = candidate.sourceFile ?? "";
    const moduleInterface = /\.(?:cppm|ixx|mpp|ccm)$/i.test(sourceFile);
    const inProject = candidate.directory !== undefined && isWithinDirectory(candidate.directory, sourceFile);
    return (inProject ? 200 : 0)
      + (candidate.directory !== undefined && isProjectSource(candidate.directory, sourceFile) ? 200 : 0)
      + (moduleInterface ? 100 : 0)
      + (candidate.hasPrebuiltModules ? 10 : 0);
  };

  return candidates.reduce((best, candidate) => (score(candidate) > score(best) ? candidate : best));
}

function isWithinDirectory(directory: string, file: string): boolean {
  const windows = /^[A-Za-z]:[\\/]/.test(directory) || directory.includes("\\")
    || /^[A-Za-z]:[\\/]/.test(file) || file.includes("\\");
  const pathApi = windows ? path.win32 : path.posix;
  const relative = pathApi.relative(pathApi.resolve(directory), pathApi.resolve(file));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function isProjectSource(directory: string, file: string): boolean {
  if (!isWithinDirectory(directory, file)) {
    return false;
  }
  const windows = /^[A-Za-z]:[\\/]/.test(directory) || directory.includes("\\")
    || /^[A-Za-z]:[\\/]/.test(file) || file.includes("\\");
  const pathApi = windows ? path.win32 : path.posix;
  const relative = pathApi.relative(pathApi.resolve(directory), pathApi.resolve(file));
  const firstComponent = relative.split(pathApi.sep)[0];
  return firstComponent !== ".mcpp" && firstComponent !== "target";
}

function removeManagedArguments(arguments_: readonly string[]): string[] {
  const result: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--experimental-modules-support") {
      continue;
    }
    if (argument === "--query-driver") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--query-driver=")) {
      continue;
    }
    result.push(argument);
  }

  return result;
}

function hasValueFlag(arguments_: readonly string[], flag: string): boolean {
  return arguments_.some((argument, index) => (
    (argument === flag && index + 1 < arguments_.length)
    || argument.startsWith(`${flag}=`)
  ));
}

function hasExplicitLibcxxPath(arguments_: readonly string[]): boolean {
  return arguments_.some((argument, index) => {
    const value = argument === "-isystem"
      ? arguments_[index + 1] ?? ""
      : argument.startsWith("-isystem")
        ? argument.slice("-isystem".length)
        : "";
    return /[\\/]include[\\/]c\+\+[\\/]v1(?:[\\/]|$)/.test(value);
  });
}

function isHermeticClangCommand(arguments_: readonly string[] | undefined): boolean {
  if (arguments_ === undefined) {
    return false;
  }
  return arguments_.includes("--no-default-config")
    && arguments_.includes("-nostdinc++")
    && hasExplicitLibcxxPath(arguments_)
    && hasValueFlag(arguments_, "--sysroot");
}

function expandWorkspaceVariables(argument: string, workspaceFolder?: string): string {
  if (workspaceFolder === undefined) {
    return argument;
  }

  return argument.replace(/\$\{workspace(?:Folder|Root)\}/g, () => workspaceFolder);
}

function shouldEnableExperimentalModules(options: ClangdArgumentOptions): boolean {
  if (options.modulesSupport === "on") {
    return true;
  }
  if (options.modulesSupport === "off") {
    return false;
  }
  if (options.hasPrebuiltModules) {
    return false;
  }

  const identity = options.clangdIdentity;
  if (identity === undefined || identity.major < 21) {
    return false;
  }

  return !(
    options.platform === "win32"
    && identity.major === 20
    && identity.minor === 1
    && identity.patch === 7
  );
}

export function buildClangdArguments(
  existingArguments: readonly string[],
  options: ClangdArgumentOptions,
): string[] {
  const result = removeManagedArguments(existingArguments)
    .map((argument) => expandWorkspaceVariables(argument, options.workspaceFolder));
  if (!isHermeticClangCommand(options.compilationArguments)) {
    result.push(`--query-driver=${options.compilerPath}`);
  }

  if (shouldEnableExperimentalModules(options)) {
    result.push("--experimental-modules-support");
  }

  return result;
}

export function buildClangdConfigurationPlan(
  currentPath: string,
  currentArguments: readonly string[],
  resolvedPath: string,
  options: ClangdArgumentOptions,
): ClangdConfigurationPlan {
  const arguments_ = buildClangdArguments(currentArguments, options);
  return {
    path: resolvedPath,
    arguments: arguments_,
    changed: currentPath !== resolvedPath
      || arguments_.length !== currentArguments.length
      || arguments_.some((argument, index) => argument !== currentArguments[index]),
  };
}

export function parseToolIdentity(versionOutput: string): ToolIdentity | undefined {
  const version = versionOutput.match(/\b(?:clangd|clang)(?:\s+version)?\s+(\d+)\.(\d+)(?:\.(\d+))?/i)
    ?? versionOutput.match(/\b(\d+)\.(\d+)(?:\.(\d+))?\b/);
  if (version === null) {
    return undefined;
  }

  const revision = versionOutput.match(/\b[0-9a-f]{7,40}\b/gi)?.at(-1);
  return {
    major: Number(version[1]),
    minor: Number(version[2]),
    patch: Number(version[3] ?? 0),
    ...(revision === undefined ? {} : { revision: revision.toLowerCase() }),
  };
}

export function compareToolIdentities(
  compiler: ToolIdentity | undefined,
  clangd: ToolIdentity | undefined,
): ToolIdentityComparison {
  if (compiler === undefined || clangd === undefined) {
    return {
      compatible: false,
      reason: "无法确定两套 LLVM 工具的身份",
    };
  }

  if (
    compiler.major !== clangd.major
    || compiler.minor !== clangd.minor
    || compiler.patch !== clangd.patch
  ) {
    return {
      compatible: false,
      reason: "编译器与 clangd 的 LLVM 版本不同",
    };
  }

  if (compiler.revision === undefined || clangd.revision === undefined) {
    return {
      compatible: false,
      reason: "LLVM 版本相同，但无法获得精确的 revision",
    };
  }

  if (
    !compiler.revision.startsWith(clangd.revision)
    && !clangd.revision.startsWith(compiler.revision)
  ) {
    return {
      compatible: false,
      reason: "编译器与 clangd 的 LLVM revision 不同",
    };
  }

  return {
    compatible: true,
    reason: "LLVM 版本和 revision 均匹配",
  };
}

export function classifyCheckResult(exitCode: number, output: string): CheckResult {
  if (exitCode === 0) {
    return "ready";
  }

  const normalized = output.toLowerCase();
  if (
    normalized.includes("ast_file_different_branch")
    || normalized.includes("different branch")
    || normalized.includes("pch file uses an older pch format")
    || normalized.includes("ast_file_version_too_new")
    || normalized.includes("newer format that cannot be read")
    || normalized.includes("ast_file_version_too_old")
    || normalized.includes("older format that is no longer supported")
  ) {
    return "pcm-mismatch";
  }
  if (
    normalized.includes("don't get the module unit")
    || normalized.includes("failed to build module")
    || normalized.includes("module file not found")
    || /module ['\"].+['\"] not found/.test(normalized)
  ) {
    return "module-unavailable";
  }
  if (
    normalized.includes("unknown type name 'import'")
    || normalized.includes('unknown type name "import"')
    || normalized.includes("expected unqualified-id") && normalized.includes("import")
  ) {
    return "wrong-language-mode";
  }
  if (normalized.includes("all checks completed")) {
    const diagnostics = output
      .split(/\r?\n/)
      .filter((line) => /^\s*e\[/i.test(line));
    if (diagnostics.length === 0 || diagnostics.every((line) => /\btweak:/i.test(line))) {
      return "ready";
    }
  }

  return "check-failed";
}
