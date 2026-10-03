/**
 * The cache view and every cleanup command.
 *
 * The view is a sidebar **WebviewView** (`mcpp.cache`, plan §8.1): the numbers
 * and the bars live in one document whose host is `src/cache/cachePanel.ts`, and
 * whose structure is the pure `src/cache/cachePanelHtml.ts`. This file owns the
 * data behind it, the status item, the auto-refresh timer and the commands.
 *
 * The *policy* — which argv, how much confirmation, whether a preview is shown —
 * lives in `src/cli/clean.ts` and is unit-tested there. This file only asks the
 * user, runs the command and reports the result, so the safety rules cannot be
 * edited by accident in a UI change.
 *
 * Nothing here removes anything by itself: every destructive path goes through
 * `planClean`, a preview when the plan asks for one, and a modal.
 *
 * Four settings shape this file:
 *
 * - `mcpp.cache.showLegacy` decides whether the pre-v1 cache is measured and
 *   offered at all (`src/cache/cacheState.ts`, §8 G6);
 * - `mcpp.cache.warnAboveGiB` adds a warning when the shared cache is large;
 * - `mcpp.cache.autoRefreshSeconds` re-reads while the view is on screen;
 * - `mcpp.cache.gc.confirmAboveGiB` adds one confirmation level to a large `gc`.
 */

import * as vscode from "vscode";

import { estimateArtifacts, measureDirectory, type ArtifactEstimate } from "../cli/artifacts";
import { parseCacheDir, parseCacheList, summarizeCache, type CacheInventory, type CacheEntry } from "../cli/cache";
import { planClean, withSharedCache, type CleanPlan } from "../cli/clean";
import { runMcpp, type ProcessResult } from "../cli/process";
import { CACHE_COMMANDS } from "../commands/ids";
import { read } from "../config/access";
import { format as formatMessage, t } from "../i18n/t";
import { PollTimer } from "../mcppls/timers";
import type { McppProjectDiscovery } from "../projects/discovery";
import { formatBytes, projectGc } from "../util/format";
import { clampOutput } from "../util/text";
import {
  cacheSnapshotFrom,
  gcBudgetDialog,
  gcBudgetNeedsExtraConfirm,
  legacyForPanel,
  refreshTimerDecision,
  type CacheSnapshot,
} from "./cacheState";
import {
  CACHE_VIEW_ID,
  CACHE_VIEW_FOCUS_COMMAND,
  registerCachePanel,
  type CachePanelData,
  type CachePanelProvider,
} from "./cachePanel";

export { CACHE_VIEW_ID, CACHE_VIEW_FOCUS_COMMAND };

/** The tick granularity; `mcpp.cache.autoRefreshSeconds` is in seconds. */
const REFRESH_TICK_MS = 100;

/** The pre-v1 walk is a courtesy figure, so it gets a smaller budget than `target/`. */
const LEGACY_MAX_ENTRIES = 20_000;

/** `mcpp.runtime.timeoutSeconds`, or the built-in default when it is 0. */
function queryTimeoutMs(): number | undefined {
  const seconds = read<number>("mcpp.runtime.timeoutSeconds");
  return seconds > 0 ? seconds * 1000 : 60_000;
}
const CLEAN_TIMEOUT_MS = 300_000;

export interface CacheViewDeps {
  output: vscode.OutputChannel;
  currentProject: () => McppProjectDiscovery | undefined;
  mcppExecutable: (project: McppProjectDiscovery | undefined) => string;
  isTrusted: () => boolean;
}

/** What `mcpp cache dir` reported about the pre-v1 cache, measured or not. */
interface LegacyCache {
  path?: string;
  bytes?: number;
  files?: number;
  truncated?: boolean;
}

interface CacheState {
  entries: CacheEntry[];
  inventory?: CacheInventory;
  artifacts?: ArtifactEstimate;
  legacy?: LegacyCache;
  error?: string;
}

function workingDirectory(project: McppProjectDiscovery | undefined): string | undefined {
  return project?.root;
}

/** Unix seconds -> an ISO instant the panel can print; the panel does not do dates. */
function timestamp(seconds: number | undefined): string | undefined {
  return seconds === undefined || !Number.isFinite(seconds) ? undefined : new Date(seconds * 1000).toISOString();
}

