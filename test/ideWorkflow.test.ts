import assert from "node:assert/strict";
import test from "node:test";

import { ensureIdeConfigured } from "../src/ideWorkflow";

const success = { exitCode: 0, stdout: "Configured 1 compile command", stderr: "" };

test("configures a trusted project before clangd when the CDB is missing", async () => {
  let calls = 0;
  const outcome = await ensureIdeConfigured({
    projectRoot: "/work/app",
    compilationDatabasePath: "/work/app/compile_commands.json",
    trusted: true,
    databaseValid: () => calls > 0,
    configure: async () => {
      calls += 1;
      return success;
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(outcome, {
    state: "configured",
    compileCommands: "/work/app/compile_commands.json",
  });
});

test("keeps a valid existing CDB without invoking mcpp", async () => {
  let called = false;
  const outcome = await ensureIdeConfigured({
    projectRoot: "/work/app",
    compilationDatabasePath: "/work/app/compile_commands.json",
    trusted: true,
    databaseValid: () => true,
    configure: async () => {
      called = true;
      throw new Error("must not run");
    },
  });

  assert.equal(called, false);
  assert.deepEqual(outcome, {
    state: "existing",
    compileCommands: "/work/app/compile_commands.json",
  });
});

test("does not execute mcpp in an untrusted workspace", async () => {
  let called = false;
  const outcome = await ensureIdeConfigured({
    projectRoot: "/work/app",
    compilationDatabasePath: "/work/app/compile_commands.json",
    trusted: false,
    databaseValid: () => false,
    configure: async () => {
      called = true;
      throw new Error("must not run");
    },
  });

  assert.equal(called, false);
  assert.deepEqual(outcome, { state: "untrusted" });
});

test("retains an existing CDB when forced configure-only fails", async () => {
  let called = false;
  const outcome = await ensureIdeConfigured({
    projectRoot: "/work/app",
    compilationDatabasePath: "/work/app/compile_commands.json",
    trusted: true,
    force: true,
    databaseValid: () => true,
    configure: async () => {
      called = true;
      return { exitCode: 1, stdout: "compile failed", stderr: "" };
    },
  });

  assert.equal(called, true);
  assert.deepEqual(outcome, {
    state: "failed",
    compileCommands: "/work/app/compile_commands.json",
    exitCode: 1,
  });
});

test("requires a valid CDB after configure-only succeeds", async () => {
  const outcome = await ensureIdeConfigured({
    projectRoot: "/work/app",
    compilationDatabasePath: "/work/app/compile_commands.json",
    trusted: true,
    databaseValid: () => false,
    configure: async () => success,
  });

  assert.deepEqual(outcome, { state: "failed", exitCode: 0 });
});

test("force refresh invokes configure-only when a CDB already exists", async () => {
  let calls = 0;
  const outcome = await ensureIdeConfigured({
    projectRoot: "/work/app",
    compilationDatabasePath: "/work/app/compile_commands.json",
    trusted: true,
    force: true,
    databaseValid: () => true,
    configure: async () => {
      calls += 1;
      return success;
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(outcome, {
    state: "configured",
    compileCommands: "/work/app/compile_commands.json",
  });
});
