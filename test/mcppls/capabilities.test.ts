import assert from "node:assert/strict";
import test from "node:test";

import { MCPPLS_EXTENSION_ID } from "../../src/mcppls/contract";
import { CapabilityRegistry, classifyCommandError, type CapabilityEnvironment } from "../../src/mcppls/capabilities";

interface Harness {
  registry: CapabilityRegistry;
  calls: Array<{ command: string; args: unknown[] }>;
  activations: string[];
}

function harness(options: {
  installed?: boolean;
  declared?: readonly string[] | undefined;
  behaviour?: (command: string, attempt: number) => void;
} = {}): Harness {
  const installed = options.installed ?? true;
  const calls: Array<{ command: string; args: unknown[] }> = [];
  const activations: string[] = [];
  const attempts = new Map<string, number>();
  const environment: CapabilityEnvironment = {
    extensionInstalled: (id) => installed && id === MCPPLS_EXTENSION_ID,
    declaredCommands: () => options.declared,
    activateExtension: async (id) => {
      activations.push(id);
    },
    executeCommand: async <T>(command: string, ...args: unknown[]): Promise<T> => {
      calls.push({ command, args });
      const attempt = (attempts.get(command) ?? 0) + 1;
      attempts.set(command, attempt);
      options.behaviour?.(command, attempt);
      return undefined as T;
    },
  };
  return { registry: new CapabilityRegistry(environment), calls, activations };
}

const notFound = (command: string): never => {
  throw new Error(`command '${command}' not found`);
};

test("classifyCommandError separates a missing command from a real failure", () => {
  assert.equal(classifyCommandError(new Error("command 'mcppls.showLogs' not found")), "missing");
  assert.equal(classifyCommandError(new Error("Command not found")), "missing");
  assert.equal(classifyCommandError(new Error("not registered")), "missing");
  assert.equal(classifyCommandError(new Error("server is not running")), "failed");
  assert.equal(classifyCommandError("plain string"), "failed");
});

test("with no static information a capability is assumed usable until a call says otherwise", () => {
  const { registry, calls } = harness({ declared: undefined });
  assert.equal(registry.status("moduleGraph").state, "declared");
  assert.equal(registry.isGone("moduleGraph"), false);
  return registry.invoke("moduleGraph").then((result) => {
    assert.deepEqual(result, { state: "completed", capabilityKey: "moduleGraph", command: "mcppls.showModuleGraph" });
    assert.deepEqual(calls, [{ command: "mcppls.showModuleGraph", args: [] }]);
  });
});

test("a statically undeclared command is only greyed out, never hidden", () => {
  const { registry } = harness({ declared: ["mcppls.restartServer"] });
  assert.equal(registry.status("moduleGraph").state, "undeclared");
  assert.equal(registry.isUnconfirmed("moduleGraph"), true);
  assert.equal(registry.isGone("moduleGraph"), false);
});

test("an uninstalled dependency makes every capability unavailable without calling anything", async () => {
  const { registry, calls } = harness({ installed: false });
  assert.equal(registry.status("refresh").state, "unavailable");
  assert.equal(registry.isGone("refresh"), true);
  assert.deepEqual(await registry.invoke("refresh"), { state: "unavailable", capabilityKey: "refresh" });
  assert.deepEqual(calls, []);
});

test("refresh falls back down its candidate chain when the preferred command is missing", async () => {
  const { registry, calls } = harness({
    declared: undefined,
    behaviour: (command, attempt) => {
      if (command === "mcppls.reloadBuildDescription" && attempt === 1) {
        notFound(command);
      }
    },
  });
  const result = await registry.invoke("refresh");
  assert.deepEqual(result, { state: "completed", capabilityKey: "refresh", command: "mcppls.restartServer" });
  assert.deepEqual(calls.map((call) => call.command), [
    "mcppls.reloadBuildDescription",
    "mcppls.restartServer",
  ]);
  assert.equal(registry.status("refresh").state, "available");
});

test("a capability whose whole chain is missing is remembered as gone", async () => {
  const { registry, calls } = harness({
    declared: undefined,
    behaviour: (command) => notFound(command),
  });
  assert.deepEqual(await registry.invoke("refresh"), {
    state: "missing",
    capabilityKey: "refresh",
    command: "mcppls.reloadBuildDescription",
  });
  assert.equal(registry.status("refresh").state, "missing");
  assert.equal(registry.isGone("refresh"), true);
  assert.equal(calls.length, 2, "the chain is tried once, not forever");
});

test("a real failure keeps the capability and reports the error verbatim", async () => {
  const { registry } = harness({
    declared: undefined,
    behaviour: (command) => {
      throw new Error(`${command}: server is not running`);
    },
  });
  const result = await registry.invoke("logs");
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /server is not running/);
  assert.equal(registry.isGone("logs"), false);
});

test("the dependency is activated before the first forward", async () => {
  const { registry, activations } = harness({ declared: undefined });
  await registry.invoke("selectContext");
  assert.deepEqual(activations, [MCPPLS_EXTENSION_ID]);
});

test("invalidate re-reads the static declaration", () => {
  let declared: readonly string[] = [];
  const environment: CapabilityEnvironment = {
    extensionInstalled: () => true,
    declaredCommands: () => declared,
    executeCommand: async <T>(): Promise<T> => undefined as T,
  };
  const registry = new CapabilityRegistry(environment);
  assert.equal(registry.status("moduleGraph").state, "undeclared");
  declared = ["mcppls.showModuleGraph"];
  registry.invalidate();
  assert.equal(registry.status("moduleGraph").state, "declared");
  assert.ok(registry.availableKeys().includes("moduleGraph"));
});

test("readState is never probed by calling a command", () => {
  const { registry, calls } = harness({ declared: [] });
  assert.equal(registry.status("readState").state, "declared");
  assert.deepEqual(calls, []);
});

test("an unknown capability fails without touching the dependency", async () => {
  const { registry, calls } = harness();
  const result = await registry.invoke("nope");
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /unknown capability/);
  assert.deepEqual(calls, []);
});
