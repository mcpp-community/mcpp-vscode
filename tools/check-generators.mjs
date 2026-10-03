#!/usr/bin/env node
/**
 * Drift gate for the generated snapshots.
 *
 * `data/buildscript-api.json` and `data/toml-schema.json` are generated from the
 * mcpp checkout and committed, because the extension must work without that
 * checkout present. That only stays honest if something notices when the source
 * moves, so CI regenerates them here and fails on any difference.
 *
 * **What "difference" means: the data, not the provenance.** The two files record
 * which mcpp they came from (`sourceVersion`, `sourceCommit`, and doc links built
 * from the commit). Every mcpp commit moves those, so comparing them literally
 * made this gate red for reasons no one in this repository caused — and a gate
 * that is always red is not a gate. `canonical()` below blanks that provenance and
 * compares the rest, so a red run means the API or the schema really moved.
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

/**
 * One JSON document with its **provenance** replaced by placeholders.
 *
 * `sourceVersion` and `sourceCommit` are facts about the checkout the snapshot was
 * generated from, and any string containing the commit (the documentation links)
 * is derived from it. Two clones of the same mcpp agree on everything else.
 */
function canonical(text) {
  const value = JSON.parse(text);
  const commit = typeof value.sourceCommit === "string" ? value.sourceCommit : "";
  const scrub = (node) => {
    if (typeof node === "string") {
      return commit.length === 0 ? node : node.split(commit).join("<commit>");
    }
    if (Array.isArray(node)) {
      return node.map(scrub);
    }
    if (node !== null && typeof node === "object") {
      const out = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = key === "sourceVersion" || key === "sourceCommit" ? "<provenance>" : scrub(child);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(scrub(value));
}

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
  if (canonical(before) !== canonical(after)) {
    console.error(
      `error: ${target.file} is out of date — the mcpp it was generated from now answers differently; ` +
        `run \`npm run gen:…\` and commit the result`,
    );
    drifted += 1;
  } else {
    console.log(`check-generators: ${target.name} is current`);
  }
}

if (drifted > 0) {
  process.exit(1);
}
console.log("check-generators: ok");
