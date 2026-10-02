/**
 * Cleanup, as plans rather than as calls.
 *
 * Every destructive action this extension can run is described here: the exact
 * argv, how much confirmation it needs, and whether a preview must be shown
 * first. Keeping it in one pure table means the UI cannot invent a sixth level
 * of danger, and the tests can assert the policy instead of the wording.
 *
 * The policy (from the plan, §3.4.3):
 *
 * | level | what | confirmation |
 * |---|---|---|
 * | 0 | read-only (`cache list`/`dir`/`info`/`verify`) | none |
 * | 1 | project body (`mcpp clean`) | modal, with the measured size |
 * | 2 | budget/targeted (`cache gc`, `cache prune`, `cache clean --deps/--std`) | preview, then modal |
 * | 3 | everything (`cache clean --all`) | preview, modal, then a second acknowledgement |
 *
 * The user asked for `cache clean --all` to be reachable — so it is — but it is
 * the only level-3 action, and its text names every project on the machine.
 */

export type CleanAction =
  | "project"
  | "stale"
  | "cacheGc"
  | "cachePrune"
  | "cacheDeps"
  | "cacheStd"
  | "cacheAll"
  | "cacheLegacy"
  | "cacheVerify"
  | "cacheList";

export interface CleanOptions {
  /** `mcpp clean --stale --older-than <n>d`; 0 means "keep none". */
  staleDays?: number;
  /** `mcpp cache gc --max-size <n>GiB`; 0 means "the user types a budget". */
  budgetGiB?: number;
  /** `mcpp cache prune --older-than <n>d`. */
  pruneAgeDays?: number;
}

export interface CleanPlan {
  action: CleanAction;
  /** The mcpp subcommand, for logging: `clean` or `cache`. */
  group: "clean" | "cache";
  argv: readonly string[];
  /** 0 read-only, 1 modal, 2 preview+modal, 3 preview+modal+acknowledge. */
  level: 0 | 1 | 2 | 3;
  /** A `--dry-run`-style pass the UI must show before asking. */
  preview: boolean;
  /** A second, explicit acknowledgement (a checkbox) is required. */
  acknowledge: boolean;
  /** English key for the dialogue title. */
  titleKey: string;
  /** English key for the body; the caller adds the measured figures. */
  detailKey: string;
  /** This action is refused when the workspace is untrusted. */
  requiresTrust: boolean;
}

function staleDaysOf(options: CleanOptions): number {
  const days = options.staleDays ?? 3;
  return Number.isFinite(days) ? Math.max(0, Math.round(days)) : 3;
}

