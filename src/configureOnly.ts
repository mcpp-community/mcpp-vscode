import { runProcess, type ProcessResult, type ProcessRunner } from "./process";

export const configureOnlyArguments = ["build", "--configure-only"] as const;
// 配置阶段可能解析工具链和依赖，但不能无限期占住 IDE 操作队列。
export const configureOnlyTimeoutMs = 5 * 60_000;

export function runConfigureOnly(
  projectRoot: string,
  executable = "mcpp",
  runner: ProcessRunner = runProcess,
): Promise<ProcessResult> {
  return runner(
    executable,
    [...configureOnlyArguments],
    projectRoot,
    { timeoutMs: configureOnlyTimeoutMs },
  );
}
