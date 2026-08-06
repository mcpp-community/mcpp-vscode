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
  project: unknown | undefined;
  contextValues: Map<string, boolean>;
  changeListeners: Array<() => void>;
  disposed: boolean;
}

function fakeEnvironment(project?: unknown): { env: InProjectEnvironment; state: FakeState } {
  const state: FakeState = {
    project,
    contextValues: new Map(),
    changeListeners: [],
    disposed: false,
  };
  const env: InProjectEnvironment = {
    currentProject: () => state.project,
    setContextValue: (key, value) => {
      state.contextValues.set(key, value);
      return Promise.resolve();
    },
    subscribe: (listener) => {
      state.changeListeners.push(listener);
      return [{
        dispose: () => {
          state.disposed = true;
        },
      }];
    },
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

test("sets the context key to true when the active resource resolves to an mcpp project", async () => {
  const { env, state } = fakeEnvironment({ root: "/work/A" });
  const result = await updateInProjectContext(env);
  assert.equal(result, true);
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), true);
});

test("sets the context key to false when the active resource has no mcpp project", async () => {
  const { env, state } = fakeEnvironment();
  const result = await updateInProjectContext(env);
  assert.equal(result, false);
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), false);
});

test("writes the context on registration and owns the change subscriptions", async () => {
  const { env, state } = fakeEnvironment({ root: "/work/A" });
  const registration = registerInProjectContext(env);
  await flushAsync();
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), true);
  assert.equal(state.changeListeners.length, 1);

  registration.dispose();
  assert.equal(state.disposed, true);
});

test("re-evaluates the context when the active project changes", async () => {
  const { env, state } = fakeEnvironment();
  registerInProjectContext(env);
  await flushAsync();
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), false);

  state.project = { root: "/work/A" };
  for (const listener of state.changeListeners) {
    listener();
  }
  await flushAsync();
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), true);

  state.project = undefined;
  for (const listener of state.changeListeners) {
    listener();
  }
  await flushAsync();
  assert.equal(state.contextValues.get(IN_PROJECT_CONTEXT_KEY), false);
});
