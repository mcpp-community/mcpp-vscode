/**
 * The C++ Modules view: mcppls's state, and every action that forwards to it.
 *
 * The view states its provider in its own description, so nobody has to guess
 * which extension owns what. Every button forwards an mcppls command — this
 * extension never reimplements language-service behaviour and never writes an
 * `mcppls.*` setting itself.
 *
 * Confirmation policy comes from the capability table (`danger` + `confirmHint`),
 * so a new dangerous action cannot be added without saying what it does.
 * `mcpp.languageService.confirmResetCache` can add one more explicit step to the
 * reset-cache action; it can never take the capability's own modal away, and
 * `./viewPolicy.ts` is where that rule lives.
 *
 * Three settings also own the view's *timing*: `mcpp.languageService.readState`
 * decides whether state is read at all, `…stateRefreshSeconds` whether it is
 * re-read on an interval, and `…notifyOnDegraded` whether the one-time
 * missing-dependency line is written.
 */

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
import { refreshTimerDecision } from "./cacheState";
import { buildLanguageServerTree } from "./models";
import { StaticTreeProvider } from "./treeProvider";
import { degradedNoticeEnabled, resetCacheConfirmation } from "./viewPolicy";

export const LANGUAGE_SERVER_VIEW_ID = "mcpp.languageServer";

/** The tick granularity; the settings are in seconds. */
const REFRESH_TICK_MS = 100;

export interface LanguageServerViewDeps {
  bridge: LanguageServerBridge;
  output: vscode.OutputChannel;
}

/** Ask, run, report — the same shape for every forwarded command. */
export async function runLanguageServerCommand(
  bridge: LanguageServerBridge,
  output: vscode.OutputChannel,
  key: string,
  options: { args?: unknown[]; value?: unknown; extraConfirmation?: string } = {},
): Promise<void> {
  const confirmation = confirmationFor(key, options.value);
  if (confirmation !== undefined) {
    const run = t("Run");
    const choice = await vscode.window.showWarningMessage(confirmation, { modal: true }, run);
    if (choice !== run) {
      return;
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
      return;
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

export function registerLanguageServerView(
  context: vscode.ExtensionContext,
  deps: LanguageServerViewDeps,
): void {
  const provider = new StaticTreeProvider(() =>
    buildLanguageServerTree({
      installed: languageServerInstalled(),
      enabled: languageServerEnabled(),
      version: languageServerVersion(),
      state: readLanguageServerState(),
    }),
  );
  const view = vscode.window.createTreeView(LANGUAGE_SERVER_VIEW_ID, { treeDataProvider: provider });
  context.subscriptions.push(view, provider);

  // A refresh must never overlap one that is still running: `getChildren` reads
  // the extension host, and the interval exists to keep that read fresh, not to
  // queue more of them.
  let refreshing = false;
  const refreshState = (): void => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    try {
      provider.refresh();
    } finally {
      refreshing = false;
    }
  };

  // `mcpp.languageService.stateRefreshSeconds`, but only while this view is
  // visible and only while state is read at all (0 = off).
  const timer = new PollTimer({
    periodMs: 0,
    tick: (): void => {
      if (view.visible) {
        refreshState();
      }
    },
  });
  context.subscriptions.push(timer);
  const applyTimer = (): void => {
    const disabled = read<boolean>("mcpp.languageService.readState") === false;
    const seconds = read<number>("mcpp.languageService.stateRefreshSeconds");
    const usable = !disabled && Number.isFinite(seconds) && seconds > 0;
    const decision = refreshTimerDecision(usable ? seconds : 0, view.visible);
    timer.start(decision.active ? decision.seconds * 1000 : 0);
  };
  context.subscriptions.push(view.onDidChangeVisibility(() => applyTimer()));
  applyTimer();

  const register = (id: string, handler: (...args: unknown[]) => Promise<void>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.output.appendLine(`C++ Modules 命令失败：${message}`);
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
      refreshState();
    });
  };

  register(LANGUAGE_SERVER_COMMANDS.refreshState, async () => {
    refreshState();
  });

  forward(LANGUAGE_SERVER_COMMANDS.restart, "restartServer");
  forward(LANGUAGE_SERVER_COMMANDS.restartEngine, "restartEngine");
  forward(LANGUAGE_SERVER_COMMANDS.resetWorkspaceCache, "resetCache");
  forward(LANGUAGE_SERVER_COMMANDS.selectContext, "selectContext");
  forward(LANGUAGE_SERVER_COMMANDS.showModuleGraph, "moduleGraph");
  forward(LANGUAGE_SERVER_COMMANDS.showLogs, "logs");
  forward(LANGUAGE_SERVER_COMMANDS.collectReport, "report");
  forward(LANGUAGE_SERVER_COMMANDS.exportDiagnosticBundle, "diagnosticBundle");
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
    vscode.extensions.onDidChange(() => refreshState()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("mcppls.enable") ||
        event.affectsConfiguration("mcpp.views.languageServer") ||
        event.affectsConfiguration("mcpp.languageService")
      ) {
        refreshState();
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
}