function numberFormat(): "binary" | "decimal" {
  return read<string>("mcpp.ui.numberFormat") === "decimal" ? "decimal" : "binary";
}

/**
 * `mcpp.cache.showLegacy`: the whole rule in one object, so the panel and the
 * self-check read the same answer.
 */
function legacyGate(settings: { showLegacy: boolean }, legacy: LegacyCache | undefined): {
  enabled: boolean;
  bytes?: number;
  files?: number;
  truncated?: boolean;
} {
  return {
    enabled: settings.showLegacy,
    bytes: legacy?.bytes,
    files: legacy?.files,
    truncated: legacy?.truncated,
  };
}

function viewSettings(): {
  topN: number;
  ageBoundaries: string[];
  showLegacy: boolean;
  warnAboveGiB: number;
  autoRefreshSeconds: number;
} {
  return {
    topN: Math.max(1, read<number>("mcpp.views.cache.topN")),
    ageBoundaries: read<string[]>("mcpp.views.cache.ageBuckets"),
    showLegacy: read<boolean>("mcpp.cache.showLegacy") !== false,
    warnAboveGiB: read<number>("mcpp.cache.warnAboveGiB"),
    autoRefreshSeconds: read<number>("mcpp.cache.autoRefreshSeconds"),
  };
}

async function appendResult(
  deps: CacheViewDeps,
  title: string,
  executable: string,
  argv: readonly string[],
  cwd: string | undefined,
  result: ProcessResult,
): Promise<void> {
  try {
    deps.output.appendLine(`\n[${new Date().toISOString()}] ${title}`);
    deps.output.appendLine(`$ ${[executable, ...argv].join(" ")}`);
    const stdout = clampOutput(result.stdout);
    const stderr = clampOutput(result.stderr);
    if (stdout.text.trim().length > 0) deps.output.appendLine(stdout.text.trimEnd());
    if (stderr.text.trim().length > 0) deps.output.appendLine(stderr.text.trimEnd());
    deps.output.appendLine(`[exit ${result.exitCode}]`);
  } catch {
    // The channel can already be gone during shutdown.
  }
}

async function run(
  deps: CacheViewDeps,
  project: McppProjectDiscovery | undefined,
  argv: readonly string[],
  options: { timeoutMs?: number; quiet?: boolean } = {},
): Promise<ProcessResult> {
  const executable = deps.mcppExecutable(project);
  const cwd = workingDirectory(project);
  const result = options.quiet === true
    ? await runMcpp(deps.isTrusted(), executable, [...argv], cwd, { timeoutMs: options.timeoutMs, maxBufferMiB: read<number>("mcpp.runtime.maxOutputMiB") })
    : await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `mcpp ${argv[0]}` },
        () => runMcpp(deps.isTrusted(), executable, [...argv], cwd, { timeoutMs: options.timeoutMs }),
      );
  if (result === undefined) {
    // The seam refuses in an untrusted workspace; the callers gate with their
    // own message, so this is the defensive shape of the same refusal.
    return { exitCode: 1, stdout: "", stderr: t("the workspace is not trusted") };
  }
  if (result.exitCode !== 0 || options.quiet !== true) {
    await appendResult(deps, `mcpp ${argv.join(" ")}`, executable, argv, cwd, result);
  }
  return result;
}

async function preview(title: string, content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    content: `# ${title}\n\n\`\`\`\n${content.trimEnd()}\n\`\`\`\n`,
    language: "markdown",
  });
  await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
}

/**
 * Ask for confirmation, honouring the plan's level. Level 3 asks twice: once as
 * a modal and once with an explicit acknowledgement, because that is the one
 * that reaches every project on the machine.
 */
async function confirmPlan(plan: CleanPlan, detail: string, figures: string): Promise<boolean> {
  const body = `${t(plan.detailKey, figures)}\n\n${detail}`;
  if (plan.level === 0) {
    return true;
  }
  const runLabel = t("Run");
  const choice = await vscode.window.showWarningMessage(
    t(plan.titleKey),
    { modal: true, detail: body },
    runLabel,
  );
  if (choice !== runLabel) {
    return false;
  }
  if (!plan.acknowledge) {
    return true;
  }
  const acknowledge = t("I understand this affects every mcpp project on this machine");
  const second = await vscode.window.showWarningMessage(
    t("Confirm once more"),
    { modal: true, detail: body },
    acknowledge,
  );
  return second === acknowledge;
}

