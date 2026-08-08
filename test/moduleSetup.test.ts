import assert from "node:assert/strict";
import test from "node:test";

import type { ToolchainInventory, ToolchainItem } from "../src/cli";
import {
  buildModuleSetupPlan,
  executeModuleSetup,
  mcppModuleSetupCommands,
  moduleSetupConfirmation,
  type ModuleSetupDecision,
  type ModuleSetupOperations,
  type ModuleSetupStage,
  type ModuleSetupStepResult,
  type ModuleSetupStepState,
} from "../src/moduleSetup";

function toolchain(family: string, effective = false): ToolchainItem {
  return {
    family,
    version: "1.0.0",
    spec: `${family}@1.0.0`,
    source: "managed",
    effective,
  };
}

function inventory(
  overrides: Partial<ToolchainInventory> = {},
): ToolchainInventory {
  return {
    installed: [],
    available: [],
    targets: [],
    effective: undefined,
    effectiveTarget: undefined,
    globalDefaultSpec: undefined,
    projectOverridesGlobal: false,
    recognized: true,
    rawOutput: "",
    ...overrides,
  };
}

function ready(decision: ModuleSetupDecision): Extract<ModuleSetupDecision, { kind: "ready" }> {
  if (decision.kind !== "ready") {
    assert.fail(`expected ready plan, got ${decision.reason}`);
  }
  return decision;
}

test("GCC 生效且没有已安装的 host LLVM 时计划安装并切换默认工具链", () => {
  const gcc = toolchain("gcc", true);
  const plan = buildModuleSetupPlan(
    inventory({ installed: [gcc], effective: gcc }),
    "unavailable",
    true,
    false,
  );

  assert.deepEqual(plan, {
    kind: "ready",
    installLlvm: true,
    switchDefault: true,
  });
});

test("已安装 host LLVM 但 GCC 生效时只切换默认工具链", () => {
  const gcc = toolchain("gcc", true);
  const llvm = toolchain("llvm");
  const plan = buildModuleSetupPlan(
    inventory({ installed: [gcc, llvm], effective: gcc }),
    "syntax-only",
    true,
    false,
  );

  assert.deepEqual(plan, {
    kind: "ready",
    installLlvm: false,
    switchDefault: true,
  });
});

test("LLVM 已生效时不重复安装或切换", () => {
  const llvm = toolchain("llvm", true);
  const plan = buildModuleSetupPlan(
    inventory({ installed: [llvm], effective: llvm }),
    "full",
    true,
    false,
  );

  assert.deepEqual(plan, {
    kind: "ready",
    installLlvm: false,
    switchDefault: false,
  });
});

test("没有 effective 工具链时不推断需要切换全局默认", () => {
  const plan = buildModuleSetupPlan(
    inventory(),
    "unavailable",
    true,
    false,
  );

  assert.deepEqual(plan, {
    kind: "ready",
    installLlvm: true,
    switchDefault: false,
  });
});

test("available LLVM 不算已安装的 host 工具链", () => {
  const gcc = toolchain("gcc", true);
  const availableLlvm = toolchain("llvm");
  const plan = buildModuleSetupPlan(
    inventory({ installed: [gcc], available: [availableLlvm], effective: gcc }),
    "syntax-only",
    true,
    false,
  );

  assert.equal(ready(plan).installLlvm, true);
});

test("只有 target payload 的 LLVM 不算可设为默认的 host 工具链", () => {
  const gcc = toolchain("gcc", true);
  const llvm = toolchain("llvm");
  const plan = buildModuleSetupPlan(
    inventory({
      installed: [gcc, llvm],
      effective: gcc,
      targets: [{
        target: "x86_64-linux-musl",
        note: "static",
        toolchainSpec: llvm.spec,
        status: "installed",
        effective: false,
      }],
    }),
    "syntax-only",
    true,
    false,
  );

  assert.equal(ready(plan).installLlvm, true);
});

test("项目显式固定非 LLVM 时阻止修改全局默认", () => {
  const gcc = toolchain("gcc", true);
  const plan = buildModuleSetupPlan(
    inventory({
      installed: [gcc],
      effective: gcc,
      projectOverridesGlobal: true,
    }),
    "syntax-only",
    true,
    false,
  );

  assert.deepEqual(plan, {
    kind: "blocked",
    reason: "project-toolchain-override",
  });
});

