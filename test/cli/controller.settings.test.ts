import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import test from "node:test";

import {
  EDITOR_TITLE_BUTTONS_CONTEXT_KEY,
  updateEditorTitleButtonsContext,
  type EditorTitleButtonsEnvironment,
} from "../../src/projects/context";

/**
 * The controller's decisions are pure functions, but the module that holds them
 * imports `vscode` for the parts that execute them. Loading it under a stub is
 * what lets `node --test` assert the policy without an Extension Host; nothing
 * below touches the stub, so a helper that reaches for the editor fails here.
 */
const nodeRequire = createRequire(__filename);

const loader = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};

function loadController(): typeof import("../../src/cli/controller") {
  const original = loader._load;
  loader._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
    return request === "vscode" ? {} : original.call(loader, request, parent, isMain);
  };
  try {
    return nodeRequire("../../src/cli/controller") as typeof import("../../src/cli/controller");
  } finally {
    loader._load = original;
  }
}

const controller = loadController();

test("mcpp.task.revealTerminal/focusTerminal/clearTerminal decide the task terminal UI", () => {
  assert.deepEqual(controller.taskTerminalUi("always", true, true), {
    reveal: "always",
    focus: true,
    clearBeforeRun: true,
  });
  assert.deepEqual(controller.taskTerminalUi("onFailure", false, false), {
    reveal: "onFailure",
    focus: false,
    clearBeforeRun: false,
  });
  assert.deepEqual(controller.taskTerminalUi("never", true, true), {
    reveal: "never",
    focus: true,
    clearBeforeRun: true,
  });

  // Declared defaults: always / off / clear.
  assert.deepEqual(controller.taskTerminalUi(undefined, undefined, undefined), {
    reveal: "always",
    focus: false,
    clearBeforeRun: true,
  });
  // An unknown enum value falls back to the declared default, not to `never`.
  assert.deepEqual(controller.taskTerminalUi("sometimes", undefined, undefined), {
    reveal: "always",
    focus: false,
    clearBeforeRun: true,
  });
});

test("only onFailure reveals the terminal when the task failed", () => {
  const always = controller.taskTerminalUi("always", false, false);
  const onFailure = controller.taskTerminalUi("onFailure", false, false);
  const never = controller.taskTerminalUi("never", false, false);

  assert.deepEqual(controller.terminalCommandsAfterTask(always, true), []);
  assert.deepEqual(controller.terminalCommandsAfterTask(onFailure, false), []);
  assert.deepEqual(controller.terminalCommandsAfterTask(onFailure, true), ["workbench.action.terminal.focus"]);
  assert.deepEqual(controller.terminalCommandsAfterTask(never, true), []);
});

test("mcpp.task.problemMatcher adds the $mcpp matcher, or nothing", () => {
  assert.deepEqual(controller.problemMatchersFor(true), ["$mcpp"]);
  assert.deepEqual(controller.problemMatchersFor(false), []);
  // Declared default is true.
  assert.deepEqual(controller.problemMatchersFor(undefined), ["$mcpp"]);
  assert.equal(controller.PROBLEM_MATCHER_NAME, "$mcpp");
});

test("mcpp.task.confirmClean only removes the controller's own prompt", () => {
  assert.equal(controller.cleanConfirmationRequired(true), true);
  assert.equal(controller.cleanConfirmationRequired(undefined), true);
  assert.equal(controller.cleanConfirmationRequired(false), false);
});

test("mcpp.ui.confirmDestructiveOnly escalates undoable prompts, never weakens one", () => {
  const only = controller.confirmationPolicy(true);
  const more = controller.confirmationPolicy(false);
  assert.deepEqual(only, { installToolchain: "notice", globalDefault: "notice" });
  assert.deepEqual(more, { installToolchain: "modal", globalDefault: "modal" });
  // Turning the setting off can only ask more insistently.
  const rank: Record<string, number> = { notice: 0, modal: 1 };
  for (const key of ["installToolchain", "globalDefault"] as const) {
    assert.ok(rank[more[key]] >= rank[only[key]], `${key} must not be downgraded`);
  }
});

