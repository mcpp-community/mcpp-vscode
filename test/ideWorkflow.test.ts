import assert from "node:assert/strict";
import test from "node:test";

import { ensureIdeConfigured } from "../src/ideWorkflow";

test("configures a trusted project before build when the CDB is missing", async () => {
  let calls = 0;
  const outcome = await ensureIdeConfigured({
    projectRoot: "/work/app",
    compilationDatabasePath: "/work/app/compile_commands.json",
    trusted: true,
    databaseExists: () => false,
    configure: async () => {
      calls += 1;
      return {
        phase: "configured",
        compileCommands: "/work/app/.mcpp/ide/replies/compile_commands-cfg.json",
        compatibilityCompileCommands: "/work/app/compile_commands.json",
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome.state, "configured");
  assert.equal(outcome.compileCommands, "/work/app/compile_commands.json");
});

test("keeps an existing CDB without invoking mcpp", async () => {
  let called = false;
  const outcome = await ensureIdeConfigured({
    projectRoot: "/work/app",
    compilationDatabasePath: "/work/app/compile_commands.json",
    trusted: true,
    databaseExists: () => true,
    configure: async () => {
      called = true;
      throw new Error("must not run");
    },
  });

  assert.equal(called, false);
  assert.equal(outcome.state, "existing");
});

test("does not execute mcpp in an untrusted workspace", async () => {
  let called = false;
  const outcome = await ensureIdeConfigured({
    projectRoot: "/work/app",
    compilationDatabasePath: "/work/app/compile_commands.json",
    trusted: false,
    databaseExists: () => false,
    configure: async () => {
      called = true;
      throw new Error("must not run");
    },
  });

  assert.equal(called, false);
  assert.equal(outcome.state, "untrusted");
});

test("force refresh invokes configure even when a CDB already exists", async () => {
  let calls = 0;
  const outcome = await ensureIdeConfigured({
    projectRoot: "/work/app",
    compilationDatabasePath: "/work/app/compile_commands.json",
    trusted: true,
    force: true,
    databaseExists: () => true,
    configure: async () => {
      calls += 1;
      return { phase: "configured", compileCommands: "/work/app/compile_commands.json" };
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome.state, "configured");
});
