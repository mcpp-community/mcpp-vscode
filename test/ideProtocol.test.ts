import assert from "node:assert/strict";
import test from "node:test";

import { parseIdeConfigureOutput, runIdeConfigure } from "../src/ideProtocol";

test("parses configured snapshot without human-output regexes", () => {
  const result = parseIdeConfigureOutput([
    JSON.stringify({ seq: 1, type: "operation-started", operation: "configure" }),
    JSON.stringify({
      seq: 2,
      type: "snapshot-published",
      phase: "configured",
      compileCommands: "/work/.mcpp/ide/replies/compile_commands.json",
    }),
    JSON.stringify({ seq: 3, type: "operation-finished", status: "success" }),
  ].join("\n"));

  assert.equal(result.phase, "configured");
  assert.equal(result.compileCommands, "/work/.mcpp/ide/replies/compile_commands.json");
});

test("passes configure through the configured executable and cwd", async () => {
  const calls: Array<{ executable: string; args: string[]; cwd?: string }> = [];
  const result = await runIdeConfigure(
    "/work/app",
    "/tools/mcpp",
    async (executable, args, cwd) => {
      calls.push({ executable, args, cwd });
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ seq: 1, type: "operation-started" }),
          JSON.stringify({
            seq: 2,
            type: "snapshot-published",
            phase: "configured",
            compileCommands: "/work/app/compile_commands.json",
          }),
          JSON.stringify({ seq: 3, type: "operation-finished", status: "success" }),
        ].join("\n"),
        stderr: "",
      };
    },
  );

  assert.deepEqual(calls, [{
    executable: "/tools/mcpp",
    args: ["ide", "configure", "--format", "ndjson"],
    cwd: "/work/app",
  }]);
  assert.equal(result.compileCommands, "/work/app/compile_commands.json");
});

test("rejects a published snapshot without a successful finish event", () => {
  assert.throws(() => parseIdeConfigureOutput([
    JSON.stringify({ seq: 1, type: "operation-started", operation: "configure" }),
    JSON.stringify({
      seq: 2,
      type: "snapshot-published",
      phase: "configured",
      compileCommands: "/work/app/compile_commands.json",
    }),
    JSON.stringify({ seq: 3, type: "operation-finished", status: "failed" }),
  ].join("\n")), /未成功完成/);
});

test("rejects human-readable output mixed into NDJSON", () => {
  assert.throws(() => parseIdeConfigureOutput([
    JSON.stringify({ seq: 1, type: "operation-started" }),
    "c++fly on clang: enabled",
  ].join("\n")), /无效 JSON/);
});
