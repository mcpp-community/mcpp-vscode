import assert from "node:assert/strict";
import test from "node:test";

import { createLanguageServerBridge, MCPPLS_EXTENSION_ID } from "../../src/mcppls/bridge";
import type { CapabilityEnvironment } from "../../src/mcppls/capabilities";

function harness(options: { installed?: boolean; behaviour?: (command: string) => void } = {}) {
  const installed = options.installed ?? true;
  const calls: Array<{ command: string; args: unknown[] }> = [];
  const activations: string[] = [];
  const environment: CapabilityEnvironment = {
    extensionInstalled: (id) => installed && id === MCPPLS_EXTENSION_ID,
    declaredCommands: () => undefined,
    activateExtension: async (id) => {
      activations.push(id);
    },
    executeCommand: async <T>(command: string, ...args: unknown[]): Promise<T> => {
      calls.push({ command, args });
      options.behaviour?.(command);
      return undefined as T;
    },
  };
  return { bridge: createLanguageServerBridge(environment), calls, activations };
}

test("uses the published mcppls extension id", () => {
  assert.equal(MCPPLS_EXTENSION_ID, "sunrisepeak.mcpp-language-server");
});

test("forwards one command per capability and activates the dependency first", async () => {
  const { bridge, calls, activations } = harness();

  assert.deepEqual(await bridge.restartLanguageServer(), {
    state: "completed",
    capabilityKey: "restartServer",
    command: "mcppls.restartServer",
  });
  await bridge.selectContext();
  await bridge.showModuleGraph();
  await bridge.showLanguageServerLogs();
  await bridge.restartEngine();
  await bridge.resetWorkspaceCache();
  await bridge.collectReport();
  await bridge.exportDiagnosticBundle();
  await bridge.runBuildToolInTerminal();
  await bridge.installCommandLineTools();

  assert.deepEqual(calls.map((call) => call.command), [
    "mcppls.restartServer",
    "mcppls.selectContext",
    "mcppls.showModuleGraph",
    "mcppls.showLogs",
    "mcppls.restartClangd",
    "mcppls.resetWorkspaceCache",
    "mcppls.collectReport",
    "mcppls.exportDiagnosticBundle",
    "mcppls.runBuildToolInTerminal",
    "mcppls.installCommandLineTools",
  ]);
  assert.equal(activations.length, 10);
  assert.ok(activations.every((id) => id === MCPPLS_EXTENSION_ID));
});

test("the refresh capability prefers the cheap reload", async () => {
  const { bridge, calls } = harness();
  const result = await bridge.refreshLanguageServerAfterBuild();
  assert.deepEqual(result, {
    state: "completed",
    capabilityKey: "refresh",
    command: "mcppls.reloadBuildDescription",
  });
  assert.deepEqual(calls.map((call) => call.command), ["mcppls.reloadBuildDescription"]);
});

test("an uninstalled dependency yields unavailable without calling anything", async () => {
  const { bridge, calls } = harness({ installed: false });
  assert.deepEqual(await bridge.restartLanguageServer(), {
    state: "unavailable",
    capabilityKey: "restartServer",
  });
  assert.equal(bridge.isGone("restartServer"), true);
  assert.deepEqual(calls, []);
});

test("a failure is reported verbatim and does not remove the capability", async () => {
  const { bridge } = harness({
    behaviour: () => {
      throw new Error("server is not running");
    },
  });
  const result = await bridge.restartLanguageServer();
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /server is not running/);
  assert.equal(bridge.isGone("restartServer"), false);
});

test("a missing command is not called again", async () => {
  const { bridge, calls } = harness({
    behaviour: (command) => {
      throw new Error(`command '${command}' not found`);
    },
  });
  const first = await bridge.showModuleGraph();
  assert.equal(first.state, "missing");
  assert.equal(bridge.isGone("moduleGraph"), true);
  const second = await bridge.showModuleGraph();
  assert.equal(second.state, "missing");
  assert.equal(calls.length, 1);
});

test("coalesces concurrent build refresh requests into one call", async () => {
  let release: (() => void) | undefined;
  const calls: string[] = [];
  const bridge = createLanguageServerBridge({
    extensionInstalled: () => true,
    declaredCommands: () => undefined,
    executeCommand: async <T>(command: string): Promise<T> => {
      calls.push(command);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return undefined as T;
    },
  });

  const first = bridge.refreshLanguageServerAfterBuild();
  const second = bridge.refreshLanguageServerAfterBuild();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["mcppls.reloadBuildDescription"]);
  release?.();
  assert.equal((await first).state, "completed");
  assert.equal((await second).state, "completed");
  assert.deepEqual(calls, ["mcppls.reloadBuildDescription"]);
});

test("directional commands pass their argument through", async () => {
  const { bridge, calls } = harness();
  await bridge.manageConflicts(true);
  await bridge.toggleInWorkspace(false);
  await bridge.reviewChanges(true);
  assert.deepEqual(calls, [
    { command: "mcppls.turnOffOtherCppFeatures", args: [true] },
    { command: "mcppls.turnOffInWorkspace", args: [false] },
    { command: "mcppls.review.run", args: [true] },
  ]);
});

test("the danger level comes from the capability table", () => {
  const { bridge } = harness();
  assert.equal(bridge.dangerOf("resetCache"), "destructive");
  assert.equal(bridge.dangerOf("restartEngine"), "confirm");
  assert.equal(bridge.dangerOf("selectContext"), "none");
  assert.equal(bridge.dangerOf("nope"), "none");
});
