import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  classifyCheckResult,
  parseToolIdentity,
  type CheckResult,
  type ToolIdentity,
} from "./analysis";

const execFileAsync = promisify(execFile);

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunOptions {
  timeoutMs?: number;
}

export type ProcessRunner = (
  executable: string,
  args: string[],
  cwd?: string,
  options?: ProcessRunOptions,
) => Promise<ProcessResult>;

export interface ToolVersionResult extends ProcessResult {
  identity: ToolIdentity | undefined;
}

export interface ClangdCheckResult extends ProcessResult {
  output: string;
  classification: CheckResult;
}

export async function runProcess(
  executable: string,
  args: string[],
  cwd?: string,
  options: ProcessRunOptions = {},
): Promise<ProcessResult> {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeoutMs,
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      exitCode: typeof processError.code === "number" ? processError.code : 1,
      stdout: processError.stdout ?? "",
      stderr: processError.stderr ?? (typeof processError.message === "string" ? processError.message : ""),
    };
  }
}

export async function runToolVersion(
  executable: string,
  versionArguments: string[] = ["--version"],
  runner: ProcessRunner = runProcess,
): Promise<ToolVersionResult> {
  const result = await runner(executable, versionArguments);
  return {
    ...result,
    identity: parseToolIdentity(`${result.stdout}\n${result.stderr}`),
  };
}

export async function runClangdCheck(
  clangdPath: string,
  sourceFile: string,
  cwd: string,
  clangdArguments: string[] = [],
  runner: ProcessRunner = runProcess,
): Promise<ClangdCheckResult> {
  const result = await runner(
    clangdPath,
    [`--check=${sourceFile}`, ...clangdArguments],
    cwd,
    { timeoutMs: 60_000 },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    ...result,
    output,
    classification: classifyCheckResult(result.exitCode, output),
  };
}

export function runMcppBuild(
  cwd: string,
  executable: string = "mcpp",
  runner: ProcessRunner = runProcess,
): Promise<ProcessResult> {
  return runner(executable, ["build"], cwd);
}
