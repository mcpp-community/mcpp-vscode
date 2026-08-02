import assert from "node:assert/strict";
import test from "node:test";

import * as workflow from "../src/workflow";
import {
  createSerialExecutor,
  createSingleFlightReconciler,
  describeRefreshOutcome,
  statusCommandForCapability,
} from "../src/workflow";

test("selects refresh when the compilation database is unavailable", () => {
  assert.equal(statusCommandForCapability("unavailable"), "mcpp.refreshCompilationDatabase");
  assert.equal(statusCommandForCapability("full"), "mcpp.checkModuleSupport");
  assert.equal(statusCommandForCapability("syntax-only"), "mcpp.checkModuleSupport");
});

test("keeps IDE configuration when a source build fails after producing a database", () => {
  assert.deepEqual(describeRefreshOutcome(1, true, true), {
    level: "warning",
    message: "mcpp 构建失败，但检测到可用的编译数据库，clangd 配置已刷新。请继续修复源码构建错误。",
  });
  assert.deepEqual(describeRefreshOutcome(0, true, true), {
    level: "information",
    message: "mcpp 构建完成，clangd 配置已刷新。",
  });
  assert.equal(describeRefreshOutcome(0, true, false).level, "error");
  assert.equal(describeRefreshOutcome(1, false, false).level, "error");
});

test("serializes reconciliation and merges pending restart requests", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let active = 0;
  let maxConcurrent = 0;
  const restartRequests: boolean[] = [];
  const reconcile = createSingleFlightReconciler(async (forceRestart) => {
    restartRequests.push(forceRestart);
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    try {
      if (restartRequests.length === 1) {
        await firstGate;
      }
      return restartRequests.length;
    } finally {
      active -= 1;
    }
  });

  const first = reconcile(false);
  const second = reconcile(true);
  const third = reconcile(true);
  assert.deepEqual(restartRequests, [false]);
  assert.ok(releaseFirst);
  releaseFirst();

  assert.deepEqual(await Promise.all([first, second, third]), [2, 2, 2]);
  assert.deepEqual(restartRequests, [false, true]);
  assert.equal(maxConcurrent, 1);
});

test("coalesces reconciliation requests independently for each project", async () => {
  const createKeyedReconciler = (
    workflow as typeof workflow & {
      createKeyedSingleFlightReconciler?: <K, T>(
        operation: (key: K, forceRestart: boolean) => Promise<T>,
      ) => (key: K, forceRestart?: boolean) => Promise<T>;
    }
  ).createKeyedSingleFlightReconciler;
  assert.equal(typeof createKeyedReconciler, "function");
  assert.ok(createKeyedReconciler);

  let releaseFirstProject: (() => void) | undefined;
  const firstProjectGate = new Promise<void>((resolve) => {
    releaseFirstProject = resolve;
  });
  const calls: string[] = [];
  const reconcile = createKeyedReconciler(async (project: string, forceRestart: boolean) => {
    calls.push(`${project}:${forceRestart}`);
    if (project === "/work/a" && calls.filter((call) => call.startsWith("/work/a")).length === 1) {
      await firstProjectGate;
    }
    return `${project}:${forceRestart}`;
  });

  const firstA = reconcile("/work/a", false);
  const secondA = reconcile("/work/a", true);
  const firstB = reconcile("/work/b", true);

  assert.equal(await firstB, "/work/b:true");
  assert.deepEqual(calls, ["/work/a:false", "/work/b:true"]);
  assert.ok(releaseFirstProject);
  releaseFirstProject();
  assert.deepEqual(await Promise.all([firstA, secondA]), ["/work/a:true", "/work/a:true"]);
  assert.deepEqual(calls, ["/work/a:false", "/work/b:true", "/work/a:true"]);
});

test("serializes operations that share the workspace clangd configuration", async () => {
  const createSerialExecutor = (
    workflow as typeof workflow & {
      createSerialExecutor?: () => <T>(operation: () => Promise<T>) => Promise<T>;
    }
  ).createSerialExecutor;
  assert.equal(typeof createSerialExecutor, "function");
  assert.ok(createSerialExecutor);

  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const calls: string[] = [];
  const execute = createSerialExecutor();
  const first = execute(async () => {
    calls.push("a:start");
    await firstGate;
    calls.push("a:end");
    return "a";
  });
  const second = execute(async () => {
    calls.push("b:start");
    calls.push("b:end");
    return "b";
  });

  await Promise.resolve();
  assert.deepEqual(calls, ["a:start"]);
  assert.ok(releaseFirst);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.deepEqual(calls, ["a:start", "a:end", "b:start", "b:end"]);
});