test("项目显式固定 LLVM 时仍允许继续配置", () => {
  const llvm = toolchain("llvm", true);
  const plan = buildModuleSetupPlan(
    inventory({
      installed: [llvm],
      effective: llvm,
      projectOverridesGlobal: true,
    }),
    "full",
    true,
    false,
  );

  assert.deepEqual(plan, {
    kind: "ready",
    installLlvm: false,
    switchDefault: false,
  });
});

test("阻止原因按未信任、未知清单、忙碌、项目覆盖的顺序判定", () => {
  const gcc = toolchain("gcc", true);
  const conflicting = inventory({
    installed: [gcc],
    effective: gcc,
    projectOverridesGlobal: true,
    recognized: false,
  });

  assert.deepEqual(
    buildModuleSetupPlan(conflicting, "unavailable", false, true),
    { kind: "blocked", reason: "untrusted" },
  );
  assert.deepEqual(
    buildModuleSetupPlan(conflicting, "unavailable", true, true),
    { kind: "blocked", reason: "unrecognized-inventory" },
  );
  assert.deepEqual(
    buildModuleSetupPlan({ ...conflicting, recognized: true }, "unavailable", true, true),
    { kind: "blocked", reason: "busy" },
  );
});

test("模块设置命令使用固定 argv 数组且始终构建", () => {
  assert.deepEqual(
    mcppModuleSetupCommands({ kind: "ready", installLlvm: true, switchDefault: true }),
    [
      { stage: "install", mode: "process", args: ["toolchain", "install", "llvm"] },
      { stage: "default", mode: "process", args: ["toolchain", "default", "llvm"] },
      { stage: "build", mode: "task", args: ["build"] },
    ],
  );
  assert.deepEqual(
    mcppModuleSetupCommands({ kind: "ready", installLlvm: false, switchDefault: false }),
    [{ stage: "build", mode: "task", args: ["build"] }],
  );
});

test("确认文案按能力解释现状并完整说明副作用边界", () => {
  const plan = { kind: "ready", installLlvm: true, switchDefault: true } as const;
  const confirmations = [
    moduleSetupConfirmation("full", plan),
    moduleSetupConfirmation("syntax-only", plan),
    moduleSetupConfirmation("unavailable", plan),
  ];

  assert.match(confirmations[0].message, /模块代码提示/);
  assert.match(confirmations[1].message, /语法高亮/);
  assert.match(confirmations[2].message, /编译数据库/);
  assert.equal(new Set(confirmations.map((item) => item.message)).size, 3);
  for (const confirmation of confirmations) {
    assert.match(confirmation.detail, /LLVM\/llvm-tools/);
    assert.match(confirmation.detail, /全局默认/);
    assert.match(confirmation.detail, /不会编辑项目.*mcpp\.toml/);
  }
});

test("确认文案说明将复用已安装的 LLVM", () => {
  const confirmation = moduleSetupConfirmation(
    "syntax-only",
    { kind: "ready", installLlvm: false, switchDefault: true },
  );

  assert.match(confirmation.detail, /将复用已安装的 LLVM/);
  assert.match(confirmation.detail, /补齐配套组件时仍可能下载 LLVM\/llvm-tools/);
});

test("确认文案在无需切换时明确不修改全局默认值", () => {
  const plan = ready(buildModuleSetupPlan(inventory(), "unavailable", true, false));
  const confirmation = moduleSetupConfirmation(
    "unavailable",
    plan,
  );

  assert.match(confirmation.detail, /不会修改全局默认工具链/);
  assert.doesNotMatch(confirmation.detail, /设为全局默认工具链/);
  assert.doesNotMatch(confirmation.detail, /当前 LLVM 已生效/);
});

interface OperationFixture {
  calls: ModuleSetupStage[];
  operations: ModuleSetupOperations;
}

function result(stage: ModuleSetupStage, state: ModuleSetupStepState): ModuleSetupStepResult {
  return { stage, state };
}

