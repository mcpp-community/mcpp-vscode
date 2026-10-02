export const IN_PROJECT_CONTEXT_KEY = "mcpp.inProject";
export const MCPP_MANIFEST_GLOB = "**/mcpp.toml";

/**
 * `mcpp.task.editorTitleButtons`: the second half of the editor/title `when`
 * clause. `mcpp.inProject` says "this file belongs to an mcpp project"; this key
 * lets the user turn the Run/Test buttons off without hiding them for everyone.
 */
export const EDITOR_TITLE_BUTTONS_CONTEXT_KEY = "mcpp.editorTitleButtons";

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

export interface EditorTitleButtonsEnvironment {
  enabled(): boolean;
  setContextValue(key: string, value: boolean): PromiseLike<unknown>;
}

/**
 * Apply `mcpp.task.editorTitleButtons` to the context key `package.json` gates
 * the editor/title buttons with. The caller re-runs it on a configuration
 * change; like every other context write it is fire-and-forget.
 */
export async function updateEditorTitleButtonsContext(env: EditorTitleButtonsEnvironment): Promise<boolean> {
  const enabled = env.enabled();
  await env.setContextValue(EDITOR_TITLE_BUTTONS_CONTEXT_KEY, enabled);
  return enabled;
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
