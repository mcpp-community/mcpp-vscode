import assert from "node:assert/strict";
import test from "node:test";

import {
  createLanguageServerBridge,
  MCPPLS_COMMANDS,
  MCPPLS_EXTENSION_ID,
} from "../../src/mcppls/bridge";

function harness(installed = true) {
  const calls: Array<{ command: string; args: unknown[] }> = [];
  const activations: string[] = [];
  const bridge = createLanguageServerBridge({
    extensionInstalled: (id) => installed && id === MCPPLS_EXTENSION_ID,
    activateExtension: async (id) => { activations.push(id); },
    executeCommand: async <T>(command: string, ...args: unknown[]): Promise<T> => {
      calls.push({ command, args });
      return undefined as T;
    },
  });
  return { bridge, calls, activations };
}

test("uses the published mcppls extension and command identifiers", () => {
  assert.equal(MCPPLS_EXTENSION_ID, "sunrisepeak.mcpp-language-server");
  assert.deepEqual(MCPPLS_COMMANDS, {
    restart: "mcppls.restartServer",
    selectContext: "mcppls.selectContext",
    graph: "mcppls.showModuleGraph",
    logs: "mcppls.showLogs",
  });
});

test("forwards the public mcppls UI commands", async () => {
  const { bridge, calls, activations } = harness();

  assert.deepEqual(await bridge.restartLanguageServer(), {
    state: "completed",
    message: "C++ 模块语言服务已重启。",
  });
  await bridge.selectContext();
  await bridge.showModuleGraph();
  await bridge.showLanguageServerLogs();

  assert.deepEqual(activations, [MCPPLS_EXTENSION_ID, MCPPLS_EXTENSION_ID, MCPPLS_EXTENSION_ID, MCPPLS_EXTENSION_ID]);
  assert.deepEqual(calls, [
    { command: MCPPLS_COMMANDS.restart, args: [] },
    { command: MCPPLS_COMMANDS.selectContext, args: [] },
    { command: MCPPLS_COMMANDS.graph, args: [] },
    { command: MCPPLS_COMMANDS.logs, args: [] },
  ]);
});

test("returns a stable unavailable result instead of throwing", async () => {
  const { bridge, calls } = harness(false);

  assert.deepEqual(await bridge.restartLanguageServer(), {
    state: "unavailable",
    message: "C++ 模块语言服务依赖未安装或已禁用：sunrisepeak.mcpp-language-server。",
  });
  assert.deepEqual(calls, []);
});

test("returns a stable failed result when mcppls rejects a command", async () => {
  const calls: string[] = [];
  const bridge = createLanguageServerBridge({
    extensionInstalled: (id) => id === MCPPLS_EXTENSION_ID,
    executeCommand: async <T>(command: string): Promise<T> => {
      calls.push(command);
      throw new Error("server is not running");
    },
  });

  assert.deepEqual(await bridge.restartLanguageServer(), {
    state: "failed",
    message: "C++ Modules 命令执行失败：server is not running",
  });
  assert.deepEqual(calls, [MCPPLS_COMMANDS.restart]);
});

test("coalesces concurrent build refresh requests into one restart", async () => {
  let release: (() => void) | undefined;
  const calls: string[] = [];
  const bridge = createLanguageServerBridge({
    extensionInstalled: (id) => id === MCPPLS_EXTENSION_ID,
    executeCommand: async <T>(command: string): Promise<T> => {
      calls.push(command);
      await new Promise<void>((resolve) => { release = resolve; });
      return undefined as T;
    },
  });

  const first = bridge.refreshLanguageServerAfterBuild();
  const second = bridge.refreshLanguageServerAfterBuild();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [MCPPLS_COMMANDS.restart]);
  release?.();
  assert.deepEqual(await first, {
    state: "completed",
    message: "C++ 模块语言服务已刷新。",
  });
  assert.deepEqual(await second, {
    state: "completed",
    message: "C++ 模块语言服务已刷新。",
  });
  assert.deepEqual(calls, [MCPPLS_COMMANDS.restart]);
});