/**
 * The extra level `mcpp.cache.gc.confirmAboveGiB` adds.
 *
 * It is asked *before* the plan's own modal, so a refused acknowledgement never
 * reaches the dialogue that would have run the command. It never replaces a
 * level: a plan that already demands an acknowledgement is not asked a third
 * time, and the plan's own modal still runs afterwards.
 *
 * The sentences live here rather than in `cacheState.ts` so
 * `tools/l10n-check.mjs` sees them as translation call literals; the decision and
 * the figure come from the pure module.
 */
export function extraGcConfirmation(
  plan: CleanPlan,
  budgetGiB: number,
  confirmAboveGiB: number,
): { title: string; detail: string; acknowledge: string; args: readonly (string | number)[] } | undefined {
  if (plan.action !== "cacheGc" || plan.acknowledge) {
    return undefined;
  }
  if (!gcBudgetNeedsExtraConfirm(budgetGiB, confirmAboveGiB)) {
    return undefined;
  }
  const dialog = gcBudgetDialog(budgetGiB, confirmAboveGiB);
  return {
    title: t("Confirm a cleanup this large"),
    detail: t(
      "This {0} GiB budget frees entries that every mcpp project on this machine shares. The cleanup can take a while, and any dropped entry is rebuilt on next use.",
    ),
    acknowledge: t("I understand this removes entries other mcpp projects may use"),
    args: dialog.args,
  };
}

/**
 * The cache view and its commands.
 *
 * Returns the sidebar provider it registered, so a caller that would rather own
 * the `registerWebviewViewProvider` call can register this value itself instead
 * (see `registerCachePanel`). Ignoring the return value is the normal case: the
 * view is registered here, and `extension.ts` needs no extra line.
 */
