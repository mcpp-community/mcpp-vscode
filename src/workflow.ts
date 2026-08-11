import { AsyncLocalStorage } from "node:async_hooks";

import type { CheckResult, ModuleCapability } from "./analysis";

export type RefreshOutcomeLevel = "information" | "warning" | "error";
export type ModuleSupportState = "available" | "unavailable";

export interface RefreshOutcome {
  level: RefreshOutcomeLevel;
  message: string;
}

export interface CompilationDatabaseWatcher<T, E> {
  onDidCreate(listener: (event: E) => void): T;
  onDidChange(listener: (event: E) => void): T;
  onDidDelete(listener: (event: E) => void): T;
}

export async function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function registerCompilationDatabaseReconciliation<T, E>(
  watcher: CompilationDatabaseWatcher<T, E>,
  requestReconciliation: (event: E, forceRestart: boolean) => void,
): T[] {
  return [
    watcher.onDidCreate((event) => requestReconciliation(event, true)),
    watcher.onDidChange((event) => requestReconciliation(event, true)),
    watcher.onDidDelete((event) => requestReconciliation(event, false)),
  ];
}

export function shouldRestartClangd(
  configurationChanged: boolean,
  interactive: boolean,
  forceRestart: boolean,
): boolean {
  return configurationChanged || interactive || forceRestart;
}

export function configurationReadyAfterRestart(
  restartRequired: boolean,
  restartSucceeded: boolean,
): boolean {
  return !restartRequired || restartSucceeded;
}

export function createSingleFlightReconciler<T>(
  operation: (forceRestart: boolean) => Promise<T>,
): (forceRestart?: boolean) => Promise<T> {
  let active: Promise<T> | undefined;
  let requested = false;
  let pendingForceRestart = false;

  return (forceRestart = false): Promise<T> => {
    requested = true;
    pendingForceRestart ||= forceRestart;
    if (active !== undefined) {
      return active;
    }

    active = (async () => {
      let result: T | undefined;
      let completed = false;
      do {
        const currentForceRestart = pendingForceRestart;
        requested = false;
        pendingForceRestart = false;
        try {
          result = await operation(currentForceRestart);
          completed = true;
        } catch (error) {
          if (!requested) {
            throw error;
          }
        }
      } while (requested);
      if (!completed) {
        throw new Error("重协调没有产生结果");
      }
      return result as T;
    })().finally(() => {
      active = undefined;
      requested = false;
      pendingForceRestart = false;
    });
    return active as Promise<T>;
  };
}

export function createKeyedSingleFlightReconciler<K, T>(
  operation: (key: K, forceRestart: boolean) => Promise<T>,
): (key: K, forceRestart?: boolean) => Promise<T> {
  const reconcilerByKey = new Map<K, (forceRestart?: boolean) => Promise<T>>();

  return (key: K, forceRestart = false): Promise<T> => {
    let reconciler = reconcilerByKey.get(key);
    if (reconciler === undefined) {
      reconciler = createSingleFlightReconciler(
        (pendingForceRestart) => operation(key, pendingForceRestart),
      );
      reconcilerByKey.set(key, reconciler);
    }
    return reconciler(forceRestart);
  };
}