function operationsWith(
  states: Partial<Record<ModuleSetupStage, ModuleSetupStepState>> = {},
): OperationFixture {
  const calls: ModuleSetupStage[] = [];
  const run = async (stage: ModuleSetupStage): Promise<ModuleSetupStepResult> => {
    calls.push(stage);
    return result(stage, states[stage] ?? "succeeded");
  };

  return {
    calls,
    operations: {
      prepare: async (command: { stage: ModuleSetupStage }) => run(command.stage),
      reload: async () => run("reload"),
      ensureClangd: async () => run("clangd"),
      checkModules: async () => run("check"),
    },
  };
}

test("成功流程严格按安装、默认、构建、重载、clangd、检查执行", async () => {
  const fixture = operationsWith();
  const outcome = await executeModuleSetup(
    { kind: "ready", installLlvm: true, switchDefault: true },
    fixture.operations,
  );

  assert.deepEqual(fixture.calls, ["install", "default", "build", "reload", "clangd", "check"]);
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.degraded, false);
  assert.deepEqual(
    outcome.steps.map((step: ModuleSetupStepResult) => step.stage),
    fixture.calls,
  );
});

test("安装或默认步骤取消、失败后立即停止", async () => {
  const cases: Array<{
    stage: "install" | "default";
    state: "cancelled" | "failed";
    plan: Extract<ModuleSetupDecision, { kind: "ready" }>;
    expectedCalls: ModuleSetupStage[];
  }> = [
    {
      stage: "install",
      state: "cancelled",
      plan: { kind: "ready", installLlvm: true, switchDefault: true },
      expectedCalls: ["install"],
    },
    {
      stage: "install",
      state: "failed",
      plan: { kind: "ready", installLlvm: true, switchDefault: true },
      expectedCalls: ["install"],
    },
    {
      stage: "default",
      state: "cancelled",
      plan: { kind: "ready", installLlvm: false, switchDefault: true },
      expectedCalls: ["default"],
    },
    {
      stage: "default",
      state: "failed",
      plan: { kind: "ready", installLlvm: false, switchDefault: true },
      expectedCalls: ["default"],
    },
  ];

  for (const item of cases) {
    const fixture = operationsWith({ [item.stage]: item.state });
    const outcome = await executeModuleSetup(item.plan, fixture.operations);
    assert.deepEqual(fixture.calls, item.expectedCalls);
    assert.equal(outcome.state, item.state);
    assert.equal(outcome.degraded, false);
    assert.equal(outcome.stage, item.stage);
  }
});

test("构建取消后停止，构建失败则尝试后续恢复", async () => {
  const fixture = operationsWith({ build: "cancelled" });
  const outcome = await executeModuleSetup(
    { kind: "ready", installLlvm: false, switchDefault: false },
    fixture.operations,
  );

  assert.deepEqual(fixture.calls, ["build"]);
  assert.equal(outcome.state, "cancelled");
  assert.equal(outcome.degraded, false);
});

test("构建失败后的重载失败会终止恢复流程", async () => {
  const fixture = operationsWith({ build: "failed", reload: "failed" });
  const outcome = await executeModuleSetup(
    { kind: "ready", installLlvm: false, switchDefault: false },
    fixture.operations,
  );

  assert.deepEqual(fixture.calls, ["build", "reload"]);
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.degraded, false);
  assert.equal(outcome.stage, "reload");
});

test("构建失败但 IDE 恢复链成功时返回降级成功", async () => {
  const fixture = operationsWith({ build: "failed" });
  const outcome = await executeModuleSetup(
    { kind: "ready", installLlvm: false, switchDefault: false },
    fixture.operations,
  );

  assert.deepEqual(fixture.calls, ["build", "reload", "clangd", "check"]);
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.degraded, true);
});

test("clangd 失败后不检查模块", async () => {
  const fixture = operationsWith({ clangd: "failed" });
  const outcome = await executeModuleSetup(
    { kind: "ready", installLlvm: false, switchDefault: false },
    fixture.operations,
  );

  assert.deepEqual(fixture.calls, ["build", "reload", "clangd"]);
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.stage, "clangd");
});

test("模块检查失败时返回检查阶段", async () => {
  const fixture = operationsWith({ check: "failed" });
  const outcome = await executeModuleSetup(
    { kind: "ready", installLlvm: false, switchDefault: false },
    fixture.operations,
  );

  assert.deepEqual(fixture.calls, ["build", "reload", "clangd", "check"]);
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.stage, "check");
});
