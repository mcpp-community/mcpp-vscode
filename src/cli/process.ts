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

/**
 * One argument, quoted for the shell path (external review P1-2, 2026-10-03).
 *
 * Node joins `file` and `args` with plain spaces when `shell: true`, without
 * quoting anything, so a path with a space (`C:\Users\John Doe\…`, exactly what
 * `xpkg parse` receives) splits in two and a search term like `foo & calc`
 * becomes two commands. The rule is the one `CommandLineToArgvW` applies when
 * the target re-parses the line: double backslashes that precede a quote or end
 * the argument, escape the quotes themselves, and wrap in double quotes —
 * inside which cmd treats `& | < > ^` as literal. `%VAR%` expansion inside
 * quotes is a cmd limitation every shell-spawner shares and stays documented
 * here rather than half-fixed.
 */
export function quoteWindowsArgument(argument: string): string {
  let quoted = argument.replace(/(\\*)"/g, '$1$1\\"');
  quoted = quoted.replace(/(\\*)$/, '$1$1');
  return `"${quoted}"`;
}

export async function runProcess(
  executable: string,
  args: string[],
  cwd?: string,
  options: ProcessRunOptions = {},
): Promise<ProcessResult> {
  try {
    const needsShell = spawnNeedsShell(executable);
    const result = await execFileAsync(
      needsShell ? quoteWindowsArgument(executable) : executable,
      needsShell ? args.map(quoteWindowsArgument) : args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: Math.max(1, options.maxBufferMiB ?? 16) * 1024 * 1024,
        timeout: options.timeoutMs,
        ...(needsShell ? { shell: true } : {}),
      },
    );
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

/**
 * The one way the extension body runs mcpp: `runProcess` plus the
 * workspace-trust gate (external review P0, 2026-10-03).
 *
 * `mcpp.path` is a `resource`-scoped setting, so an untrusted workspace can
 * name any program there; every caller outside `src/cli/` therefore goes
 * through this seam and receives `undefined` — a refusal, not an error — when
 * the workspace is not trusted. The callers degrade (the detail page falls
 * back to the descriptor's own text, the cross-registry search keeps its
 * local results, the self-check reports the probe as unknown) instead of
 * running the command.
 *
 * `src/cli/controller.ts` wraps its own `requireTrusted()` prompts around
 * whole commands, which is why `src/cli/` may still call `runProcess`
 * directly; the architecture test holds everyone else to this seam.
 */
export async function runMcpp(
  trusted: boolean,
  executable: string,
  args: readonly string[],
  cwd?: string,
  options: ProcessRunOptions = {},
): Promise<ProcessResult | undefined> {
  if (!trusted) {
    return undefined;
  }
  return runProcess(executable, [...args], cwd, options);
}
