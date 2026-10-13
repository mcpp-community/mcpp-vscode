/**
 * Which other C++ language services are serving next to C++ Modules, normalised.
 *
 * Pure, like `./state.ts`: no `vscode`, nothing here throws. Two sources:
 *
 * - **mcppls's own answer** (0.0.16+): `otherCppFeatures()` on the object its
 *   `activate()` returned. It uses the same candidate table and the same "is it
 *   active" decision as mcppls's own turn-off command, and it knows whether that
 *   command has something to restore. Preferred whenever it is there.
 * - **A local, read-only fallback** for an older mcppls: the same three
 *   candidates, read from the installed extensions and their settings. It can
 *   never know what mcppls remembered, so `canRestore` is `false`.
 *
 * Either way this extension only *reads*. Turning a service off or restoring it
 * is mcppls's command (`mcppls.turnOffOtherCppFeatures`, which asks where), and
 * the settings it writes are the other extensions' own, never `mcppls.*`.
 */

export interface OtherCppService {
  extensionId: string;
  displayName: string;
  /** `true` when a setting turns its language features off; `false` (ccls) means disabling the extension. */
  settable: boolean;
}

export interface OtherCppFeatures {
  active: OtherCppService[];
  /** mcppls remembers settings it changed and can put them back. */
  canRestore: boolean;
  /** Who answered: mcppls itself, or this extension's local read. */
  source: "mcppls" | "local";
}

/** A candidate the local read knows; `section`/`key`/`off` is how its language features are turned off. */
interface Candidate {
  extensionId: string;
  displayName: string;
  setting?: { section: string; key: string; off: unknown };
}

/** The same three mcppls checks (its `conflictCandidates.ts`), for when it cannot be asked. */
export const OTHER_CPP_CANDIDATES: readonly Candidate[] = [
  { extensionId: "ms-vscode.cpptools", displayName: "C/C++", setting: { section: "C_Cpp", key: "intelliSenseEngine", off: "disabled" } },
  { extensionId: "llvm-vs-code-extensions.vscode-clangd", displayName: "clangd", setting: { section: "clangd", key: "enable", off: false } },
  { extensionId: "ccls-project.ccls", displayName: "ccls" },
];

/** The settings whose change can make a candidate active or inactive. */
export const OTHER_CPP_SETTINGS: readonly string[] = OTHER_CPP_CANDIDATES.flatMap((candidate) =>
  candidate.setting === undefined ? [] : [`${candidate.setting.section}.${candidate.setting.key}`],
);

/**
 * The local read. `installed` answers for installed *and enabled* extensions
 * (`vscode.extensions.getExtension`); `value` is the effective setting.
 */
export function localOtherCppFeatures(
  installed: (extensionId: string) => boolean,
  value: (section: string, key: string) => unknown,
): OtherCppFeatures {
  const active = OTHER_CPP_CANDIDATES.filter(
    (candidate) =>
      installed(candidate.extensionId) &&
      (candidate.setting === undefined || value(candidate.setting.section, candidate.setting.key) !== candidate.setting.off),
  ).map((candidate) => ({
    extensionId: candidate.extensionId,
    displayName: candidate.displayName,
    settable: candidate.setting !== undefined,
  }));
  return { active, canRestore: false, source: "local" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function service(value: unknown): OtherCppService | undefined {
  if (!isRecord(value) || typeof value.extensionId !== "string" || value.extensionId.length === 0) {
    return undefined;
  }
  return {
    extensionId: value.extensionId,
    displayName: typeof value.displayName === "string" && value.displayName.length > 0 ? value.displayName : value.extensionId,
    settable: value.settable !== false,
  };
}

/**
 * mcppls's answer, or `undefined` when the object has no such function, it
 * throws, or what it returns has the wrong shape — the caller then reads locally.
 */
export function otherCppFeaturesFromExports(exportsValue: unknown): OtherCppFeatures | undefined {
  if (!isRecord(exportsValue) || typeof exportsValue.otherCppFeatures !== "function") {
    return undefined;
  }
  let answer: unknown;
  try {
    answer = (exportsValue.otherCppFeatures as () => unknown).call(exportsValue);
  } catch {
    return undefined;
  }
  if (!isRecord(answer) || !Array.isArray(answer.active)) {
    return undefined;
  }
  const active = answer.active.map(service).filter((entry): entry is OtherCppService => entry !== undefined);
  return { active, canRestore: answer.canRestore === true, source: "mcppls" };
}
