#!/usr/bin/env node
/** Build and launch a real-CLI Libraries review window without touching the normal VS Code profile. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const code = process.env.MCPP_DEV_CODE || "code";
const project = path.join(root, ".dev-profile/library-review");
const userData = path.join(root, ".dev-profile/library-review-user-data");
const extensions = path.join(root, ".dev-profile/extensions");
function run(executable, argv) {
  const result = spawnSync(executable, argv, { cwd: root, stdio: "inherit" });
  if (result.error) { throw result.error; }
  if (result.status !== 0) { throw new Error(`${executable} exited with ${result.status}`); }
}
function createOnce(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) { fs.writeFileSync(file, text); }
}
if (!args.includes("--no-package")) { run("npm", ["run", "package"]); }
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const vsix = path.join(root, `mcpp-vscode-${version}.vsix`);
if (!fs.existsSync(vsix)) { throw new Error(`Package missing: ${vsix}. Run without --no-package.`); }
createOnce(path.join(project, "mcpp.toml"), '[package]\nname = "library-review"\nversion = "0.1.0"\n\n[dependencies.compat]\nargparse = "3.2"\n');
createOnce(path.join(project, "secondary/mcpp.toml"), '[package]\nname = "secondary-review"\nversion = "0.1.0"\n');
createOnce(path.join(project, ".vscode/settings.json"), JSON.stringify({
  "mcpp.path": "mcpp", "mcpp.library.indexPath": "", "mcpp.library.networkSearch": false,
  "mcpp.ui.language": "zh-cn", "mcpp.diagnostics.selfCheckOnStartup": false,
}, null, 2));
createOnce(path.join(userData, "User/settings.json"), JSON.stringify({
  "workbench.startupEditor": "none", "window.title": "Libraries review · ${rootName}",
  "git.openRepositoryInParentFolders": "never", "workbench.colorTheme": "Default Dark Modern",
  "workbench.secondarySideBar.defaultVisibility": "hidden", "extensions.autoUpdate": false,
}, null, 2));
run(code, ["--extensions-dir", extensions, "--user-data-dir", userData, "--install-extension", vsix, "--force"]);
const launch = ["--new-window", "--extensions-dir", extensions, "--user-data-dir", userData, "--skip-welcome", "--disable-workspace-trust"];
const debugIndex = args.indexOf("--debug-port");
if (debugIndex >= 0) { launch.push(`--remote-debugging-port=${Number(args[debugIndex + 1])}`); }
launch.push(project, path.join(project, "mcpp.toml"));
run(code, launch);
console.log(`\nLibraries review: ${project}\nReal mcpp CLI, official local index, isolated VS Code profile.\nOpen MC++ → Libraries. Try compat.zlib and the dependency-type arrow.\nExisting scratch edits and profile preferences are preserved.`);
