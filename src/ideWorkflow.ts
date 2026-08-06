import type { IdeSnapshotPublished } from "./ideProtocol";

export interface IdeConfigurationRequest {
  projectRoot: string;
  compilationDatabasePath: string;
  trusted: boolean;
  force?: boolean;
  databaseExists: () => boolean;
  configure: () => Promise<IdeSnapshotPublished>;
}

export type IdeConfigurationOutcome =
  | { state: "configured"; compileCommands: string; snapshot: IdeSnapshotPublished }
  | { state: "existing"; compileCommands: string }
  | { state: "untrusted"; compileCommands?: string };

/**
 * 决定是否需要执行 mcpp ide configure；不在这里读写 VS Code 设置，
 * 便于 Extension Host 和纯 Node 测试共享同一套生命周期边界。
 */
export async function ensureIdeConfigured(
  request: IdeConfigurationRequest,
): Promise<IdeConfigurationOutcome> {
  const exists = request.databaseExists();
  if (!request.trusted) {
    return {
      state: "untrusted",
      ...(exists ? { compileCommands: request.compilationDatabasePath } : {}),
    };
  }
  if (exists && !request.force) {
    return { state: "existing", compileCommands: request.compilationDatabasePath };
  }
  const snapshot = await request.configure();
  return {
    state: "configured",
    compileCommands: snapshot.compatibilityCompileCommands ?? snapshot.compileCommands,
    snapshot,
  };
}