export function registerCacheView(context: vscode.ExtensionContext, deps: CacheViewDeps): CachePanelProvider {
  let state: CacheState = { entries: [] };
  /** Guards the interval: one refresh at a time, and none after a failure. */
  let refreshInFlight: Promise<void> | undefined;
  /**
   * The sidebar view. Assigned after the timer below is declared, because the
   * timer asks the provider whether the view is on screen; everything that reads
   * it does so long after `registerCacheView` has returned.
   */
  let provider: CachePanelProvider | undefined;
  const viewVisible = (): boolean => provider?.visible === true;

  // An optional, second status item. Off by default: the C++ Modules extension
  // already owns a status item, and the mcpp quick menu owns ours.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 39);
  // `mcpp.cache.focus` is registered by VS Code for the contributed view, so the
  // status item can bring the sidebar view on screen without a command of ours.
  status.command = CACHE_VIEW_FOCUS_COMMAND;
  context.subscriptions.push(status);

  const updateStatus = (): void => {
    if (!read<boolean>("mcpp.cache.statusBar")) {
      status.hide();
      return;
    }
    const total = state.inventory?.totalBytes;
    status.text = total === undefined ? "$(database) mcpp" : `$(database) ${formatBytes(total, numberFormat())}`;
    status.tooltip = t("Shared build cache");
    status.show();
  };

  const applyState = (next: CacheState): void => {
    state = next;
    setLastCacheSnapshot(
      next.inventory === undefined
        ? undefined
        : cacheSnapshotFrom({
            totalBytes: next.inventory.totalBytes,
            totalEntries: next.inventory.totalEntries,
            incomplete: next.inventory.incomplete.length,
          }),
    );
  };

  /**
   * Re-read everything the view shows. It deliberately does **not** redraw the
   * webview: the draw path (`CachePanelDeps.read` is `read` + `panelData`) calls
   * this first, and a redraw from inside here would ask itself for the same
   * figures again.
   */
  const refreshNow = async (): Promise<void> => {
    const project = deps.currentProject();
    const settings = viewSettings();
    const next: CacheState = { entries: [] };

    if (!deps.isTrusted()) {
      next.error = t("the workspace is not trusted");
      applyState(next);
      return;
    }

    const listed = await run(deps, project, ["cache", "list", "--format", "json"], {
      timeoutMs: queryTimeoutMs(),
      quiet: true,
    });
    if (listed.exitCode === 0) {
      const parsed = parseCacheList(listed.stdout);
      if (parsed === undefined) {
        next.error = t("mcpp cache list did not return the documented document");
      } else {
        next.entries = parsed.entries;
        next.inventory = summarizeCache(parsed.root, parsed.entries, {
          topN: settings.topN,
          ageBoundaries: settings.ageBoundaries,
        });
      }
    } else {
      next.error = t("mcpp cache list failed (exit {0})", listed.exitCode);
    }

    const dir = await run(deps, project, ["cache", "dir"], { timeoutMs: queryTimeoutMs(), quiet: true });
    if (dir.exitCode === 0) {
      const parsed = parseCacheDir(dir.stdout);
      // The pre-v1 directory is measured only when the setting offers it: a
      // user who turned `mcpp.cache.showLegacy` off pays for no walk at all.
      const measured =
        settings.showLegacy && parsed.legacyPath !== undefined
          ? measureDirectory(parsed.legacyPath, { maxEntries: LEGACY_MAX_ENTRIES })
          : undefined;
      next.legacy = {
        path: parsed.legacyPath,
        bytes: measured?.totalBytes,
        files: measured?.files,
        truncated: measured?.truncated !== undefined,
      };
    }

    if (project !== undefined && read<boolean>("mcpp.cache.estimateProjectBytes")) {
      next.artifacts = estimateArtifacts(project.root);
    }

    applyState(next);
    updateStatus();
  };

  /** Single-flight: an interval tick during a read must not start a second one. */
  const refresh = (): Promise<void> => {
    if (refreshInFlight !== undefined) {
      return refreshInFlight;
    }
    refreshInFlight = refreshNow().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  };

  /** The figures a confirmation dialogue needs, without running anything new. */
  const figures = (): string => {
    const total = state.inventory?.totalBytes;
    return total === undefined ? t("(size unknown)") : t("{0} in the shared cache", formatBytes(total));
  };

  const runPlan = async (project: McppProjectDiscovery | undefined, plan: CleanPlan, extra = ""): Promise<void> => {
    const detail = `${t("Command")}: mcpp ${plan.argv.join(" ")}${extra}`;
    if (!(await confirmPlan(plan, detail, figures()))) {
      return;
    }
    const result = await run(deps, project, plan.argv, { timeoutMs: CLEAN_TIMEOUT_MS });
    if (result.exitCode === 0) {
      await refresh();
      return;
    }
    void vscode.window.showErrorMessage(t("mcpp {0} failed with exit code {1}", plan.argv.join(" "), result.exitCode));
  };

  /** `runPlan` plus the one extra level `mcpp.cache.gc.confirmAboveGiB` adds. */
  const runGcPlan = async (
    project: McppProjectDiscovery | undefined,
    budgetGiB: number,
    extra: string,
  ): Promise<void> => {
    const plan = planClean("cacheGc", { budgetGiB });
    const dialog = extraGcConfirmation(plan, budgetGiB, read<number>("mcpp.cache.gc.confirmAboveGiB"));
    // The extra level is asked *before* the plan's own modal, so a refused
    // acknowledgement never reaches the one that would have run the command.
    // `extraGcConfirmation` already resolved the strings through `t()`.
    if (dialog !== undefined) {
      const choice = await vscode.window.showWarningMessage(
        dialog.title,
        { modal: true, detail: formatMessage(dialog.detail, dialog.args) },
        dialog.acknowledge,
      );
      if (choice !== dialog.acknowledge) {
        return;
      }
    }
    await runPlan(project, plan, extra);
  };

  const requireTrusted = (): boolean => {
    if (deps.isTrusted()) {
      return true;
    }
    void vscode.window.showWarningMessage(
      t("This workspace is not trusted. mcpp commands that write are disabled until you trust it."),
    );
    return false;
  };

  const register = (id: string, handler: (...args: unknown[]) => Promise<void>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.output.appendLine(`mcpp: ${message}`);
          void vscode.window.showErrorMessage(t("mcpp: {0}", message));
        }
      }),
    );
  };

  /** What the view shows, from the same state the commands use. Runs nothing. */
  const panelData = (): CachePanelData => {
    const inventory = state.inventory;
    const artifacts = state.artifacts;
    return {
      project: {
        available: artifacts !== undefined && artifacts.exists,
        note:
          artifacts === undefined
            ? t("Project artifacts could not be measured.")
            : artifacts.exists
              ? undefined
              : t("No target/ directory"),
        totalBytes: artifacts?.totalBytes ?? 0,
        files: artifacts?.files ?? 0,
        groups: artifacts?.byTopLevel.length ?? 0,
        truncated: artifacts?.truncated,
      },
      shared: {
        available: inventory !== undefined,
        note: inventory === undefined ? state.error ?? t("The shared build cache could not be read.") : undefined,
        root: inventory?.root,
        totalBytes: inventory?.totalBytes ?? 0,
        totalEntries: inventory?.totalEntries ?? 0,
        byKind: inventory?.byKind ?? [],
        buckets: inventory?.ageBuckets ?? [],
        top: (inventory?.topLabels ?? []).map((entry) => ({
          label: entry.label,
          entries: entry.entries,
          bytes: entry.bytes,
          oldestAccessed: entry.oldestAccessed,
        })),
        incomplete: inventory?.incomplete.length ?? 0,
        oldestAccessed: timestamp(inventory?.oldestAccessed),
        newestAccessed: timestamp(inventory?.newestAccessed),
      },
      legacy: legacyForPanel(legacyGate(viewSettings(), state.legacy), state.legacy?.path),
    };
  };

  // `mcpp.cache.autoRefreshSeconds`: re-read while the view is on screen, never
  // in an untrusted workspace, and never on top of a read that is still running.
  // The tick only redraws: the provider's own read path performs the refresh, so
  // one tick costs one round of queries.
  const timer = new PollTimer({
    periodMs: 0,
    tick: (): void => {
      if (viewVisible() && deps.isTrusted()) {
        provider?.refresh();
      }
    },
  });
  context.subscriptions.push(timer);
  const applyTimer = (): void => {
    const seconds = viewSettings().autoRefreshSeconds;
    const usable = deps.isTrusted() && Number.isFinite(seconds) && seconds > 0;
    const decision = refreshTimerDecision(usable ? seconds : 0, viewVisible());
    timer.start(decision.active ? decision.seconds * 1000 : 0);
  };
  applyTimer();

  // The sidebar webview view: `mcpp.cache` is a `"type": "webview"` view, so
  // this provider (not a tree) is what draws it. Every destructive action still
  // goes through `runPlan` above.
  provider = registerCachePanel(context, {
    refresh,
    read: panelData,
    run: async (message) => {
      const project = deps.currentProject();
      switch (message.type) {
        case "cleanStale":
          await runPlan(project, planClean("stale", { staleDays: read<number>("mcpp.cache.staleDays") }));
          return;
        case "cleanProject":
          await runPlan(project, planClean("project"));
          return;
        case "collect":
          await runGcPlan(project, message.budgetGiB, "");
          return;
        case "prune":
          await runPlan(project, planClean("cachePrune", { pruneAgeDays: read<number>("mcpp.cache.pruneAgeDays") }));
          return;
        case "cleanLegacy":
          await runPlan(project, planClean("cacheLegacy"));
          return;
        default:
          await run(deps, project, ["cache", "verify"], { timeoutMs: CLEAN_TIMEOUT_MS });
          return;
      }
    },
    showEntry: async (label) => {
      await vscode.commands.executeCommand(CACHE_COMMANDS.showEntry, label);
    },
    onVisibilityChanged: () => applyTimer(),
  });

  register(CACHE_COMMANDS.refreshStats, async () => {
    if (!requireTrusted()) return;
    await refresh();
    provider?.refresh();
  });

  register(CACHE_COMMANDS.showEntry, async (label) => {
    if (!requireTrusted()) return;
    if (typeof label !== "string" || label.length === 0) {
      return;
    }
    const project = deps.currentProject();
    const result = await run(deps, project, ["cache", "info", label], { timeoutMs: queryTimeoutMs(), quiet: true });
    await preview(t("Cache entry {0}", label), result.stdout.length > 0 ? result.stdout : result.stderr);
  });

  register(CACHE_COMMANDS.cleanStale, async () => {
    if (!requireTrusted()) return;
    const project = deps.currentProject();
    if (project === undefined) {
      void vscode.window.showWarningMessage(t("This workspace has no mcpp.toml."));
      return;
    }
    const plan = planClean("stale", { staleDays: read<number>("mcpp.cache.staleDays") });
    const dry = await run(deps, project, ["clean", "--dry-run"], { timeoutMs: CLEAN_TIMEOUT_MS, quiet: true });
    await preview(t("mcpp clean --dry-run"), dry.stdout.length > 0 ? dry.stdout : dry.stderr);
    await runPlan(project, plan);
  });

  register(CACHE_COMMANDS.cleanProject, async () => {
    if (!requireTrusted()) return;
    const project = deps.currentProject();
    if (project === undefined) {
      void vscode.window.showWarningMessage(t("This workspace has no mcpp.toml."));
      return;
    }
    const base = planClean("project");
    const alsoCache = t("Also empty the shared build cache");
    // `mcpp.task.confirmClean` answers the same question here as it does on the
    // task path. Turning it off skips only *this* modal: choosing to also empty
    // the shared cache still escalates through the plan's own level 3.
    const choice = read<boolean>("mcpp.task.confirmClean")
      ? await vscode.window.showWarningMessage(
          t(base.titleKey),
          { modal: true, detail: t(base.detailKey) },
          t("Run"),
          alsoCache,
        )
      : undefined;
    if (read<boolean>("mcpp.task.confirmClean") && choice === undefined) {
      return;
    }
    const plan = choice === alsoCache ? withSharedCache(base) : base;
    if (plan.acknowledge && choice === alsoCache) {
      const acknowledge = t("I understand this affects every mcpp project on this machine");
      const second = await vscode.window.showWarningMessage(
        t("Confirm once more"),
        { modal: true, detail: t(plan.detailKey) },
        acknowledge,
      );
      if (second !== acknowledge) {
        return;
      }
    }
    const result = await run(deps, project, plan.argv, { timeoutMs: CLEAN_TIMEOUT_MS });
    if (result.exitCode === 0) {
      await refresh();
    } else {
      void vscode.window.showErrorMessage(t("mcpp {0} failed with exit code {1}", plan.argv.join(" "), result.exitCode));
    }
  });

  register(CACHE_COMMANDS.collect, async () => {
    if (!requireTrusted()) return;
    const project = deps.currentProject();
    await refresh();
    const total = state.inventory?.totalBytes ?? 0;
    const suggested = read<number>("mcpp.cache.gc.defaultBudgetGiB") || Math.max(1, Math.round(total / 1024 ** 3 / 2));
    const input = await vscode.window.showInputBox({
      title: t("Keep the shared build cache under how many GiB?"),
      value: String(suggested),
      validateInput: (value) => (/^\d+$/.test(value.trim()) ? undefined : t("Enter a whole number of GiB")),
    });
    if (input === undefined) {
      return;
    }
    const budgetGiB = Number.parseInt(input.trim(), 10);
    // Local LRU projection: an estimate, offered so the budget is chosen with
    // numbers rather than guessed. mcpp's own policy decides in the end.
    const projection = projectGc(state.entries, budgetGiB * 1024 ** 3);
    const estimate =
      projection.removed.length === 0
        ? t("Already within {0} GiB.", budgetGiB)
        : t("About {0} would be freed ({1} entries).", formatBytes(projection.freedBytes), projection.removed.length);
    await runGcPlan(project, budgetGiB, `\n${estimate}`);
  });

  register(CACHE_COMMANDS.prune, async () => {
    if (!requireTrusted()) return;
    const project = deps.currentProject();
    await runPlan(project, planClean("cachePrune", { pruneAgeDays: read<number>("mcpp.cache.pruneAgeDays") }));
  });

  register(CACHE_COMMANDS.verify, async () => {
    if (!requireTrusted()) return;
    const project = deps.currentProject();
    const result = await run(deps, project, ["cache", "verify"], { timeoutMs: CLEAN_TIMEOUT_MS });
    if (result.exitCode === 0) {
      const text = `${result.stdout}\n${result.stderr}`.trim();
      await preview(t("Cache verification"), text.length === 0 ? t("Every entry matches its manifest.") : text);
    } else {
      void vscode.window.showErrorMessage(t("mcpp cache verify failed with exit code {0}", result.exitCode));
    }
  });

  register(CACHE_COMMANDS.cleanLegacy, async () => {
    if (!requireTrusted()) return;
    const project = deps.currentProject();
    await runPlan(project, planClean("cacheLegacy"));
  });

  // First paint: show what the settings allow without running anything heavy.
  if (deps.currentProject() !== undefined && read<boolean>("mcpp.cache.estimateProjectBytes")) {
    const project = deps.currentProject();
    if (project !== undefined) {
      state.artifacts = estimateArtifacts(project.root);
    }
  }
  provider.refresh();
  updateStatus();

  // Keep the view, the timer and the status item in step with the settings.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mcpp.views.cache") || event.affectsConfiguration("mcpp.cache") || event.affectsConfiguration("mcpp.ui.numberFormat")) {
        provider?.refresh();
        updateStatus();
        applyTimer();
      }
    }),
  );

  return provider;
}

