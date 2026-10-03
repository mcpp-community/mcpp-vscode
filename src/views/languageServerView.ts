/**
 * The C++ Modules language service, as commands plus one state source.
 *
 * There is no view of its own any more: the four things worth seeing — state,
 * provider, problems, actions — are folded into the project view's 「基本信息」
 * section, and this file feeds that block. Every button still forwards an mcppls
 * command; this extension never reimplements language-service behaviour and never
 * writes an `mcppls.*` setting itself. The block states its provider on its own
 * line, so "who owns what" stays answerable after the fold.
 *
 * Confirmation policy comes from the capability table (`danger` + `confirmHint`),
 * so a new dangerous action cannot be added without saying what it does.
 * `mcpp.languageService.confirmResetCache` can add one more explicit step to the
 * reset-cache action; it can never take the capability's own modal away, and
 * `./viewPolicy.ts` is where that rule lives.
 *
 * Three settings also own the block's *timing*: `mcpp.languageService.readState`
 * decides whether state is read at all, `…stateRefreshSeconds` whether it is
 * re-read on an interval, and `…notifyOnDegraded` whether the one-time
 * missing-dependency line is written. `mcpp.views.languageServer.show` decides
 * whether the block appears in the project view at all.
 */

import { existsSync } from "node:fs";

import * as vscode from "vscode";

import { LANGUAGE_SERVER_COMMANDS, LEGACY_LANGUAGE_SERVER_COMMANDS, TOOL_COMMANDS } from "../commands/ids";
import { read } from "../config/access";
import { t } from "../i18n/t";
import type { LanguageServerBridge } from "../mcppls/bridge";
import { capability } from "../mcppls/contract";
import { confirmationFor, formatResult, type FormattedResult } from "../mcppls/messages";
import {
  languageServerEnabled,
  languageServerInstalled,
  languageServerVersion,
  readLanguageServerState,
} from "../mcppls/stateSource";
import { PollTimer } from "../mcppls/timers";
import { refreshTimerDecision } from "../cache/cacheState";
import type { LanguageServiceBlock } from "./models";
import { degradedNoticeEnabled, resetCacheConfirmation } from "./viewPolicy";

/** The tick granularity; the settings are in seconds. */
const REFRESH_TICK_MS = 100;

export interface LanguageServerViewDeps {
  bridge: LanguageServerBridge;
  output: vscode.OutputChannel;
}

/**
 * The folded block's data source, handed to the project view.
 *
 * `input()` reads; `onDidChange` tells the project view when to rebuild; and
 * `setVisible` is how the poller learns whether the project view is on screen at
 * all. Keeping the timer here rather than in the project view means the setting
 * that shapes it (`mcpp.languageService.stateRefreshSeconds`) is read next to the
 * action it governs.
 */
export interface LanguageServerBlockSource {
  /** The block's current input, or `undefined` while `mcpp.views.languageServer.show` is off. */
  input(): LanguageServiceBlock | undefined;
  /** Fires whenever the state, or the setting that shows it, may have changed. */
  onDidChange(listener: () => void): vscode.Disposable;
  /** The project view says whether its tree is visible; the poller follows it. */
  setVisible(visible: boolean): void;
}

/** Ask, run, report — the same shape for every forwarded command. */
export async function runLanguageServerCommand(
  bridge: LanguageServerBridge,
  output: vscode.OutputChannel,
  key: string,
  options: { args?: unknown[]; value?: unknown; extraConfirmation?: string } = {},
): Promise<{ message: string; value?: unknown } | undefined> {
  const confirmation = confirmationFor(key, options.value);
  if (confirmation !== undefined) {
    const run = t("Run");
    const choice = await vscode.window.showWarningMessage(confirmation, { modal: true }, run);
    if (choice !== run) {
      return undefined;
    }
  }
  // A setting may ask once more; it never replaces the capability's own modal.
  if (options.extraConfirmation !== undefined) {
    const run = t("Run");
    const choice = await vscode.window.showWarningMessage(
      options.extraConfirmation,
      { modal: true },
      run,
    );
    if (choice !== run) {
      return undefined;
    }
  }
  const result = await bridge.invoke(key, ...(options.args ?? []));
  const formatted: FormattedResult = formatResult(result);
  try {
    output.appendLine(`[C++ Modules] ${formatted.message}${formatted.hint === undefined ? "" : ` ${formatted.hint}`}`);
  } catch {
    // The channel can be gone during shutdown.
  }
  if (formatted.severity === "error") {
    void vscode.window.showErrorMessage(formatted.message);
  } else if (formatted.severity === "warning") {
    void vscode.window.showWarningMessage(formatted.message);
  }
  return result.value === undefined
    ? { message: formatted.message }
    : { message: formatted.message, value: result.value };
}

