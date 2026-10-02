import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import apiJson from "../../data/buildscript-api.json";
import {
  ACTION_ROLES,
  API,
  apiProblems,
  apiSource,
  directive,
  directives,
} from "../../src/buildscript/api";

// Compiled layout: <repository root>/dist/test/buildscript/*.js.
const repositoryRoot = path.resolve(__dirname, "..", "..", "..");

/** The mcpp checkout to compare against, when one is reachable. */
function findMcppRepo(): string | undefined {
  const candidates = [
    process.env.MCPP_REPO,
    path.resolve(process.cwd(), "..", "mcpp"),
    path.resolve(repositoryRoot, "..", "mcpp"),
  ].filter((candidate): candidate is string => typeof candidate === "string");
  return candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "modules", "buildmcpp", "src", "directives.cppm")),
  );
}

const mcppRepo = findMcppRepo();
const skipReason =
  mcppRepo === undefined
    ? "no mcpp checkout found (set MCPP_REPO to compare against the source)"
    : false;

test("the snapshot loads with a usable shape", () => {
  assert.equal(typeof API.sourceVersion, "string");
  assert.ok(API.sourceVersion.length > 0);
  assert.equal(typeof API.sourceCommit, "string");
  assert.ok(API.protocolVersion >= 1);
  assert.ok(API.cacheEpoch >= 1);
  assert.equal(API.directives.length, 31);
  assert.equal(directives().length, apiJson.directives.length);
});

test("the snapshot's own invariants hold", () => {
  assert.deepEqual(apiProblems(), []);
});

test("every role the engine knows is present", () => {
  assert.equal(API.roles.length, ACTION_ROLES.length);
  for (const role of ACTION_ROLES) {
    assert.ok(API.roles.includes(role), `missing role ${role}`);
  }
});

test("directive() resolves wire names and only wire names", () => {
  const cxxflag = directive("cxxflag");
  assert.ok(cxxflag);
  assert.equal(cxxflag.slot, "CxxFlags");
  assert.equal(cxxflag.scope, "PackagePrivate");
  assert.equal(cxxflag.transform, "Verbatim");
  assert.equal(cxxflag.mustExist, false);
  assert.ok(cxxflag.since >= 1);
  assert.ok(Array.isArray(cxxflag.rules));
  assert.equal(directive("cxx_flag"), undefined);
  assert.equal(directive("no-such-directive"), undefined);
});

test("apiSource() reports the generated provenance", () => {
  assert.deepEqual(apiSource(), {
    version: API.sourceVersion,
    commit: API.sourceCommit,
  });
});

test("provisions carry the kind and the wire name", () => {
  assert.ok(API.provisions.length >= 3);
  const tool = API.provisions.find((entry) => entry.wire === "tool");
  assert.ok(tool);
  assert.equal(tool.kind, "tool");
  for (const entry of API.provisions) {
    assert.equal(typeof entry.kind, "string");
    assert.ok(entry.wire.length > 0);
  }
});

test(
  "the table size and every wire name match the mcpp source",
  { skip: skipReason },
  () => {
    assert.ok(mcppRepo);
    const source = fs.readFileSync(
      path.join(mcppRepo, "modules", "buildmcpp", "src", "directives.cppm"),
      "utf8",
    );
    const declared = /inline constexpr\s+std::array<Def,\s*(\d+)>\s+kTable\{\{/.exec(source);
    assert.ok(declared, "the declared kTable size is missing");

    const open = source.indexOf("kTable{{");
    const body = source.slice(open, source.indexOf("}};", open));
    const rows = body
      .split(/\r?\n/)
      .filter((line) => /Slot::\w+\s*,\s*Scope::\w+\s*,\s*Transform::\w+/.test(line));

    assert.equal(Number(declared[1]), directives().length);
    assert.equal(rows.length, directives().length);
    for (const entry of directives()) {
      assert.ok(body.includes(`"${entry.wire}"`), `source has no row for ${entry.wire}`);
    }
  },
);
