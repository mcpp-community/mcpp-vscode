export type ModuleSetupStage = "build" | "language-server";
export type ModuleSetupStepState = "succeeded" | "failed" | "cancelled" | "not-started";
export type ModuleSetupBlockedReason = "untrusted" | "busy";

export type ModuleSetupDecision =
  | { kind: "ready" }
  | { kind: "blocked"; reason: ModuleSetupBlockedReason };

export function buildModuleSetupPlan(
  trusted: boolean,
  busy: boolean,
): ModuleSetupDecision {
  if (!trusted) {
    return { kind: "blocked", reason: "untrusted" };
  }
  if (busy) {
    return { kind: "blocked", reason: "busy" };
  }
  return { kind: "ready" };
}

export interface ModuleSetupConfirmation {
  message: string;
  detail: string;
}

export function moduleSetupConfirmation(): ModuleSetupConfirmation {
  return {
    message: "是否构建当前 mcpp 工程并刷新 C++ 模块语言服务？",
    detail: "将执行 mcpp build，并由 C++ Modules 扩展重新读取构建描述；不会修改工具链、mcpp.toml 或任何语言服务设置。",
  };
}

export interface ModuleSetupStepResult {
  stage: ModuleSetupStage;
  state: ModuleSetupStepState;
  detail?: string;
  exitCode?: number;
}

export interface ModuleSetupOperations {
  build(): Promise<ModuleSetupStepResult>;
  refreshLanguageServer(): Promise<ModuleSetupStepResult>;
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
  _decision: Extract<ModuleSetupDecision, { kind: "ready" }>,
  operations: ModuleSetupOperations,
): Promise<ModuleSetupOutcome> {
  const steps: ModuleSetupStepResult[] = [];
  const buildResult = await operations.build();
  steps.push(buildResult);
  if (buildResult.state === "cancelled" || buildResult.state === "not-started") {
    return stoppedOutcome(buildResult, steps);
  }

  const languageServerResult = await operations.refreshLanguageServer();
  steps.push(languageServerResult);
  if (languageServerResult.state !== "succeeded") {
    return stoppedOutcome(languageServerResult, steps);
  }

  return {
    state: "succeeded",
    degraded: buildResult.state === "failed",
    steps,
  };
}