/**
 * The extra confirmation `mcpp.languageService.confirmResetCache` adds, or
 * `undefined` when the capability's own `danger` level should be the only one.
 * `bridge.dangerOf` is the capability table's answer, never a copy of it.
 *
 * The text is the capability's own `confirmHint`, so the second modal repeats
 * exactly what the reset does — the setting buys a second explicit "yes", not a
 * second explanation. It is resolved at render time, like every other capability
 * string (`src/mcppls/messages.ts`).
 */
export function extraResetCacheConfirmation(
  bridge: LanguageServerBridge,
  confirmResetCache: boolean,
): string | undefined {
  const decision = resetCacheConfirmation({
    danger: bridge.dangerOf("resetCache"),
    confirmResetCache,
  });
  return decision === "extra-modal" ? capability("resetCache")?.confirmHint : undefined;
}

/**
 * Registers every `mcpp.languageServer.*` command (and the forwarded mcppls
 * actions behind them) and returns the state source the project view renders.
 */
export function registerLanguageServerCommands(
  context: vscode.ExtensionContext,
  deps: LanguageServerViewDeps,
): LanguageServerBlockSource {
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);

  // Whether the project view's tree is on screen. The timer below follows it, so
  // a collapsed sidebar does not keep asking mcppls for state.
  let visible = false;
  const refresh = (): void => {
    changed.fire();
  };

  const input = (): LanguageServiceBlock | undefined => {
    // Literal key, so the wiring gate can see it.
    if (read<boolean>("mcpp.views.languageServer.show") === false) {
      return undefined;
    }
    return {
      show: true,
      installed: languageServerInstalled(),
      enabled: languageServerEnabled(),
      version: languageServerVersion(),
      state: readLanguageServerState(),
    };
  };

  // `mcpp.languageService.stateRefreshSeconds`, but only while the project view is
  // visible and only while state is read at all (0 = off).
  const timer = new PollTimer({
    periodMs: 0,
    tick: (): void => {
      if (visible) {
        refresh();
      }
    },
  });
  context.subscriptions.push(timer);
  const applyTimer = (): void => {
    const disabled = read<boolean>("mcpp.languageService.readState") === false;
    const seconds = read<number>("mcpp.languageService.stateRefreshSeconds");
    const usable = !disabled && Number.isFinite(seconds) && seconds > 0;
    const decision = refreshTimerDecision(usable ? seconds : 0, visible);
    timer.start(decision.active ? decision.seconds * 1000 : 0);
  };
  applyTimer();

  const register = (id: string, handler: (...args: unknown[]) => Promise<void>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.output.appendLine(t("C++ Modules command failed: {0}", message));
          void vscode.window.showErrorMessage(t("{0} failed: {1}", id, message));
        }
      }),
    );
  };

  const forward = (id: string, key: string, args?: () => unknown[]): void => {
    register(id, async () => {
      const options: { args?: unknown[]; extraConfirmation?: string } =
        args === undefined ? {} : { args: args() };
      if (key === "resetCache") {
        const extra = extraResetCacheConfirmation(
          deps.bridge,
          read<boolean>("mcpp.languageService.confirmResetCache"),
        );
        if (extra !== undefined) {
          options.extraConfirmation = extra;
        }
      }
      await runLanguageServerCommand(deps.bridge, deps.output, key, options);
      refresh();
    });
  };

  register(LANGUAGE_SERVER_COMMANDS.refreshState, async () => {
    refresh();
  });

  /**
   * Where the last bundle was written.
   *
   * `mcppls.exportDiagnosticBundle` resolves to the zip it wrote, and that path
   * is the only reliable answer to "where is it?" — the directory is
   * `<platform cache>/bundles` on the server's own terms, which this extension
   * must not guess at. Remembered machine-wide, because the bundle directory is
   * machine-wide too.
   */
  const BUNDLE_PATH_KEY = "mcpp.languageServer.lastDiagnosticBundle";
  const bundleFrom = (value: unknown): string | undefined => {
    const path = value instanceof vscode.Uri ? value.fsPath : typeof value === "string" ? value : undefined;
    return path !== undefined && path.length > 0 ? path : undefined;
  };

  register(LANGUAGE_SERVER_COMMANDS.exportDiagnosticBundle, async () => {
    const result = await runLanguageServerCommand(deps.bridge, deps.output, "diagnosticBundle");
    const bundle = bundleFrom(result?.value);
    if (bundle !== undefined) {
      await context.globalState.update(BUNDLE_PATH_KEY, bundle);
    }
    refresh();
  });

  register(LANGUAGE_SERVER_COMMANDS.revealBundle, async () => {
    const remembered = context.globalState.get<string>(BUNDLE_PATH_KEY);
    if (remembered === undefined || !existsSync(remembered)) {
      const exportNow = t("Capture logs now");
      const choice = await vscode.window.showInformationMessage(
        t("No diagnostic bundle has been written yet. Capturing the logs writes one zip with the report, the environment and the recent logs."),
        exportNow,
      );
      if (choice === exportNow) {
        await vscode.commands.executeCommand(LANGUAGE_SERVER_COMMANDS.exportDiagnosticBundle);
      }
      return;
    }
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(remembered));
  });

  register(LANGUAGE_SERVER_COMMANDS.openLogFolder, async () => {
    // Upstream owns the path: `revealCacheDirectory('logs')` asks the server's own
    // detail for `paths.logDirectory` and reveals it, falling back to the output
    // channel when the server cannot answer. Nothing here reconstructs a path.
    await runLanguageServerCommand(deps.bridge, deps.output, "logsDirectory", { args: ["logs"] });
  });

  forward(LANGUAGE_SERVER_COMMANDS.restart, "restartServer");
  forward(LANGUAGE_SERVER_COMMANDS.restartEngine, "restartEngine");
  forward(LANGUAGE_SERVER_COMMANDS.resetWorkspaceCache, "resetCache");
  forward(LANGUAGE_SERVER_COMMANDS.selectContext, "selectContext");
  forward(LANGUAGE_SERVER_COMMANDS.showModuleGraph, "moduleGraph");
  forward(LANGUAGE_SERVER_COMMANDS.showLogs, "logs");
  forward(LANGUAGE_SERVER_COMMANDS.collectReport, "report");
  // `exportDiagnosticBundle` is registered above rather than forwarded: its
  // answer is the zip's path, and the caller has to keep it.
  forward(LANGUAGE_SERVER_COMMANDS.runBuildToolInTerminal, "runBuildTool");
  forward(LANGUAGE_SERVER_COMMANDS.installTools, "installTools");
  forward(LANGUAGE_SERVER_COMMANDS.manageConflicts, "manageConflicts", () => [true]);
  forward(LANGUAGE_SERVER_COMMANDS.reviewChanges, "review", () => [false]);
  forward(LANGUAGE_SERVER_COMMANDS.toggleInWorkspace, "toggleInWorkspace", () => [!languageServerEnabled()]);

  // The legacy ids from 0.4.x keep working, pointing at the new actions.
  register(LEGACY_LANGUAGE_SERVER_COMMANDS.configureLanguageServer, async () => {
    await runLanguageServerCommand(deps.bridge, deps.output, "selectContext");
  });
  register("mcpp.configureClangd", async () => {
    await runLanguageServerCommand(deps.bridge, deps.output, "selectContext");
  });
  register(LEGACY_LANGUAGE_SERVER_COMMANDS.checkModuleSupport, async () => {
    await runLanguageServerCommand(deps.bridge, deps.output, "restartServer");
  });
  register(LEGACY_LANGUAGE_SERVER_COMMANDS.showModuleGraph, async () => {
    await runLanguageServerCommand(deps.bridge, deps.output, "moduleGraph");
  });
  register(LEGACY_LANGUAGE_SERVER_COMMANDS.showLanguageServerLogs, async () => {
    await runLanguageServerCommand(deps.bridge, deps.output, "logs");
  });

  register(TOOL_COMMANDS.openLanguageServerSettings, async () => {
    await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:sunrisepeak.mcpp-language-server");
  });

  context.subscriptions.push(
    vscode.extensions.onDidChange(() => refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("mcppls.enable") ||
        event.affectsConfiguration("mcpp.views.languageServer") ||
        event.affectsConfiguration("mcpp.languageService")
      ) {
        refresh();
        applyTimer();
      }
    }),
  );

  // A capability that has gone missing is worth one sentence, once — unless
  // `mcpp.languageService.notifyOnDegraded` says the user does not want it.
  if (degradedNoticeEnabled(read<boolean>("mcpp.languageService.notifyOnDegraded")) && !languageServerInstalled()) {
    deps.output.appendLine(
      t("The C++ Modules extension ({0}) is not installed or is disabled.", capability("refresh")?.key ?? ""),
    );
  }

  return {
    input,
    onDidChange: (listener: () => void): vscode.Disposable => changed.event(listener),
    setVisible: (next: boolean): void => {
      if (visible === next) {
        return;
      }
      visible = next;
      applyTimer();
      // Becoming visible is exactly when a stale block must be re-read.
      if (visible) {
        refresh();
      }
    },
  };
}

