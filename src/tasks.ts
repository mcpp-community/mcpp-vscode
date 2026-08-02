export type ProjectTaskKind = "build" | "run" | "test" | "clean";
export type TaskState = "succeeded" | "failed" | "cancelled";

export interface ProjectTaskPlan {
  kind: ProjectTaskKind;
  title: string;
  args: string[];
}

export interface TaskCompletion {
  state: TaskState;
  exitCode?: number;
}

const TASK_TITLES: Record<ProjectTaskKind, string> = {
  build: "mcpp: 构建",
  run: "mcpp: 运行",
  test: "mcpp: 测试",
  clean: "mcpp: 清理",
};

export function projectTaskPlan(kind: ProjectTaskKind): ProjectTaskPlan {
  return {
    kind,
    title: TASK_TITLES[kind],
    args: [kind],
  };
}

export function shouldReconcileAfterTask(
  _kind: ProjectTaskKind,
  completion?: TaskCompletion,
): boolean {
  return completion?.state !== "cancelled";
}

export function classifyTaskExit(exitCode: number | undefined): TaskCompletion {
  if (exitCode === undefined) {
    return { state: "cancelled" };
  }
  if (exitCode === 0) {
    return { state: "succeeded", exitCode };
  }
  return { state: "failed", exitCode };
}

export class McppOperationRegistry<T> {
  private readonly projectTokens = new Map<string, T>();

  private globalToken: T | undefined;

  beginProject(projectRoot: string, token: T): T | undefined {
    const active = this.projectTokens.get(projectRoot) ?? this.globalToken;
    if (active !== undefined) {
      return active;
    }
    this.projectTokens.set(projectRoot, token);
    return undefined;
  }

  finishProject(projectRoot: string, token: T): void {
    if (this.projectTokens.get(projectRoot) === token) {
      this.projectTokens.delete(projectRoot);
    }
  }

  beginGlobal(token: T): T | undefined {
    const activeProject = this.projectTokens.values().next().value as T | undefined;
    if (this.globalToken !== undefined) {
      return this.globalToken;
    }
    if (activeProject !== undefined) {
      return activeProject;
    }
    this.globalToken = token;
    return undefined;
  }

  finishGlobal(token: T): void {
    if (this.globalToken === token) {
      this.globalToken = undefined;
    }
  }

  public hasActive(): boolean {
    return this.projectTokens.size > 0 || this.globalToken !== undefined;
  }
}
