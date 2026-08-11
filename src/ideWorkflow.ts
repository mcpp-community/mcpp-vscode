import type { ProcessResult } from "./process";

export interface IdeConfigurationRequest {
  projectRoot: string;
  compilationDatabasePath: string;
  trusted: boolean;
  force?: boolean;
  databaseValid: () => boolean;
  configure: () => Promise<ProcessResult>;
}

export type IdeConfigurationOutcome =
  | { state: "configured"; compileCommands: string }
  | { state: "existing"; compileCommands: string }
  | { state: "failed"; compileCommands?: string; exitCode: number }
  | { state: "untrusted"; compileCommands?: string };

/**
 * 决定是否需要执行 mcpp build --configure-only；不在这里读写 VS Code 设置，
 * 便于 Extension Host 和纯 Node 测试共享同一套生命周期边界。
 */
export async function ensureIdeConfigured(
  request: IdeConfigurationRequest,
): Promise<IdeConfigurationOutcome> {
  const validBefore = request.databaseValid();
  if (!request.trusted) {
    return {
      state: "untrusted",
      ...(validBefore ? { compileCommands: request.compilationDatabasePath } : {}),
    };
  }
  if (validBefore && !request.force) {
    return { state: "existing", compileCommands: request.compilationDatabasePath };
  }
  const result = await request.configure();
  const validAfter = request.databaseValid();
  if (result.exitCode === 0 && validAfter) {
    return { state: "configured", compileCommands: request.compilationDatabasePath };
  }
  return {
    state: "failed",
    ...(validAfter ? { compileCommands: request.compilationDatabasePath } : {}),
    exitCode: result.exitCode,
  };
}