// ── the self-check's cache snapshot (§8 G9) ──────────────────────────────────

/** A reading older than this is re-taken rather than reported as current. */
const SNAPSHOT_FRESH_MS = 60_000;

let lastSnapshot: { snapshot: CacheSnapshot; at: number } | undefined;

function setLastCacheSnapshot(snapshot: CacheSnapshot | undefined): void {
  lastSnapshot = snapshot === undefined ? undefined : { snapshot, at: Date.now() };
}

/** The configured `mcpp.path`, or `mcpp` — the same rule the CLI controller uses. */
function snapshotExecutable(): string {
  const configured = vscode.workspace.getConfiguration("mcpp").get<string>("path", "");
  return configured.trim().length === 0 ? "mcpp" : configured.trim();
}

/**
 * `showSelfCheck` calls this to fill `buildSelfCheckText`'s `cache` field.
 *
 * It runs the same read-only `mcpp cache list --format json` the cache view runs
 * and reuses that view's own aggregation, so the self-check and the view can
 * never disagree. A reading the view took less than a minute ago is reused, so
 * opening the self-check does not re-run a query for a number the user just saw.
 *
 * An untrusted workspace reuses the last reading and never runs `mcpp`; a
 * missing `mcpp`, a failed query or an unreadable document all return
 * `undefined`, which `buildSelfCheckText` renders as "not read".
 *
 * The one-line caller change is in the report:
 * `cache: await readCacheSnapshot(),` inside the `buildSelfCheckText` call.
 */
