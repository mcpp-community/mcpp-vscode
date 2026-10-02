#!/usr/bin/env node
/**
 * A throwaway VS Code profile for trying this extension by hand.
 *
 * It never touches your real profile: everything lives under
 * `.dev-profile/` (gitignored) — a private `extensions/` and `user-data/`, plus a
 * scratch workspace. The script installs the packed VSIX there, tries to install
 * the C++ Modules dependency the same way, and prints the exact command to
 * launch.
 *
 * Usage:
 *   node tools/dev-profile.mjs                     # build, install, print the command
 *   node tools/dev-profile.mjs --project <dir>     # open an existing mcpp project
 *   node tools/dev-profile.mjs --from <dir>        # copy a project into the profile instead
 *   node tools/dev-profile.mjs --mcppls-vsix <f>   # install a local mcppls VSIX (offline)
 *   node tools/dev-profile.mjs --code <exe>        # a different VS Code build
 *   node tools/dev-profile.mjs --no-package        # reuse an existing VSIX
 *
 * Nothing is installed into your normal extension directory, and deleting
 * `.dev-profile/` removes every trace.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const has = (name) => args.includes(`--${name}`);

const profileRoot = path.join(root, ".dev-profile");
const extensionsDir = path.join(profileRoot, "extensions");
const userDataDir = path.join(profileRoot, "user-data");
const workspaceDir = option("project", path.join(profileRoot, "workspace"));
const code = option("code", process.env.MCPP_DEV_CODE ?? "code");
const noPackage = has("no-package");

function run(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, { stdio: "inherit", ...options });
  return result.status ?? 1;
}

function quiet(executable, argv) {
  const result = spawnSync(executable, argv, { encoding: "utf8" });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

// ---------------------------------------------------------------- preflight
const version = quiet(code, ["--version"]);
if (version.code !== 0) {
  console.error(`dev-profile: '${code}' did not answer. Pass --code <path to the VS Code CLI>.`);
  process.exit(1);
}
console.log(`dev-profile: using ${code} (${version.out.split("\n")[0]})`);

// ------------------------------------------------------------------- package
fs.mkdirSync(extensionsDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });

let vsix = option("vsix", undefined);
if (vsix === undefined) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  vsix = path.join(root, `mcpp-vscode-${manifest.version}.vsix`);
}
if (!noPackage) {
  console.log("dev-profile: packaging the extension…");
  const status = run("npm", ["run", "package"], { cwd: root });
  if (status !== 0 || !fs.existsSync(vsix)) {
    console.error(`dev-profile: packaging failed; expected ${vsix}`);
    process.exit(1);
  }
}
if (!fs.existsSync(vsix)) {
  console.error(`dev-profile: ${vsix} does not exist (drop --no-package or run npm run package)`);
  process.exit(1);
}

// ------------------------------------------------------------------- install
console.log(`dev-profile: installing ${path.basename(vsix)} into the private profile…`);
run(code, [
  "--extensions-dir", extensionsDir,
  "--user-data-dir", userDataDir,
  "--install-extension", vsix,
  "--force",
]);

const mcpplsVsix = option("mcppls-vsix", undefined);
if (mcpplsVsix !== undefined) {
  console.log(`dev-profile: installing ${path.basename(mcpplsVsix)}…`);
  run(code, [
    "--extensions-dir", extensionsDir,
    "--user-data-dir", userDataDir,
    "--install-extension", mcpplsVsix,
    "--force",
  ]);
} else {
  // The extension declares `sunrisepeak.mcpp-language-server` as a dependency, so
  // VS Code resolves it when the extension activates. Installing it up front makes
  // the first launch predictable, and failing here is not fatal — the profile still
  // works, the C++ Modules view just says the dependency is missing.
  console.log("dev-profile: trying to install the C++ Modules dependency…");
  const installed = run(code, [
    "--extensions-dir", extensionsDir,
    "--user-data-dir", userDataDir,
    "--install-extension", "sunrisepeak.mcpp-language-server",
  ]);
  if (installed !== 0) {
    console.warn(
      "dev-profile: could not install sunrisepeak.mcpp-language-server.\n" +
      "            Offline, pass --mcppls-vsix <mcppls-<platform>.vsix>; the extension still\n" +
      "            activates, and the C++ Modules view will say the dependency is missing.",
    );
  }
}

// ----------------------------------------------------------------- workspace
if (option("project", undefined) === undefined) {
  const from = option("from", undefined);
  if (from !== undefined) {
    console.log(`dev-profile: copying ${from} into the profile workspace…`);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
    fs.cpSync(from, workspaceDir, { recursive: true, filter: (source) => !source.includes(`${path.sep}target`) });
  } else if (!fs.existsSync(path.join(workspaceDir, "mcpp.toml"))) {
    fs.mkdirSync(workspaceDir, { recursive: true });
    console.log("dev-profile: creating a scratch project with `mcpp new`…");
    const status = run("mcpp", ["new", "dev-scratch"], { cwd: workspaceDir });
    if (status !== 0) {
      console.warn("dev-profile: `mcpp new` failed; open any mcpp project instead with --project <dir>.");
    }
  }
}

const openDir = fs.existsSync(path.join(workspaceDir, "mcpp.toml"))
  ? workspaceDir
  : fs.existsSync(path.join(workspaceDir, "dev-scratch", "mcpp.toml"))
    ? path.join(workspaceDir, "dev-scratch")
    : workspaceDir;

// -------------------------------------------------------------------- report
console.log("");
console.log("dev-profile: ready.");
console.log("");
console.log("Launch:");
console.log(`  ${code} --extensions-dir "${extensionsDir}" --user-data-dir "${userDataDir}" "${openDir}"`);
console.log("");
console.log("Try, in order:");
console.log("  1. the mcpp icon in the Activity Bar — Project / Cache / C++ Modules");
console.log("  2. mcpp: Build, then watch the C++ Modules view turn ready");
console.log("  3. mcpp: Cache Statistics, then mcpp: Clean Stale Artifacts (it previews first)");
console.log("  4. open mcpp.toml and build.mcpp — completion, hover and diagnostics");
console.log("  5. mcpp: Open Settings Panel, switch the language, try a preset");
console.log("  6. mcpp: Environment Self-check");
console.log("");
console.log(`Remove everything with: rm -rf "${profileRoot}"`);
