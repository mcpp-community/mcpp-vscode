import { runProcess, type ProcessResult, type ProcessRunner } from "./process";

export interface IdeSnapshotPublished {
  phase: "configured" | "ready";
  compileCommands: string;
  compatibilityCompileCommands?: string;
  snapshotId?: string;
  configurationId?: string;
}

interface IdeEvent {
  seq: number;
  type: string;
  phase?: string;
  compileCommands?: unknown;
  compatibilityCompileCommands?: unknown;
  snapshotId?: unknown;
  configurationId?: unknown;
  status?: unknown;
}

function parseEvent(line: string): IdeEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("mcpp ide configure 输出包含无效 JSON");
  }
  if (value === null || typeof value !== "object") {
    throw new Error("mcpp ide configure 事件不是对象");
  }
  const event = value as Partial<IdeEvent>;
  if (typeof event.seq !== "number" || !Number.isSafeInteger(event.seq)
    || event.seq <= 0 || typeof event.type !== "string") {
    throw new Error("mcpp ide configure 事件缺少有效 seq/type");
  }
  return event as IdeEvent;
}

export function parseIdeConfigureOutput(output: string): IdeSnapshotPublished {
  let previousSeq = 0;
  let published: IdeSnapshotPublished | undefined;
  let finished = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const event = parseEvent(line);
    if (event.seq <= previousSeq) {
      throw new Error("mcpp ide configure 事件序号倒退");
    }
    previousSeq = event.seq;
    if (event.type !== "snapshot-published") {
      if (event.type === "operation-finished") {
        if (event.status !== "success") {
          throw new Error("mcpp ide configure 未成功完成");
        }
        finished = true;
      }
      continue;
    }
    if ((event.phase !== "configured" && event.phase !== "ready")
      || typeof event.compileCommands !== "string") {
      throw new Error("mcpp ide configure 发布事件缺少 CDB");
    }
    published = {
      phase: event.phase,
      compileCommands: event.compileCommands,
      compatibilityCompileCommands:
        typeof event.compatibilityCompileCommands === "string"
          ? event.compatibilityCompileCommands
          : undefined,
      snapshotId: typeof event.snapshotId === "string" ? event.snapshotId : undefined,
      configurationId: typeof event.configurationId === "string" ? event.configurationId : undefined,
    };
  }
  if (published === undefined) {
    throw new Error("mcpp ide configure 没有发布快照");
  }
  if (!finished) {
    throw new Error("mcpp ide configure 未成功完成");
  }
  return published;
}

export async function runIdeConfigure(
  projectRoot: string,
  executable = "mcpp",
  runner: ProcessRunner = runProcess,
): Promise<ProcessResult & IdeSnapshotPublished> {
  const args = ["ide", "configure", "--format", "ndjson"];
  const result = await runner(executable, args, projectRoot);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `mcpp ide configure 失败（退出码 ${result.exitCode}）`);
  }
  return { ...result, ...parseIdeConfigureOutput(result.stdout) };
}
