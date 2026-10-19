import { runProcess, type ProcessRunner } from "./process";
import { parseModuleGraph, type ModuleGraphJson } from "../projects/moduleGraph";

/** Use mcppls's resolved graph; never launch a second C++ parser in this extension. */
export async function queryModuleGraph(trusted: boolean, executable: string, root: string, runner: ProcessRunner = runProcess, signal?: AbortSignal): Promise<ModuleGraphJson> {
  if (!trusted) { throw new Error("Trust this workspace before reading its module graph."); }
  const result = await runner(executable, ["query", "module", "--graph", "--root", root, "--timeout", "20", "--format", "json"], root, { timeoutMs: 30_000, maxBufferMiB: 8, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) { throw new Error(result.stderr.trim() || "mcppls module graph query failed"); }
  return parseModuleGraph(result.stdout);
}
