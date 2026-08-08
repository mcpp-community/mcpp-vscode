import { hostDefaultToolchains, type ToolchainInventory } from "./cli";

export type ModuleSetupStage = "install" | "default" | "build" | "reload" | "clangd" | "check";
export type ModuleSetupStepState = "succeeded" | "failed" | "cancelled";
export type ModuleSetupBlockedReason =
  | "untrusted"
  | "busy"
  | "project-toolchain-override"
  | "unrecognized-inventory";

export type ModuleSetupDecision =
  | {
    kind: "ready";
    installLlvm: boolean;
    switchDefault: boolean;
  }
  | {
    kind: "blocked";
    reason: ModuleSetupBlockedReason;
  };

type ModuleSetupPlan = Extract<ModuleSetupDecision, { kind: "ready" }>;
type ModuleCapability = "full" | "syntax-only" | "unavailable";

export function buildModuleSetupPlan(
  inventory: ToolchainInventory,
  _capability: ModuleCapability,
  trusted: boolean,
  busy: boolean,
): ModuleSetupDecision {
  if (!trusted) {
    return { kind: "blocked", reason: "untrusted" };
  }
  if (!inventory.recognized) {
    return { kind: "blocked", reason: "unrecognized-inventory" };
  }
  if (busy) {
    return { kind: "blocked", reason: "busy" };
  }

  const effectiveIsLlvm = inventory.effective?.family.toLowerCase() === "llvm";
  if (inventory.projectOverridesGlobal && inventory.effective !== undefined && !effectiveIsLlvm) {
    return { kind: "blocked", reason: "project-toolchain-override" };
  }

  // target-only payload 不能成为 host 默认工具链，因此必须复用现有筛选规则。
  const installedHostLlvm = hostDefaultToolchains(inventory)
    .some((toolchain) => toolchain.family.toLowerCase() === "llvm");
  return {
    kind: "ready",
    installLlvm: !installedHostLlvm,
    switchDefault: inventory.effective !== undefined && !effectiveIsLlvm,
  };
}

export interface ModuleSetupCommand {
  stage: "install" | "default" | "build";
  mode: "task" | "process";
  args: string[];
}

export function mcppModuleSetupCommands(plan: ModuleSetupPlan): ModuleSetupCommand[] {
  const commands: ModuleSetupCommand[] = [];
  if (plan.installLlvm) {
    commands.push({
      stage: "install",
      mode: "task",
      args: ["toolchain", "install", "llvm"],
    });
  }
  if (plan.switchDefault) {
    commands.push({
      stage: "default",
      mode: "process",
      args: ["toolchain", "default", "llvm"],
    });
  }
  commands.push({ stage: "build", mode: "task", args: ["build"] });
  return commands;
}

export interface ModuleSetupConfirmation {
  message: string;
  detail: string;
}

export function moduleSetupConfirmation(
  capability: ModuleCapability,
  plan: ModuleSetupPlan,
): ModuleSetupConfirmation {
  const message = capability === "full"
    ? "当前已具备 LLVM 模块能力，是否重新构建并配置模块代码提示？"
    : capability === "syntax-only"
      ? "当前仅提供模块语法高亮，是否切换到 LLVM 并配置模块代码提示？"
      : "当前缺少可用的模块编译数据库，是否配置 LLVM 并构建项目？";
  const installDetail = plan.installLlvm
    ? "流程可能下载 LLVM/llvm-tools"
    : "将复用已安装的 LLVM；补齐配套组件时仍可能下载 LLVM/llvm-tools";
  const defaultDetail = plan.switchDefault
    ? "并把 LLVM 设为全局默认工具链"
    : "不会修改全局默认工具链";
  return {
    message,
    detail: `${installDetail}，${defaultDetail}；不会编辑项目清单 mcpp.toml。`,
  };
}

export interface ModuleSetupStepResult {
  stage: ModuleSetupStage;
  state: ModuleSetupStepState;
  detail?: string;
  exitCode?: number;
}

export interface ModuleSetupOperations {
  prepare?: (command: ModuleSetupCommand) => Promise<ModuleSetupStepResult>;
  preparePlan?: () => Promise<ModuleSetupStepResult>;
  reload(): Promise<ModuleSetupStepResult>;
  ensureClangd(): Promise<ModuleSetupStepResult>;
  checkModules(): Promise<ModuleSetupStepResult>;
}

export type ModuleSetupOutcome =
  | {
    state: "succeeded";
    degraded: boolean;
    steps: ModuleSetupStepResult[];
  }
  | {
    state: "failed" | "cancelled";
    stage: ModuleSetupStage;
    degraded: false;
    steps: ModuleSetupStepResult[];
  };

function stoppedOutcome(
  result: ModuleSetupStepResult,
  steps: ModuleSetupStepResult[],
): Exclude<ModuleSetupOutcome, { state: "succeeded" }> {
  return {
    state: result.state === "cancelled" ? "cancelled" : "failed",
    stage: result.stage,
    degraded: false,
    steps,
  };
}

export async function executeModuleSetup(
  plan: ModuleSetupPlan,
  operations: ModuleSetupOperations,
): Promise<ModuleSetupOutcome> {
  const steps: ModuleSetupStepResult[] = [];
  let buildFailed = false;

  const commands = mcppModuleSetupCommands(plan);
  if (operations.preparePlan !== undefined) {
    const result = await operations.preparePlan();
    steps.push(result);
    if (result.state !== "succeeded") {
      if (result.stage === "build" && result.state === "failed") {
        buildFailed = true;
      } else {
        return stoppedOutcome(result, steps);
      }
    }
  } else {
    if (operations.prepare === undefined) {
      const firstCommand = commands[0];
      if (firstCommand === undefined) {
        return stoppedOutcome({ stage: "build", state: "failed" }, steps);
      }
      return stoppedOutcome({ stage: firstCommand.stage, state: "failed" }, steps);
    }
    for (const command of commands) {
      const result = await operations.prepare(command);
      steps.push(result);
      if (result.state === "succeeded") {
        continue;
      }
      if (command.stage === "build" && result.state === "failed") {
        buildFailed = true;
        break;
      }
      return stoppedOutcome(result, steps);
    }
  }

  // 构建失败后仍尝试恢复现有 CDB；只有完整恢复链成功才算降级成功。
  const recoveryOperations: Array<() => Promise<ModuleSetupStepResult>> = [
    () => operations.reload(),
    () => operations.ensureClangd(),
    () => operations.checkModules(),
  ];
  for (const operation of recoveryOperations) {
    const result = await operation();
    steps.push(result);
    if (result.state !== "succeeded") {
      return stoppedOutcome(result, steps);
    }
  }

  return {
    state: "succeeded",
    degraded: buildFailed,
    steps,
  };
}
