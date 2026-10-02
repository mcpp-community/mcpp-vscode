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
 */

import * as vscode from "vscode";

import { LANGUAGE_SERVER_COMMANDS, LEGACY_LANGUAGE_SERVER_COMMANDS, TOOL_COMMANDS } from "../commands/ids";
import { t } from "../i18n/t";
import type { LanguageServerBridge } from "../mcppls/bridge";
import { capability } from "../mcppls/contract";
import { confirmationFor, formatResult, type FormattedResult } from "../mcppls/messages";
import { languageServerEnabled, languageServerInstalled, languageServerVersion, readLanguageServerState } from "../mcppls/stateSource";
import { buildLanguageServerTree } from "./models";
import { registerTreeView } from "./treeProvider";

export const LANGUAGE_SERVER_VIEW_ID = "mcpp.languageServer";

export interface LanguageServerViewDeps {
  bridge: LanguageServerBridge;
  output: vscode.OutputChannel;
}

/** Ask, run, report — the same shape for every forwarded command. */
export async function runLanguageServerCommand(
  bridge: LanguageServerBridge,
  output: vscode.OutputChannel,
  key: string,
  options: { args?: unknown[]; value?: unknown } = {},
): Promise<void> {
  const confirmation = confirmationFor(key, options.value);
  if (confirmation !== undefined) {
    const run = t("Run");
    const choice = await vscode.window.showWarningMessage(confirmation, { modal: true }, run);
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

export function registerLanguageServerView(
  context: vscode.ExtensionContext,
  deps: LanguageServerViewDeps,
): void {
  const view = registerTreeView(LANGUAGE_SERVER_VIEW_ID, () =>
    buildLanguageServerTree({
      installed: languageServerInstalled(),
      enabled: languageServerEnabled(),
      version: languageServerVersion(),
      state: readLanguageServerState(),
    }),
  );
  context.subscriptions.push(view.disposable);

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
      await runLanguageServerCommand(deps.bridge, deps.output, key, args === undefined ? {} : { args: args() });
      view.provider.refresh();
    });
  };

  register(LANGUAGE_SERVER_COMMANDS.refreshState, async () => {
    view.provider.refresh();
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
    vscode.extensions.onDidChange(() => view.provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mcppls.enable") || event.affectsConfiguration("mcpp.views.languageServer")) {
        view.provider.refresh();
      }
    }),
  );

  // A capability that has gone missing is worth one sentence, once.
  if (!languageServerInstalled()) {
    deps.output.appendLine(
      t("The C++ Modules extension ({0}) is not installed or is disabled.", capability("refresh")?.key ?? ""),
    );
  }
}
