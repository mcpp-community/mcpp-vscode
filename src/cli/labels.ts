/**
 * The controller's own buttons.
 *
 * `showWarningMessage` / `showInformationMessage` reply with the label the user
 * pressed, so a button that is both **displayed** and **compared** must be
 * defined exactly once: two literals would silently desynchronise, and the
 * comparison would never match a translated label.
 *
 * Kept out of `controller.ts` so it stays importable without an editor (`t()`
 * loads the editor API lazily) and `test/cli/labels.test.ts` can hold the
 * identity rule.
 */

import { t } from "../i18n/t";

export interface ControllerLabels {
  installCustom: string;
  confirmInstall: string;
  confirmDetect: string;
  confirmDefault: string;
  confirmClean: string;
  chooseGlobalDefault: string;
  cleanAndBuild: string;
  showTasks: string;
}

/**
 * Resolved on every call, so `mcpp.ui.language` applies without a reload, and
 * read once per dialogue into a local `labels` value that serves both the
 * prompt and the `===` comparison.
 */
export function controllerLabels(): ControllerLabels {
  return {
    installCustom: t("$(edit) Enter another compatible toolchain spec…"),
    confirmInstall: t("Install"),
    confirmDetect: t("Detect"),
    confirmDefault: t("Set as global default"),
    confirmClean: t("Clean target"),
    chooseGlobalDefault: t("Choose a global default"),
    cleanAndBuild: t("Clean and build"),
    showTasks: t("Show running tasks"),
  };
}