export function planClean(action: CleanAction, options: CleanOptions = {}): CleanPlan {
  switch (action) {
    case "project":
      return {
        action,
        group: "clean",
        argv: ["clean"],
        level: 1,
        preview: false,
        acknowledge: false,
        titleKey: "Remove the whole target/ directory?",
        detailKey: "This deletes every build directory of this project. The next build starts from scratch. The shared build cache is not touched.",
        requiresTrust: true,
      };
    case "stale":
      return {
        action,
        group: "clean",
        argv: ["clean", "--stale", "--older-than", `${staleDaysOf(options)}d`],
        level: 2,
        preview: true,
        acknowledge: false,
        titleKey: "Remove build directories mcpp no longer considers current?",
        detailKey: "Directories written in the last {0} day(s) are kept. mcpp decides which ones are stale; the preview above is its own list.",
        requiresTrust: true,
      };
    case "cacheGc": {
      const budget = options.budgetGiB ?? 0;
      const argv = budget > 0 ? ["cache", "gc", "--max-size", `${budget}GiB`] : ["cache", "gc"];
      return {
        action,
        group: "cache",
        argv,
        level: 2,
        preview: true,
        acknowledge: false,
        titleKey: "Collect the shared build cache to a budget?",
        detailKey: "mcpp drops least-recently-used entries until the cache fits. Projects that used a dropped entry rebuild it.",
        requiresTrust: true,
      };
    }
    case "cachePrune": {
      const days = options.pruneAgeDays ?? 30;
      return {
        action,
        group: "cache",
        argv: ["cache", "prune", "--older-than", `${Number.isFinite(days) ? Math.max(1, Math.round(days)) : 30}d`],
        level: 2,
        preview: true,
        acknowledge: false,
        titleKey: "Drop cache entries that have not been used for a while?",
        detailKey: "Entries unused for longer than {0} day(s) are removed. Projects that used one rebuild it.",
        requiresTrust: true,
      };
    }
    case "cacheDeps":
      return {
        action,
        group: "cache",
        argv: ["cache", "clean", "--deps"],
        level: 2,
        preview: true,
        acknowledge: false,
        titleKey: "Drop every package entry from the shared cache?",
        detailKey: "Every mcpp project on this machine rebuilds its dependencies afterwards. Standard library module entries are kept.",
        requiresTrust: true,
      };
    case "cacheStd":
      return {
        action,
        group: "cache",
        argv: ["cache", "clean", "--std"],
        level: 2,
        preview: true,
        acknowledge: false,
        titleKey: "Drop every standard library module entry from the shared cache?",
        detailKey: "Every mcpp project on this machine re-prepares the standard library module afterwards. Package entries are kept.",
        requiresTrust: true,
      };
    case "cacheAll":
      return {
        action,
        group: "cache",
        argv: ["cache", "clean", "--all"],
        level: 3,
        preview: true,
        acknowledge: true,
        titleKey: "Drop the entire shared build cache?",
        detailKey: "Package and standard library entries go. Every mcpp project on this machine rebuilds from scratch afterwards.",
        requiresTrust: true,
      };
    case "cacheLegacy":
      return {
        action,
        group: "cache",
        argv: ["cache", "clean", "--legacy"],
        level: 2,
        preview: false,
        acknowledge: false,
        titleKey: "Remove the unused pre-v1 cache?",
        detailKey: "mcpp no longer reads $MCPP_HOME/bmi. Nothing is rebuilt because nothing uses it.",
        requiresTrust: true,
      };
    case "cacheVerify":
      return {
        action,
        group: "cache",
        argv: ["cache", "verify"],
        level: 0,
        preview: false,
        acknowledge: false,
        titleKey: "Verify the shared build cache",
        detailKey: "Every entry's manifest is checked against the files on disk.",
        requiresTrust: true,
      };
    default:
      return {
        action: "cacheList",
        group: "cache",
        argv: ["cache", "list", "--format", "json"],
        level: 0,
        preview: false,
        acknowledge: false,
        titleKey: "Read the shared build cache",
        detailKey: "Nothing is removed.",
        requiresTrust: true,
      };
  }
}

/** True when `mcpp clean`'s global cache also goes — the option the UI keeps un-ticked. */
export function withSharedCache(plan: CleanPlan): CleanPlan {
  if (plan.action !== "project") {
    return plan;
  }
  return {
    ...plan,
    argv: [...plan.argv, "--bmi-cache"],
    level: 3,
    acknowledge: true,
    detailKey: "This also empties the shared build cache, so every mcpp project on this machine rebuilds from scratch.",
  };
}

/** The single destructive action that may be shortened to one confirmation. */
export function planProblems(): string[] {
  const problems: string[] = [];
  const actions: CleanAction[] = [
    "project",
    "stale",
    "cacheGc",
    "cachePrune",
    "cacheDeps",
    "cacheStd",
    "cacheAll",
    "cacheLegacy",
    "cacheVerify",
    "cacheList",
  ];
  for (const action of actions) {
    const plan = planClean(action);
    if (plan.requiresTrust === false) {
      problems.push(`${action} does not require a trusted workspace`);
    }
    if (plan.level >= 2 && !plan.preview && plan.action !== "cacheLegacy") {
      problems.push(`${action} must be previewed before it runs`);
    }
    if (plan.level === 3 && !plan.acknowledge) {
      problems.push(`${action} must require a second acknowledgement`);
    }
    if (plan.argv.some((part) => part.includes(" "))) {
      problems.push(`${action} passes an argument containing a space`);
    }
  }
  return problems;
}
