import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyExit,
  diagnosticCodeIn,
  explainHint,
  hasUsableOutput,
} from "../../src/cli/errors";

test("退出码契约表 0/1/2/4/70/127", () => {
  assert.deepEqual(classifyExit(0), { kind: "none", exitCode: 0 });
  assert.deepEqual(classifyExit(1), { kind: "failed", exitCode: 1 });
  assert.deepEqual(classifyExit(2), { kind: "usage", exitCode: 2 });
  assert.deepEqual(classifyExit(4), { kind: "environment", exitCode: 4 });
  assert.deepEqual(classifyExit(70), { kind: "internal", exitCode: 70 });
  assert.deepEqual(classifyExit(127), { kind: "unknown-command", exitCode: 127 });
  assert.deepEqual(classifyExit(127, ["frobnicate"]), { kind: "unknown-command", exitCode: 127 });
  assert.equal(classifyExit(1).detail, undefined);
  assert.equal(classifyExit(1).diagnosticCode, undefined);
});

test("101 只对 mcpp run 是构建失败", () => {
  assert.deepEqual(classifyExit(101, ["run"]), { kind: "build-failed", exitCode: 101 });
  assert.deepEqual(classifyExit(101, ["run", "--", "arg"]), { kind: "build-failed", exitCode: 101 });
  assert.deepEqual(classifyExit(101, ["build"]), { kind: "failed", exitCode: 101 });
  assert.deepEqual(classifyExit(101, ["emit", "build-database"]), { kind: "failed", exitCode: 101 });
  assert.deepEqual(classifyExit(101, ["toolchain", "list"]), { kind: "failed", exitCode: 101 });
  assert.deepEqual(classifyExit(101), { kind: "failed", exitCode: 101 });
});

test("没有退出码（spawn 失败或取消）是 cancelled", () => {
  assert.deepEqual(classifyExit(undefined), { kind: "cancelled", exitCode: -1 });
  assert.deepEqual(classifyExit(undefined, ["build"]), { kind: "cancelled", exitCode: -1 });
  assert.deepEqual(classifyExit(-1), { kind: "cancelled", exitCode: -1 });
  assert.deepEqual(classifyExit(-15), { kind: "cancelled", exitCode: -1 });
});

test("契约之外的退出码回退为 failed", () => {
  // `mcpp run` 透传被运行程序的退出码（0–124）
  assert.deepEqual(classifyExit(3, ["run"]), { kind: "failed", exitCode: 3 });
  assert.deepEqual(classifyExit(124, ["run"]), { kind: "failed", exitCode: 124 });
  assert.deepEqual(classifyExit(130), { kind: "failed", exitCode: 130 });
});

test("diagnosticCodeIn 只认大写的 MCPP_ 错误码", () => {
  const line = "error: cannot download the toolchain [MCPP_OFFLINE_DOWNLOAD_REQUIRED]";
  assert.equal(diagnosticCodeIn(line), "MCPP_OFFLINE_DOWNLOAD_REQUIRED");
  assert.equal(
    diagnosticCodeIn("note: MCPP_CACHE_STALE; run mcpp cache gc"),
    "MCPP_CACHE_STALE",
  );

  assert.equal(diagnosticCodeIn("error: mcpp_offline_download_required"), undefined);
  assert.equal(diagnosticCodeIn("the word offline is not a code"), undefined);
  assert.equal(diagnosticCodeIn("MCPP_ alone is not a code"), undefined);
  assert.equal(diagnosticCodeIn("MCPP_lower is not a code"), undefined);
  assert.equal(diagnosticCodeIn("XMCPP_FAKE is not a code"), undefined);
  assert.equal(diagnosticCodeIn(""), undefined);
});

test("hasUsableOutput 抢救 emit build-database 的部分失败输出", () => {
  const envelope = JSON.stringify({
    schemaVersion: 1,
    kind: "mcpp.build-database",
    kindVersion: 1,
    mcpp: { version: "2026.9.30.2", protocol: { min: 1, max: 1 } },
    data: { watch: [], records: [] },
    diagnostics: [
      { code: "MCPP_DEP_RESOLVE_FAILED", severity: "error", message: "1 of 6 records left out" },
    ],
    effects: [],
  });

  const partial = classifyExit(1, ["emit", "build-database"]);
  assert.equal(hasUsableOutput(partial, envelope), true);
  assert.equal(hasUsableOutput(partial, `${envelope}\n`), true);
  // 裸 --json 文档（没有信封）同样可用
  assert.equal(hasUsableOutput(partial, '{"entries":[]}'), true);
  assert.equal(hasUsableOutput(partial, '[{"dir":"/tmp/x"}]'), true);

  assert.equal(hasUsableOutput(partial, ""), false);
  assert.equal(hasUsableOutput(partial, "   "), false);
  assert.equal(hasUsableOutput(partial, "error: dependency resolution failed\n"), false);
  assert.equal(hasUsableOutput(classifyExit(4, ["build"]), "mcpp: environment not ready"), false);
  assert.equal(hasUsableOutput(classifyExit(undefined, ["build"]), ""), false);

  // 成功时没有需要抢救的输出
  assert.equal(hasUsableOutput(classifyExit(0, ["emit", "build-database"]), envelope), false);
});

test("explainHint 给出 mcpp self explain 命令", () => {
  const withCode = classifyExit(1, ["build"]);
  withCode.diagnosticCode = "MCPP_OFFLINE_DOWNLOAD_REQUIRED";
  assert.equal(explainHint(withCode), "mcpp self explain MCPP_OFFLINE_DOWNLOAD_REQUIRED");

  const fromDetail = classifyExit(4, ["build"]);
  fromDetail.detail = "error: environment not ready [MCPP_TOOLCHAIN_MISSING]";
  assert.equal(explainHint(fromDetail), "mcpp self explain MCPP_TOOLCHAIN_MISSING");

  assert.equal(explainHint(classifyExit(2, ["build"])), undefined);
  const withNoise = classifyExit(1, ["build"]);
  withNoise.detail = "error: build failed";
  assert.equal(explainHint(withNoise), undefined);
});
