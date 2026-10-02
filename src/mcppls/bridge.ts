export const MCPPLS_EXTENSION_ID = "sunrisepeak.mcpp-language-server";

export const MCPPLS_COMMANDS = {
  restart: "mcppls.restartServer",
  selectContext: "mcppls.selectContext",
  graph: "mcppls.showModuleGraph",
  logs: "mcppls.showLogs",
} as const;

export type LanguageServerCommandState = "completed" | "unavailable" | "failed";

export interface LanguageServerCommandResult {
  state: LanguageServerCommandState;
  message: string;
}

export interface LanguageServerCommandExecutor {
  extensionInstalled(id: string): boolean;
  /** Activate the dependency before forwarding a command when VS Code has not activated it yet. */
  activateExtension?(id: string): Thenable<void>;
  executeCommand<T>(command: string, ...args: unknown[]): Thenable<T>;
}

export interface LanguageServerBridge {
  restartLanguageServer(): Promise<LanguageServerCommandResult>;
  refreshLanguageServerAfterBuild(): Promise<LanguageServerCommandResult>;
  selectContext(): Promise<LanguageServerCommandResult>;
  showModuleGraph(): Promise<LanguageServerCommandResult>;
  showLanguageServerLogs(): Promise<LanguageServerCommandResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLanguageServerBridge(
  executor: LanguageServerCommandExecutor,
): LanguageServerBridge {
  let refreshInFlight: Promise<LanguageServerCommandResult> | undefined;

  async function invoke(command: string, successMessage: string): Promise<LanguageServerCommandResult> {
    if (!executor.extensionInstalled(MCPPLS_EXTENSION_ID)) {
      return {
        state: "unavailable",
        message: `C++ 模块语言服务依赖未安装或已禁用：${MCPPLS_EXTENSION_ID}。`,
      };
    }
    try {
      await executor.activateExtension?.(MCPPLS_EXTENSION_ID);
      await executor.executeCommand(command);
      return { state: "completed", message: successMessage };
    } catch (error) {
      return {
        state: "failed",
        message: `C++ Modules 命令执行失败：${errorMessage(error)}`,
      };
    }
  }

  async function restartLanguageServer(): Promise<LanguageServerCommandResult> {
    return invoke(MCPPLS_COMMANDS.restart, "C++ 模块语言服务已重启。");
  }

  function refreshLanguageServerAfterBuild(): Promise<LanguageServerCommandResult> {
    if (refreshInFlight !== undefined) {
      return refreshInFlight;
    }
    refreshInFlight = invoke(MCPPLS_COMMANDS.restart, "C++ 模块语言服务已刷新。")
      .finally(() => { refreshInFlight = undefined; });
    return refreshInFlight;
  }

  return {
    restartLanguageServer,
    refreshLanguageServerAfterBuild,
    selectContext: () => invoke(MCPPLS_COMMANDS.selectContext, "已打开 C++ 模块上下文选择。"),
    showModuleGraph: () => invoke(MCPPLS_COMMANDS.graph, "已打开 C++ 模块图。"),
    showLanguageServerLogs: () => invoke(MCPPLS_COMMANDS.logs, "已打开 C++ Modules 日志。"),
  };
}
