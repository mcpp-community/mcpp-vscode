export const IN_PROJECT_CONTEXT_KEY = "mcpp.inProject";
export const MCPP_MANIFEST_GLOB = "**/mcpp.toml";

export interface DisposableLike {
  dispose(): unknown;
}

export interface InProjectEnvironment {
  currentProject(): unknown | undefined;
  setContextValue(key: string, value: boolean): PromiseLike<unknown>;
  subscribe(listener: () => void): readonly DisposableLike[];
}

export async function updateInProjectContext(env: InProjectEnvironment): Promise<boolean> {
  const inProject = env.currentProject() !== undefined;
  await env.setContextValue(IN_PROJECT_CONTEXT_KEY, inProject);
  return inProject;
}

export function registerInProjectContext(env: InProjectEnvironment): { dispose(): unknown } {
  void updateInProjectContext(env);
  const disposables = env.subscribe(() => void updateInProjectContext(env));
  return {
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  };
}
