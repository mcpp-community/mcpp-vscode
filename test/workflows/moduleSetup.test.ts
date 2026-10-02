import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModuleSetupPlan,
  executeModuleSetup,
  moduleSetupConfirmation,
  type ModuleSetupOperations,
  type ModuleSetupStepResult,
} from "../../src/workflows/moduleSetup";

test("只信任且不忙时可开始一键配置", () => {
  assert.deepEqual(buildModuleSetupPlan(true, false), { kind: "ready" });
  assert.deepEqual(buildModuleSetupPlan(false, false), { kind: "blocked", reason: "untrusted" });
  assert.deepEqual(buildModuleSetupPlan(true, true), { kind: "blocked", reason: "busy" });
});

test("确认文案不再要求切换 LLVM、下载 llvm-tools 或配置 clangd", () => {
  const confirmation = moduleSetupConfirmation();
  assert.match(confirmation.message, /构建.*刷新 C\+\+ 模块语言服务/);
  assert.match(confirmation.detail, /mcpp build/);
  assert.match(confirmation.detail, /C\+\+ Modules/);
  assert.doesNotMatch(confirmation.detail, /LLVM|llvm-tools/i);
  assert.doesNotMatch(confirmation.detail, /配置 clangd/i);
});

test("成功路径严格执行 build 后刷新语言服务", async () => {
  const calls: string[] = [];
  const operations: ModuleSetupOperations = {
    build: async () => {
      calls.push("build");
      return { stage: "build", state: "succeeded" };
    },
    refreshLanguageServer: async () => {
      calls.push("language-server");
      return { stage: "language-server", state: "succeeded" };
    },
  };

  const decision = buildModuleSetupPlan(true, false);
  assert.equal(decision.kind, "ready");
  if (decision.kind !== "ready") return;
  const outcome = await executeModuleSetup(decision, operations);
  assert.deepEqual(outcome, { state: "succeeded", degraded: false, steps: [
    { stage: "build", state: "succeeded" },
    { stage: "language-server", state: "succeeded" },
  ] });
  assert.deepEqual(calls, ["build", "language-server"]);
});

test("build 失败但未取消时仍刷新已有语言服务描述", async () => {
  const calls: string[] = [];
  const decision = buildModuleSetupPlan(true, false);
  assert.equal(decision.kind, "ready");
  if (decision.kind !== "ready") return;
  const outcome = await executeModuleSetup(decision, {
    build: async () => {
      calls.push("build");
      return { stage: "build", state: "failed", exitCode: 2 };
    },
    refreshLanguageServer: async () => {
      calls.push("language-server");
      return { stage: "language-server", state: "succeeded" };
    },
  });

  assert.equal(outcome.state, "succeeded");
  if (outcome.state === "succeeded") assert.equal(outcome.degraded, true);
  assert.deepEqual(calls, ["build", "language-server"]);
});

test("build 取消后不刷新语言服务", async () => {
  const calls: string[] = [];
  const decision = buildModuleSetupPlan(true, false);
  assert.equal(decision.kind, "ready");
  if (decision.kind !== "ready") return;
  const outcome = await executeModuleSetup(decision, {
    build: async () => {
      calls.push("build");
      return { stage: "build", state: "cancelled" };
    },
    refreshLanguageServer: async () => {
      calls.push("language-server");
      return { stage: "build", state: "succeeded" };
    },
  });

  assert.equal(outcome.state, "cancelled");
  assert.equal(outcome.stage, "build");
  assert.deepEqual(calls, ["build"]);
});

test("build 未启动时不刷新语言服务", async () => {
  const calls: string[] = [];
  const decision = buildModuleSetupPlan(true, false);
  assert.equal(decision.kind, "ready");
  if (decision.kind !== "ready") return;
  const outcome = await executeModuleSetup(decision, {
    build: async () => {
      calls.push("build");
      return { stage: "build", state: "not-started", detail: "未启动 mcpp 构建。" };
    },
    refreshLanguageServer: async () => {
      calls.push("language-server");
      return { stage: "language-server", state: "succeeded" };
    },
  });
  assert.equal(outcome.state, "failed");
  if (outcome.state === "failed") assert.equal(outcome.stage, "build");
  assert.deepEqual(calls, ["build"]);
});

test("语言服务依赖缺失时不伪装成成功", async () => {
  const result: ModuleSetupStepResult = {
    stage: "language-server",
    state: "failed",
    detail: "C++ 模块语言服务依赖未安装或已禁用。",
  };
  const decision = buildModuleSetupPlan(true, false);
  assert.equal(decision.kind, "ready");
  if (decision.kind !== "ready") return;
  const outcome = await executeModuleSetup(decision, {
    build: async () => ({ stage: "build", state: "succeeded" }),
    refreshLanguageServer: async () => result,
  });

  assert.equal(outcome.state, "failed");
  if (outcome.state === "failed") assert.equal(outcome.stage, "language-server");
  assert.deepEqual(outcome.steps, [
    { stage: "build", state: "succeeded" },
    result,
  ]);
});