test("queues an unrelated concurrent caller behind an in-flight operation", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const calls: string[] = [];
  let maxConcurrent = 0;
  let active = 0;
  const execute = createSerialExecutor();

  const first = execute(async () => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    calls.push("a:start");
    await firstGate;
    calls.push("a:end");
    active -= 1;
    return "a";
  });

  // A second, unrelated invocation arrives while the first is still in flight,
  // from a separate async context (a macrotask, like a user command event).
  let second: Promise<string> | undefined;
  const secondArrived = new Promise<void>((resolve) => {
    setTimeout(() => {
      second = execute(async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        calls.push("b:start");
        calls.push("b:end");
        active -= 1;
        return "b";
      });
      resolve();
    }, 10);
  });
  await secondArrived;

  assert.deepEqual(calls, ["a:start"]);
  assert.ok(releaseFirst);
  releaseFirst();
  assert.ok(second);
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.deepEqual(calls, ["a:start", "a:end", "b:start", "b:end"]);
  assert.equal(maxConcurrent, 1);
});

test("runs a reentrant call from inside an operation without queuing", async () => {
  const calls: string[] = [];
  let releaseInner: (() => void) | undefined;
  const innerGate = new Promise<void>((resolve) => {
    releaseInner = resolve;
  });
  const execute = createSerialExecutor();

  const outer = execute(async () => {
    calls.push("outer:start");
    await Promise.resolve();
    const inner = execute(async () => {
      calls.push("inner:start");
      await innerGate;
      calls.push("inner:end");
      return "inner";
    });
    calls.push("outer:mid");
    const value = await inner;
    calls.push("outer:end");
    return value;
  });

  // The outer operation's continuation (which makes the reentrant call) runs in
  // the microtask queue, before the timer below fires.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.ok(releaseInner);
  releaseInner();
  assert.equal(await outer, "inner");
  assert.deepEqual(calls, ["outer:start", "inner:start", "outer:mid", "inner:end", "outer:end"]);
});

test("retries a queued reconciliation after a transient failure", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const restartRequests: boolean[] = [];
  const reconcile = createSingleFlightReconciler(async (forceRestart) => {
    restartRequests.push(forceRestart);
    if (restartRequests.length === 1) {
      await firstGate;
      throw new Error("temporary CDB read failure");
    }
    return 2;
  });

  const first = reconcile(false);
  const second = reconcile(true);
  assert.ok(releaseFirst);
  releaseFirst();

  assert.deepEqual(await Promise.allSettled([first, second]), [
    { status: "fulfilled", value: 2 },
    { status: "fulfilled", value: 2 },
  ]);
  assert.deepEqual(restartRequests, [false, true]);
});

test("forces a clangd restart when the compilation database changes", () => {
  const shouldRestart = (
    workflow as typeof workflow & {
      shouldRestartClangd?: (
        configurationChanged: boolean,
        interactive: boolean,
        forceRestart: boolean,
      ) => boolean;
    }
  ).shouldRestartClangd;
  assert.equal(typeof shouldRestart, "function");
  assert.ok(shouldRestart);

  assert.equal(shouldRestart(false, false, true), true);
  assert.equal(shouldRestart(false, false, false), false);
  assert.equal(shouldRestart(true, false, false), true);
  assert.equal(shouldRestart(false, true, false), true);
});

test("does not call clangd configuration ready when a required restart fails", () => {
  const configurationReady = (
    workflow as typeof workflow & {
      configurationReadyAfterRestart?: (
        restartRequired: boolean,
        restartSucceeded: boolean,
      ) => boolean;
    }
  ).configurationReadyAfterRestart;
  assert.equal(typeof configurationReady, "function");
  assert.ok(configurationReady);

  assert.equal(configurationReady(false, false), true);
  assert.equal(configurationReady(true, true), true);
  assert.equal(configurationReady(true, false), false);
});

test("maps compilation database file events to reconciliation requests", () => {
  type EventName = "create" | "change" | "delete";
  const registerEvents = (
    workflow as typeof workflow & {
      registerCompilationDatabaseReconciliation?: <T, E>(
        watcher: {
          onDidCreate(listener: (event: E) => void): T;
          onDidChange(listener: (event: E) => void): T;
          onDidDelete(listener: (event: E) => void): T;
        },
        requestReconciliation: (event: E, forceRestart: boolean) => void,
      ) => T[];
    }
  ).registerCompilationDatabaseReconciliation;
  assert.equal(typeof registerEvents, "function");
  assert.ok(registerEvents);

  const listeners: Partial<Record<EventName, (event: string) => void>> = {};
  const watcher = {
    onDidCreate(listener: (event: string) => void): EventName {
      listeners.create = listener;
      return "create";
    },
    onDidChange(listener: (event: string) => void): EventName {
      listeners.change = listener;
      return "change";
    },
    onDidDelete(listener: (event: string) => void): EventName {
      listeners.delete = listener;
      return "delete";
    },
  };
  const requests: Array<{ event: string; forceRestart: boolean }> = [];

  assert.deepEqual(registerEvents(watcher, (event: string, forceRestart: boolean) => {
    requests.push({ event, forceRestart });
  }), [
    "create",
    "change",
    "delete",
  ]);
  listeners.create?.("/work/a/compile_commands.json");
  listeners.change?.("/work/b/compile_commands.json");
  listeners.delete?.("/work/c/compile_commands.json");

  assert.deepEqual(requests, [
    { event: "/work/a/compile_commands.json", forceRestart: true },
    { event: "/work/b/compile_commands.json", forceRestart: true },
    { event: "/work/c/compile_commands.json", forceRestart: false },
  ]);
});

