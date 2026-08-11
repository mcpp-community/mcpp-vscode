import { runProcess, type ProcessResult, type ProcessRunner } from "./process";

export const configureOnlyArguments = ["build", "--configure-only"] as const;

export function runConfigureOnly(
  projectRoot: string,
  executable = "mcpp",
  runner: ProcessRunner = runProcess,
): Promise<ProcessResult> {
  return runner(executable, [...configureOnlyArguments], projectRoot);
}
