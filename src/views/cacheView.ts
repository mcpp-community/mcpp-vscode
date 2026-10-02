/**
 * The cache view and every cleanup command.
 *
 * The *policy* — which argv, how much confirmation, whether a preview is shown —
 * lives in `src/cli/clean.ts` and is unit-tested there. This file only asks the
 * user, runs the command and reports the result, so the safety rules cannot be
 * edited by accident in a UI change.
 *
 * Nothing here removes anything by itself: every destructive path goes through
 * `planClean`, a preview when the plan asks for one, and a modal.
 */

import * as vscode from "vscode";

import { estimateArtifacts, type ArtifactEstimate } from "../cli/artifacts";
import { parseCacheDir, parseCacheList, summarizeCache, type CacheInventory } from "../cli/cache";
import { planClean, withSharedCache, type CleanAction, type CleanPlan } from "../cli/clean";
import { runProcess, type ProcessResult } from "../cli/process";
import type { CacheEntry } from "../cli/cache";
import { CACHE_COMMANDS } from "../commands/ids";
import { read } from "../config/access";
import { t } from "../i18n/t";
import type { McppProjectDiscovery } from "../projects/discovery";
import { formatBytes, projectGc } from "../util/format";
import { clampOutput } from "../util/text";
import { buildCacheTree, type CacheTreeInput } from "./models";
import { registerTreeView } from "./treeProvider";
import { registerCachePanel, type CachePanelData } from "./cachePanel";

export const CACHE_VIEW_ID = "mcpp.cache";

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

interface CacheState {
  entries: CacheEntry[];
  inventory?: CacheInventory;
  artifacts?: ArtifactEstimate;
  legacyPath?: string;
  legacyBytes?: number;
  error?: string;
}

function workingDirectory(project: McppProjectDiscovery | undefined): string | undefined {
  return project?.root;
}

/** Settings that shape the numbers the view shows. */
/** Unix seconds -> an ISO instant the panel can print; the panel does not do dates. */
function timestamp(seconds: number | undefined): string | undefined {
  return seconds === undefined || !Number.isFinite(seconds) ? undefined : new Date(seconds * 1000).toISOString();
}

function numberFormat(): "binary" | "decimal" {
  return read<string>("mcpp.ui.numberFormat") === "decimal" ? "decimal" : "binary";
}

function viewSettings(): { topN: number; ageBoundaries: string[] } {
  return {
    topN: Math.max(1, read<number>("mcpp.views.cache.topN")),
    ageBoundaries: read<string[]>("mcpp.views.cache.ageBuckets"),
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
    ? await runProcess(executable, [...argv], cwd, { timeoutMs: options.timeoutMs, maxBufferMiB: read<number>("mcpp.runtime.maxOutputMiB") })
    : await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `mcpp ${argv[0]}` },
        () => runProcess(executable, [...argv], cwd, { timeoutMs: options.timeoutMs }),
      );
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