test("mcpp.ui.statusBar.showLanguageServer decides the status item suffix", () => {
  assert.equal(controller.languageServerStatusSuffix(true, "C++ Modules: ready"), "C++ Modules: ready");
  assert.equal(controller.languageServerStatusSuffix(true, "  ready  "), "ready");
  assert.equal(controller.languageServerStatusSuffix(false, "C++ Modules: ready"), undefined);
  assert.equal(controller.languageServerStatusSuffix(true, undefined), undefined);
  assert.equal(controller.languageServerStatusSuffix(true, "   "), undefined);
  // Declared default is false: the status text stays mcpp-only.
  assert.equal(controller.languageServerStatusSuffix(undefined, "ready"), undefined);
});

test("mcpp.ui.notifications.success maps to silent/statusBar/toast", () => {
  assert.equal(controller.successReportOf("silent"), "silent");
  assert.equal(controller.successReportOf("toast"), "toast");
  assert.equal(controller.successReportOf("statusBar"), "statusBar");
  // Declared default is statusBar, and an unknown value falls back to it.
  assert.equal(controller.successReportOf(undefined), "statusBar");
  assert.equal(controller.successReportOf("popup"), "statusBar");
});

test("mcpp.ui.notifications.dedupeMinutes suppresses only inside its window", () => {
  const minute = 60_000;
  assert.equal(controller.dedupeAllows(undefined, 0, 5), true);
  assert.equal(controller.dedupeAllows(0, 4 * minute, 5), false);
  assert.equal(controller.dedupeAllows(0, 5 * minute, 5), true);
  assert.equal(controller.dedupeAllows(0, minute, 5), false);
  // 0 (and unusable values) show every notification.
  assert.equal(controller.dedupeAllows(0, 1, 0), true);
  assert.equal(controller.dedupeAllows(0, 1, -5), true);
  assert.equal(controller.dedupeAllows(0, 1, Number.NaN), true);
});

test("the status bar shows a label, not a paragraph", () => {
  assert.equal(controller.statusBarSuccessText("short"), "short");
  assert.equal(controller.statusBarSuccessText("  a\n b  "), "a b");
  const long = controller.statusBarSuccessText("x".repeat(200));
  assert.equal(long.length <= controller.STATUS_BAR_SUCCESS_MAX, true);
  assert.ok(long.endsWith("…"));
});

test("a failed mcpp run yields exit-code guidance plus the self explain hint", () => {
  const usage = controller.failureAdvice(["toolchain", "list"], 2, "");
  assert.equal(usage.kind, "usage");
  assert.equal(usage.hint, undefined);

  assert.equal(controller.failureAdvice(["build"], 4, "").kind, "environment");
  assert.equal(controller.failureAdvice(["build"], 70, "").kind, "internal");
  assert.equal(controller.failureAdvice(["frobnicate"], 127, "").kind, "unknown-command");
  assert.equal(controller.failureAdvice(["run"], 101, "").kind, "build-failed");
  // 101 is only a build failure for `mcpp run`; anything else keeps the plain message.
  assert.equal(controller.failureAdvice(["build"], 101, "").kind, "failed");

  const withCode = controller.failureAdvice(
    ["build"],
    1,
    "error: cannot download [MCPP_OFFLINE_DOWNLOAD_REQUIRED]",
  );
  assert.equal(withCode.kind, "failed");
  assert.equal(withCode.hint, "mcpp self explain MCPP_OFFLINE_DOWNLOAD_REQUIRED");

  const cancelled = controller.failureAdvice(["build"], -1, "");
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.hint, undefined);
});

test("mcpp.task.editorTitleButtons is projected onto the context key package.json gates with", async () => {
  assert.equal(EDITOR_TITLE_BUTTONS_CONTEXT_KEY, "mcpp.editorTitleButtons");

  const writes: Array<{ key: string; value: boolean }> = [];
  const environment: EditorTitleButtonsEnvironment = {
    enabled: () => false,
    setContextValue: (key, value) => {
      writes.push({ key, value });
      return Promise.resolve();
    },
  };
  assert.equal(await updateEditorTitleButtonsContext(environment), false);
  assert.deepEqual(writes, [{ key: "mcpp.editorTitleButtons", value: false }]);

  const enabled: EditorTitleButtonsEnvironment = {
    enabled: () => true,
    setContextValue: (key, value) => {
      writes.push({ key, value });
      return Promise.resolve();
    },
  };
  assert.equal(await updateEditorTitleButtonsContext(enabled), true);
  assert.deepEqual(writes.at(-1), { key: "mcpp.editorTitleButtons", value: true });
});