export async function readCacheSnapshot(): Promise<CacheSnapshot | undefined> {
  const cached = lastSnapshot;
  if (cached !== undefined && Date.now() - cached.at < SNAPSHOT_FRESH_MS) {
    return cached.snapshot;
  }
  if (!vscode.workspace.isTrusted) {
    return cached?.snapshot;
  }
  return readCacheSnapshotNow();
}

/**
 * Read regardless of what the view last showed: this is the query itself, kept
 * separate so a caller with an explicit reason to re-measure can ask for one.
 * Read-only, bounded, and never throws.
 */
export async function readCacheSnapshotNow(): Promise<CacheSnapshot | undefined> {
  try {
    const result = await runMcpp(vscode.workspace.isTrusted, snapshotExecutable(), ["cache", "list", "--format", "json"], undefined, {
      timeoutMs: queryTimeoutMs(),
      maxBufferMiB: read<number>("mcpp.runtime.maxOutputMiB"),
    });
    if (result === undefined || result.exitCode !== 0) {
      return undefined;
    }
    const parsed = parseCacheList(result.stdout);
    if (parsed === undefined) {
      return undefined;
    }
    const inventory = summarizeCache(parsed.root, parsed.entries, { topN: 0, ageBoundaries: [] });
    return cacheSnapshotFrom({
      totalBytes: inventory.totalBytes,
      totalEntries: inventory.totalEntries,
      incomplete: inventory.incomplete.length,
    });
  } catch {
    return undefined;
  }
}

