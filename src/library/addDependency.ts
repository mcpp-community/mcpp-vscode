/**
 * `mcpp add <ns.name>@<version> [--dev]` — the only way this extension changes a
 * project's dependencies.
 *
 * **`mcpp.toml` is never written here.** `mcpp add` is the official "add a
 * dependency to mcpp.toml" command; it owns the file's formatting, comments and
 * lockfile. Editing TOML from an extension is how a manifest gets corrupted.
 *
 * The version is **mandatory**, and that is mcpp's rule, not ours: a bare
 * `mcpp add compat.argparse` is refused with
 * `error: package version required: \`mcpp add compat.argparse@<version>\` (M2 supports
 * exact-version only)`. The caller therefore always passes the version it picked
 * from `mcpp xpkg parse --json` (the greatest one for this platform), and this
 * module refuses to run without one rather than producing an error the user
 * cannot act on.
 *
 * Failures are values, not exceptions: the exit code and the stderr tail travel
 * back to the caller, which shows them. Nothing here throws, so a failed add can
 * never leave the detail page half-rendered.
 */

import * as vscode from "vscode";

import { runProcess } from "../cli/process";
import { read } from "../config/access";
import { t } from "../i18n/t";
import { clampOutput } from "../util/text";

/** `mcpp add` may have to fetch an index or build the cache entry, so it gets a long budget. */
const ADD_TIMEOUT_MS = 300_000;

export interface AddDependencyDeps {
  /** The configured `mcpp` path, or `mcpp`. */
  mcppExecutable: () => string;
  /** The workspace folder holding `mcpp.toml`; `undefined` is a refusal, not a crash. */
  projectRoot: () => string | undefined;
  /** Where the command and its output are logged, the same channel the CLI uses. */
  output?: vscode.OutputChannel;
  /** `vscode.workspace.isTrusted`; an untrusted workspace may not be written to. */
  isTrusted: () => boolean;
}

export interface AddDependencyRequest {
  /** The package id, `ns.name`. */
  id: string;
  /** The exact version; `undefined` is refused. */
  version?: string;
  /** `--dev`, i.e. a `[dev-dependencies]` entry. */
  dev: boolean;
}

export interface AddDependencyResult {
  ok: boolean;
  /** The argv that ran (empty when nothing ran), for the log and the UI. */
  argv: string[];
  exitCode: number;
  /** A sentence for the detail page, already localized. */
  message: string;
}

function failure(message: string, argv: readonly string[] = []): AddDependencyResult {
  return { ok: false, argv: [...argv], exitCode: 1, message };
}

/** The argv of one add, without running it. The preview in the UI uses the same shape. */
export function addDependencyArgv(request: { id: string; version: string; dev: boolean }): string[] {
  return ["add", `${request.id}@${request.version}`, ...(request.dev ? ["--dev"] : [])];
}

/**
 * Run one `mcpp add`, with a progress notification, and report what happened.
 *
 * Every refusal is explicit and happens **before** anything runs: no version, no
 * `mcpp.toml`, an untrusted workspace. A run that fails returns the exit code and
 * the last lines of stderr, which the detail page prints verbatim — the user gets
 * mcpp's own words, not ours.
 */
export async function addDependency(
  deps: AddDependencyDeps,
  request: AddDependencyRequest,
): Promise<AddDependencyResult> {
  const version = request.version?.trim() ?? "";
  if (request.id.trim().length === 0 || version.length === 0) {
    const message = t("mcpp add needs an exact version: mcpp add {0}@<version>.", request.id);
    void vscode.window.showWarningMessage(message);
    return failure(message);
  }
  const root = deps.projectRoot();
  if (root === undefined) {
    const message = t("This workspace has no mcpp.toml.");
    void vscode.window.showWarningMessage(message);
    return failure(message);
  }
  if (!deps.isTrusted()) {
    const message = t("This workspace is not trusted. mcpp commands that write are disabled until you trust it.");
    void vscode.window.showWarningMessage(message);
    return failure(message);
  }

  const argv = addDependencyArgv({ id: request.id, version, dev: request.dev });
  const executable = deps.mcppExecutable();
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("Adding {0}…", request.id) },
    () =>
      runProcess(executable, argv, root, {
        timeoutMs: ADD_TIMEOUT_MS,
        maxBufferMiB: read<number>("mcpp.runtime.maxOutputMiB"),
      }),
  );

  try {
    deps.output?.appendLine(`\n[${new Date().toISOString()}] mcpp ${argv.join(" ")}`);
    deps.output?.appendLine(`$ ${[executable, ...argv].join(" ")}`);
    const stdout = clampOutput(result.stdout);
    const stderr = clampOutput(result.stderr);
    if (stdout.text.trim().length > 0) deps.output?.appendLine(stdout.text.trimEnd());
    if (stderr.text.trim().length > 0) deps.output?.appendLine(stderr.text.trimEnd());
    deps.output?.appendLine(`[exit ${result.exitCode}]`);
  } catch {
    // The channel can already be gone during shutdown.
  }

  if (result.exitCode === 0) {
    const message = t("Added {0} to mcpp.toml.", `${request.id}@${version}`);
    void vscode.window.showInformationMessage(message);
    return { ok: true, argv, exitCode: 0, message };
  }

  const detail = clampOutput(result.stderr.length > 0 ? result.stderr : result.stdout).text.trim();
  const message =
    detail.length === 0
      ? t("mcpp add failed with exit code {0}.", result.exitCode)
      : t("mcpp add failed with exit code {0}: {1}", result.exitCode, detail);
  void vscode.window.showErrorMessage(message);
  return { ok: false, argv, exitCode: result.exitCode, message };
}
