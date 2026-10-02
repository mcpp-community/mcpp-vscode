#!/usr/bin/env node
/**
 * Drift gate for the generated snapshots.
 *
 * `data/buildscript-api.json` and `data/toml-schema.json` are generated from the
 * mcpp checkout and committed, because the extension must work without that
 * checkout present. That only stays honest if something notices when the source
 * moves, so CI regenerates them here and fails on any difference.
 *
 * Without a checkout (`MCPP_REPO`, else `../mcpp`) this **skips with a notice**
 * rather than passing silently: a green run that checked nothing is worse than a
 * yellow one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkout = process.env.MCPP_REPO ?? path.resolve(root, "..", "mcpp");

if (!fs.existsSync(path.join(checkout, "mcpp.toml"))) {
  console.log(`check-generators: skipped — no mcpp checkout at ${checkout} (set MCPP_REPO to enable)`);
  process.exit(0);
}

const targets = [
  { name: "buildscript API", script: "tools/generate-buildscript-api.mjs", file: "data/buildscript-api.json" },
  { name: "mcpp.toml schema", script: "tools/generate-toml-schema.mjs", file: "data/toml-schema.json" },
];

let drifted = 0;
for (const target of targets) {
  const before = fs.readFileSync(path.join(root, target.file), "utf8");
  try {
    execFileSync(process.execPath, [target.script], { cwd: root, env: { ...process.env, MCPP_REPO: checkout }, stdio: "pipe" });
  } catch (error) {
    console.error(`error: ${target.script} failed; the snapshot cannot be refreshed`);
    console.error(String(error.stderr ?? error.message));
    drifted += 1;
    continue;
  }
  const after = fs.readFileSync(path.join(root, target.file), "utf8");
  if (before !== after) {
    console.error(`error: ${target.file} is out of date — run \`npm run gen:…\` and commit the result`);
    drifted += 1;
  } else {
    console.log(`check-generators: ${target.name} is current`);
  }
}

if (drifted > 0) {
  process.exit(1);
}
console.log("check-generators: ok");