test("accepts module status only from the latest check for the current project", () => {
  const createTracker = (
    workflow as typeof workflow & {
      createLatestOperationTracker?: <K>() => {
        begin(key: K): number;
        invalidate(key: K): void;
        isCurrent(key: K, token: number): boolean;
        clear(): void;
      };
    }
  ).createLatestOperationTracker;
  const shouldRender = (
    workflow as typeof workflow & {
      shouldRenderProjectStatus?: (
        currentProjectRoot: string | undefined,
        statusProjectRoot: string,
      ) => boolean;
    }
  ).shouldRenderProjectStatus;
  assert.equal(typeof createTracker, "function");
  assert.equal(typeof shouldRender, "function");
  assert.ok(createTracker);
  assert.ok(shouldRender);

  const tracker = createTracker<string>();
  const first = tracker.begin("/work/a");
  const second = tracker.begin("/work/a");
  const other = tracker.begin("/work/b");
  assert.equal(tracker.isCurrent("/work/a", first), false);
  assert.equal(tracker.isCurrent("/work/a", second), true);
  assert.equal(tracker.isCurrent("/work/b", other), true);

  tracker.invalidate("/work/a");
  assert.equal(tracker.isCurrent("/work/a", second), false);
  tracker.clear();
  assert.equal(tracker.isCurrent("/work/b", other), false);

  assert.equal(shouldRender("/work/a", "/work/a"), true);
  assert.equal(shouldRender("/work/b", "/work/a"), false);
  assert.equal(shouldRender(undefined, "/work/a"), false);
});

test("reconciles when a module-related mcpp setting changes", () => {
  const affectsModuleConfiguration = (
    workflow as typeof workflow & {
      configurationAffectsModuleSupport?: (
        affectsConfiguration: (section: string) => boolean,
      ) => boolean;
    }
  ).configurationAffectsModuleSupport;
  assert.equal(typeof affectsModuleConfiguration, "function");
  assert.ok(affectsModuleConfiguration);

  assert.equal(
    affectsModuleConfiguration((section) => section === "mcpp.clangd.path"),
    true,
  );
  assert.equal(
    affectsModuleConfiguration((section) => section === "mcpp.modulesSupport"),
    true,
  );
  assert.equal(
    affectsModuleConfiguration((section) => section === "mcpp.path"),
    false,
  );
  assert.equal(affectsModuleConfiguration(() => false), false);
});

test("only executes workspace-selected tools in trusted workspaces", () => {
  const allowsToolExecution = (
    workflow as typeof workflow & {
      workspaceAllowsToolExecution?: (trusted: boolean) => boolean;
    }
  ).workspaceAllowsToolExecution;
  assert.equal(typeof allowsToolExecution, "function");
  assert.ok(allowsToolExecution);

  assert.equal(allowsToolExecution(true), true);
  assert.equal(allowsToolExecution(false), false);
});

test("only lets the current project own the shared workspace clangd", () => {
  const shouldUseWorkspaceClangd = (
    workflow as typeof workflow & {
      shouldUseWorkspaceClangd?: (
        currentProjectRoot: string | undefined,
        projectRoot: string,
      ) => boolean;
    }
  ).shouldUseWorkspaceClangd;
  assert.equal(typeof shouldUseWorkspaceClangd, "function");
  assert.ok(shouldUseWorkspaceClangd);

  assert.equal(shouldUseWorkspaceClangd("/work/a", "/work/a"), true);
  assert.equal(shouldUseWorkspaceClangd("/work/b", "/work/a"), false);
  assert.equal(shouldUseWorkspaceClangd(undefined, "/work/a"), false);
});

test("only runs automatic module checks for configured LLVM source commands", () => {
  const shouldCheck = (
    workflow as typeof workflow & {
      shouldCheckModuleSupport?: (
        capability: "full" | "syntax-only" | "unavailable",
        configured: boolean,
        sourceFile?: string,
      ) => boolean;
    }
  ).shouldCheckModuleSupport;
  assert.equal(typeof shouldCheck, "function");
  assert.ok(shouldCheck);

  assert.equal(shouldCheck("full", true, "/work/src/main.cpp"), true);
  assert.equal(shouldCheck("full", false, "/work/src/main.cpp"), false);
  assert.equal(shouldCheck("full", true), false);
  assert.equal(shouldCheck("syntax-only", true, "/work/src/main.cpp"), false);
  assert.equal(shouldCheck("unavailable", true, "/work/src/main.cpp"), false);
});

test("maps clangd check classifications to module availability", () => {
  const moduleSupportState = (
    workflow as typeof workflow & {
      moduleSupportState?: (classification: string) => "available" | "unavailable";
    }
  ).moduleSupportState;
  assert.equal(typeof moduleSupportState, "function");
  assert.ok(moduleSupportState);

  assert.equal(moduleSupportState("ready"), "available");
  assert.equal(moduleSupportState("module-unavailable"), "unavailable");
  assert.equal(moduleSupportState("wrong-language-mode"), "unavailable");
});
