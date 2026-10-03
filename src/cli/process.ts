import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunOptions {
  timeoutMs?: number;
  /** `mcpp.runtime.maxOutputMiB`; the default matches what the extension shipped before it was configurable. */
  maxBufferMiB?: number;
}

export type ProcessRunner = (
  executable: string,
  args: string[],
  cwd?: string,
  options?: ProcessRunOptions,
) => Promise<ProcessResult>;

/**
 * Windows cannot `execFile` a `.cmd`/`.bat` shim directly — Node ≥ 20.12 rejects
 * it with EINVAL outright, and older hosts still mis-handle shebang scripts. A
 * `mcpp.path` that points at such a wrapper (npm-style shim, the e2e fake mcpp)
 * therefore has to go through the shell. Everywhere else the direct spawn is
 * both safer and faster, so only these two suffixes opt in.
 */
export function spawnNeedsShell(executable: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(executable);
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
      maxBuffer: Math.max(1, options.maxBufferMiB ?? 16) * 1024 * 1024,
      timeout: options.timeoutMs,
      ...(spawnNeedsShell(executable) ? { shell: true } : {}),
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