export function registerCacheView(context: vscode.ExtensionContext, deps: CacheViewDeps): void {
  let state: CacheState = { entries: [] };

  const treeInput = (): CacheTreeInput => {
    const settings = viewSettings();
    return {
      projectRoot: deps.currentProject()?.root,
      artifacts:
        state.artifacts === undefined
          ? undefined
          : {
              exists: state.artifacts.exists,
              totalBytes: state.artifacts.totalBytes,
              files: state.artifacts.files,
              groups: state.artifacts.byTopLevel.length,
              truncated: state.artifacts.truncated,
            },
      inventory:
        state.inventory === undefined
          ? undefined
          : {
              root: state.inventory.root,
              totalBytes: state.inventory.totalBytes,
              totalEntries: state.inventory.totalEntries,
              byKind: state.inventory.byKind,
              topLabels: state.inventory.topLabels,
              incomplete: state.inventory.incomplete.length,
              oldestAccessed: state.inventory.oldestAccessed,
              newestAccessed: state.inventory.newestAccessed,
              ageBuckets: state.inventory.ageBuckets,
            },
      legacyBytes: state.legacyBytes,
      error: state.error,
    };
  };

  const view = registerTreeView(CACHE_VIEW_ID, () => buildCacheTree(treeInput()));
  context.subscriptions.push(view.disposable);

  // An optional, second status item. Off by default: the C++ Modules extension
  // already owns a status item, and the mcpp quick menu owns ours.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 39);
  status.command = CACHE_COMMANDS.showPanel;
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

  const refresh = async (): Promise<void> => {
    const project = deps.currentProject();
    const settings = viewSettings();
    state = { entries: [] };

    if (!deps.isTrusted()) {
      state.error = t("the workspace is not trusted");
      view.provider.refresh();
      return;
    }

    const listed = await run(deps, project, ["cache", "list", "--format", "json"], {
      timeoutMs: queryTimeoutMs(),
      quiet: true,
    });
    if (listed.exitCode === 0) {
      const parsed = parseCacheList(listed.stdout);
      if (parsed === undefined) {
        state.error = t("mcpp cache list did not return the documented document");
      } else {
        state.entries = parsed.entries;
        state.inventory = summarizeCache(parsed.root, parsed.entries, {
          topN: settings.topN,
          ageBoundaries: settings.ageBoundaries,
        });
      }
    } else {
      state.error = t("mcpp cache list failed (exit {0})", listed.exitCode);
    }

    const dir = await run(deps, project, ["cache", "dir"], { timeoutMs: queryTimeoutMs(), quiet: true });
    if (dir.exitCode === 0) {
      const parsed = parseCacheDir(dir.stdout);
      state.legacyPath = parsed.legacyPath;
    }

    if (project !== undefined && read<boolean>("mcpp.cache.estimateProjectBytes")) {
      state.artifacts = estimateArtifacts(project.root);
    }

    view.provider.refresh();
    updateStatus();
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

  register(CACHE_COMMANDS.refreshStats, async () => {
    if (!requireTrusted()) return;
    await refresh();
  });

  /** What the panel shows, from the same state the tree uses. */
  const panelData = async (): Promise<CachePanelData> => {
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
      legacy: state.legacyPath === undefined ? undefined : { bytes: state.legacyBytes ?? 0, path: state.legacyPath },
    };
  };

  // `registerCachePanel` owns `mcpp.showCachePanel`; opening it refreshes first so
  // the panel never shows a stale figure.
  registerCachePanel(context, {
    read: async () => {
      if (deps.isTrusted()) {
        await refresh();
      }
      return panelData();
    },
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
          await runPlan(project, planClean("cacheGc", { budgetGiB: message.budgetGiB }));
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
    const runLabel = t("Run");
    const choice = await vscode.window.showWarningMessage(
      t(base.titleKey),
      { modal: true, detail: t(base.detailKey) },
      runLabel,
      alsoCache,
    );
    if (choice === undefined) {
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
    await runPlan(project, planClean("cacheGc", { budgetGiB }), `\n${estimate}`);
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
  view.provider.refresh();
  updateStatus();

  // Keep the tree and the status item in step with the settings that shape them.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mcpp.views.cache") || event.affectsConfiguration("mcpp.cache") || event.affectsConfiguration("mcpp.ui.numberFormat")) {
        view.provider.refresh();
        updateStatus();
      }
    }),
  );
}

/** The panel's text form; the webview panel is a later milestone. */
export function cacheSummaryText(input: CacheTreeInput): string {
  const lines: string[] = [];
  const artifacts = input.artifacts;
  lines.push(`## ${t("Project artifacts")}`);
  if (artifacts === undefined) {
    lines.push(`- ${t("Not measured yet")}`);
  } else if (!artifacts.exists) {
    lines.push(`- ${t("No target/ directory")}`);
  } else {
    lines.push(`- ${t("Estimated size")}: ${artifacts.totalBytes} B · ${artifacts.files} file(s) · ${artifacts.groups} group(s)`);
  }
  const inventory = input.inventory;
  lines.push("");
  lines.push(`## ${t("Global build cache")}`);
  if (inventory === undefined) {
    lines.push(`- ${input.error ?? t("not read yet")}`);
  } else {
    lines.push(`- ${inventory.totalEntries} entries · ${inventory.totalBytes} B`);
    for (const kind of inventory.byKind) {
      lines.push(`- ${kind.kind}: ${kind.entries} · ${kind.bytes} B`);
    }
    if (inventory.incomplete > 0) {
      lines.push(`- ${t("Incomplete entries")}: ${inventory.incomplete}`);
    }
    lines.push("");
    lines.push(`### ${t("Largest packages")}`);
    for (const entry of inventory.topLabels) {
      lines.push(`- ${entry.label}: ${entry.bytes} B · ${entry.entries}`);
    }
  }
  return lines.join("\n");
}