export function createSerialExecutor(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  // `running` is scoped to the async context of the in-flight operation via
  // AsyncLocalStorage instead of a global counter, so only genuinely reentrant
  // calls bypass the queue:
  //   - a call made from inside an operation's own async chain (e.g.
  //     wizard → build → reconcile → executor) sees `running` and executes
  //     immediately — the outer operation is awaiting it, so queuing would hang;
  //   - an unrelated concurrent caller (a separate command/event that has its
  //     own async context) does not see it and queues behind the in-flight
  //     operation, which the previous `depth > 0` check would wrongly let run
  //     concurrently.
  const state = { running: false };
  const storage = new AsyncLocalStorage<{ running: boolean }>();

  return <T>(operation: () => Promise<T>): Promise<T> => {
    if (storage.getStore() === state && state.running) {
      return operation();
    }

    const wrapped = async (): Promise<T> => {
      state.running = true;
      try {
        return await storage.run(state, operation);
      } finally {
        state.running = false;
      }
    };

    const result = tail.then(wrapped, wrapped);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export interface LatestOperationTracker<K> {
  begin(key: K): number;
  invalidate(key: K): void;
  isCurrent(key: K, token: number): boolean;
  clear(): void;
}

export function createLatestOperationTracker<K>(): LatestOperationTracker<K> {
  const latestTokenByKey = new Map<K, number>();
  let nextToken = 0;

  return {
    begin(key: K): number {
      nextToken += 1;
      latestTokenByKey.set(key, nextToken);
      return nextToken;
    },
    invalidate(key: K): void {
      latestTokenByKey.delete(key);
    },
    isCurrent(key: K, token: number): boolean {
      return latestTokenByKey.get(key) === token;
    },
    clear(): void {
      latestTokenByKey.clear();
    },
  };
}

export function shouldRenderProjectStatus(
  currentProjectRoot: string | undefined,
  statusProjectRoot: string,
): boolean {
  return currentProjectRoot === statusProjectRoot;
}

export function configurationAffectsModuleSupport(
  affectsConfiguration: (section: string) => boolean,
): boolean {
  return ["mcpp.clangd.path", "mcpp.modulesSupport"].some(affectsConfiguration);
}

export function configurationAffectsMcppExecution(
  affectsConfiguration: (section: string) => boolean,
): boolean {
  return affectsConfiguration("mcpp.path");
}

export function workspaceAllowsToolExecution(trusted: boolean): boolean {
  return trusted;
}

export function shouldUseWorkspaceClangd(
  currentProjectRoot: string | undefined,
  projectRoot: string,
): boolean {
  return currentProjectRoot === projectRoot;
}

export function describeRefreshOutcome(
  buildExitCode: number,
  databaseFound: boolean,
  configured: boolean,
): RefreshOutcome {
  if (configured) {
    return buildExitCode === 0
      ? {
        level: "information",
        message: "mcpp 构建完成，clangd 配置已刷新。",
      }
      : {
        level: "warning",
        message: "mcpp 构建失败，但检测到可用的编译数据库，clangd 配置已刷新。请继续修复源码构建错误。",
      };
  }

  if (!databaseFound) {
    return buildExitCode === 0
      ? {
        level: "error",
        message: "mcpp 构建完成，但没有生成 compile_commands.json。",
      }
      : {
        level: "error",
        message: "mcpp 构建失败，且没有生成 compile_commands.json。请查看 mcpp 输出频道。",
      };
  }

  return {
    level: "error",
    message: buildExitCode === 0
      ? "已检测到 compile_commands.json，但 clangd 配置未完成。请查看 mcpp 输出频道。"
      : "mcpp 构建失败；已检测到 compile_commands.json，但 clangd 配置未完成。请查看 mcpp 输出频道。",
  };
}

export function describeConfigureOnlyOutcome(
  exitCode: number,
  databaseValid: boolean,
  retainedExisting: boolean,
  clangdConfigured: boolean,
): RefreshOutcome {
  if (exitCode === 0 && databaseValid) {
    return clangdConfigured
      ? {
        level: "information",
        message: "编译数据库已刷新，clangd 配置已重新加载。",
      }
      : {
        level: "warning",
        message: "编译数据库已刷新，但 clangd 配置未完成。请查看 mcpp 输出频道。",
      };
  }
  if (exitCode === 0) {
    return {
      level: "error",
      message: "mcpp configure-only 已完成，但没有生成可用的 compile_commands.json。",
    };
  }
  if (databaseValid) {
    return retainedExisting
      ? {
        level: "warning",
        message: "mcpp configure-only 失败；继续使用原有编译数据库。请查看 mcpp 输出频道。",
      }
      : {
        level: "warning",
        message: "mcpp configure-only 失败，但检测到可用的编译数据库。请查看 mcpp 输出频道。",
      };
  }
  return {
    level: "error",
    message: "mcpp configure-only 失败，且没有可用的编译数据库。请确认 mcpp 版本支持 build --configure-only。",
  };
}

export function statusCommandForCapability(capability: ModuleCapability): string {
  return capability === "unavailable"
    ? "mcpp.refreshCompilationDatabase"
    : "mcpp.checkModuleSupport";
}

export function shouldCheckModuleSupport(
  capability: ModuleCapability,
  configured: boolean,
  sourceFile?: string,
): boolean {
  return capability === "full" && configured && sourceFile !== undefined && sourceFile.length > 0;
}

export function moduleSupportState(classification: CheckResult): ModuleSupportState {
  return classification === "ready" ? "available" : "unavailable";
}
