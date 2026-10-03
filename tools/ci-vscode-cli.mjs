#!/usr/bin/env node
/**
 * A real `code` CLI for steps that manage extensions but run where VS Code is
 * not installed. GitHub's ubuntu runner ships no `code` on PATH, which is how
 * the isolated-install job used to die ten seconds in on
 * `code: command not found`. The Extension Host e2e solves the same problem by
 * letting @vscode/test-electron download a pinned build; this is that download
 * reduced to the one thing those steps need — the CLI path.
 *
 * Usage:
 *   CODE=$(node tools/ci-vscode-cli.mjs)               # the e2e pin, 1.91.0
 *   CODE=$(node tools/ci-vscode-cli.mjs --version 1.95.0)
 *   "$CODE" --extensions-dir <dir> --install-extension <vsix-or-id>
 *
 * The build lands in `.vscode-test/` (gitignored, kept out of the VSIX) and is
 * cached, so a later `npm run test:e2e` on the same checkout reuses it. Keep the
 * default in step with the `{ version: "1.91.0" }` pin in test/e2e/runTest.ts:
 * CI deliberately tests against the oldest VS Code the extension claims to
 * support (`engines.vscode`), not against whatever `stable` is today.
 *
 * The downloader retries internally, but all its attempts die within a second
 * when the CDN edge resets the connection — a real macos-14 run hit exactly
 * that. So this adds slower outer retries (30s, 60s, …) to give the edge time
 * to recover; a CI cache over `.vscode-test/` makes the whole question moot on
 * repeat runs.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const indexOf = (name) => args.indexOf(`--${name}`);
const versionIndex = indexOf("version");
const version = versionIndex === -1 ? "1.91.0" : args[versionIndex + 1];
const retriesIndex = indexOf("retries");
const retries = retriesIndex === -1 ? 3 : Number(args[retriesIndex + 1]);

const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } = require("@vscode/test-electron");

for (let attempt = 1; ; attempt += 1) {
  try {
    const executable = await downloadAndUnzipVSCode(version);
    console.log(resolveCliPathFromVSCodeExecutablePath(executable));
    break;
  } catch (error) {
    if (attempt >= retries) throw error;
    const seconds = attempt * 30;
    console.warn(`download failed (${error?.message ?? error}); retry ${attempt + 1}/${retries} in ${seconds}s`);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}
