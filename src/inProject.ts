export const IN_PROJECT_CONTEXT_KEY = "mcpp.inProject";
export const MCPP_MANIFEST_GLOB = "**/mcpp.toml";

export interface FileSystemWatcherLike {
  onDidCreate(listener: () => void): { dispose(): unknown };
  onDidDelete(listener: () => void): { dispose(): unknown };
  dispose(): unknown;
}

export interface InProjectEnvironment {
  findMcppManifests(): PromiseLike<readonly unknown[]>;
  setContextValue(key: string, value: boolean): PromiseLike<unknown>;
  createManifestWatcher(): FileSystemWatcherLike;
}

export async function updateInProjectContext(env: InProjectEnvironment): Promise<boolean> {
  const manifests = await env.findMcppManifests();
  const inProject = manifests.length > 0;
  await env.setContextValue(IN_PROJECT_CONTEXT_KEY, inProject);
  return inProject;
}

export function registerInProjectContext(env: InProjectEnvironment): { dispose(): unknown } {
  void updateInProjectContext(env);
  const watcher = env.createManifestWatcher();
  const disposables = [
    watcher,
    watcher.onDidCreate(() => void updateInProjectContext(env)),
    watcher.onDidDelete(() => void updateInProjectContext(env)),
  ];
  return {
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  };
}
