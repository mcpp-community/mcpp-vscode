import assert from "node:assert/strict";
import test from "node:test";

import {
  IN_PROJECT_CONTEXT_KEY,
  MCPP_MANIFEST_GLOB,
  registerInProjectContext,
  updateInProjectContext,
  type InProjectEnvironment,
} from "../src/inProject";

interface FakeState {
  manifests: unknown[];
  contextValues: Map<string, boolean>;
  createListeners: Array<() => void>;
  deleteListeners: Array<() => void>;
  watcherDisposed: boolean;
}

function fakeEnvironment(manifests: unknown[] = []): { env: InProjectEnvironment; state: FakeState } {
  const state: FakeState = {
    manifests: [...manifests],
    contextValues: new Map(),
    createListeners: [],
    deleteListeners: [],
    watcherDisposed: false,
  };
  const env: InProjectEnvironment = {
    findMcppManifests: () => Promise.resolve(state.manifests),
    setContextValue: (key, value) => {
      state.contextValues.set(key, value);
      return Promise.resolve();
    },
    createManifestWatcher: () => ({
      onDidCreate: (listener) => {
        state.createListeners.push(listener);
        return { dispose: () => undefined };
      },
      onDidDelete: (listener) => {
        state.deleteListeners.push(listener);
        return { dispose: () => undefined };
      },
      dispose: () => {
        state.watcherDisposed = true;
      },
    }),
  };
  return { env, state };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("exposes the fixed context key and manifest glob", () => {
  assert.equal(IN_PROJECT_CONTEXT_KEY, "mcpp.inProject");
  assert.equal(MCPP_MANIFEST_GLOB, "**/mcpp.toml");
});

test("sets the context key to true when an mcpp.toml exists", async () => {
  const { env, state } = fakeEnvironment(["/work/app/mcpp.toml"]);
  const result = await updateInProjectContext(env);
  assert.equal(result, true);
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), true);
});

test("sets the context key to false when no mcpp.toml exists", async () => {
  const { env, state } = fakeEnvironment();
  const result = await updateInProjectContext(env);
  assert.equal(result, false);
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), false);
});

test("writes the context on registration and owns the watcher lifecycle", async () => {
  const { env, state } = fakeEnvironment(["/work/app/mcpp.toml"]);
  const registration = registerInProjectContext(env);
  await flushAsync();
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), true);
  assert.equal(state.createListeners.length, 1);
  assert.equal(state.deleteListeners.length, 1);

  registration.dispose();
  assert.equal(state.watcherDisposed, true);
});

test("re-evaluates the context when mcpp.toml is created or deleted", async () => {
  const { env, state } = fakeEnvironment();
  registerInProjectContext(env);
  await flushAsync();
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), false);

  state.manifests.push("/work/app/mcpp.toml");
  for (const listener of state.createListeners) {
    listener();
  }
  await flushAsync();
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), true);

  state.manifests.length = 0;
  for (const listener of state.deleteListeners) {
    listener();
  }
  await flushAsync();
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), false);
});
