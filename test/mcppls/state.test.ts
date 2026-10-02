import assert from "node:assert/strict";
import test from "node:test";

import { describeState, readStateFromExports } from "../../src/mcppls/state";

const READY = {
  state: "ready",
  project: { root: "file:///w", source: "mcpp", level: 3, tier: 1 },
  profile: { kind: "build-toolchain", compiler: "clang 22.1.8", stdlib: "libc++ 22.1.8", target: "x86_64-linux-gnu", standard: "c++26" },
  engine: { name: "clangd", version: "23.1.0" },
  engines: [
    { name: "clangd", version: "23.1.0", role: "core", state: "ready" },
    { name: "mcppls", version: "0.0.9", role: "modules", state: "ready" },
  ],
  progress: { done: 12, total: 12 },
  issues: [{ code: "unresolved-module", message: "sub not found" }],
};

const api = (status: unknown) => ({ lastStatus: () => status, statusBarText: () => "ready" });

test("reads the documented status shape", () => {
  const view = readStateFromExports(api(READY), { version: "0.0.9", active: true, enabled: true });
  assert.equal(view.available, true);
  assert.equal(view.state, "ready");
  assert.equal(view.version, "0.0.9");
  assert.equal(view.active, true);
  assert.equal(view.enabled, true);
  assert.deepEqual(view.project, { root: "file:///w", source: "mcpp", level: 3, tier: 1 });
  assert.equal(view.profile?.stdlib, "libc++ 22.1.8");
  assert.equal(view.engine?.name, "clangd");
  assert.equal(view.engines?.length, 2);
  assert.deepEqual(view.progress, { done: 12, total: 12 });
  assert.equal(view.issues?.[0]?.code, "unresolved-module");
});

test("carries S3's own remedy for an issue", () => {
  const view = readStateFromExports(
    api({
      state: "degraded",
      issues: [
        {
          code: "producer-needs-download",
          message: "the build tool needs a download",
          command: { command: "mcppls.describeOnline", arguments: [], title: "Allow" },
        },
      ],
    }),
  );
  assert.equal(view.available, true);
  assert.deepEqual(view.issues?.[0]?.command, {
    command: "mcppls.describeOnline",
    arguments: [],
    title: "Allow",
  });
});

test("an issue without a well-formed command keeps its code and message", () => {
  const view = readStateFromExports(
    api({ state: "degraded", issues: [{ code: "x", message: "y", command: { arguments: [1] } }] }),
  );
  assert.equal(view.issues?.[0]?.code, "x");
  assert.equal(view.issues?.[0]?.command, undefined);
});

test("no API object means available: false with a reason", () => {
  for (const exports of [undefined, null, 42, "text", [], {}]) {
    const view = readStateFromExports(exports);
    assert.equal(view.available, false, JSON.stringify(exports));
    assert.equal(typeof view.reason, "string");
  }
});

test("an API object without lastStatus() is reported, not thrown", () => {
  const view = readStateFromExports({ statusBarText: () => "ready" });
  assert.equal(view.available, false);
  assert.match(view.reason ?? "", /lastStatus/);
});

test("a throwing lastStatus() is contained", () => {
  const view = readStateFromExports({
    lastStatus: () => {
      throw new Error("boom");
    },
  });
  assert.equal(view.available, false);
  assert.match(view.reason ?? "", /boom/);
});

test("a status that has not arrived yet is not an error", () => {
  const view = readStateFromExports(api(undefined));
  assert.equal(view.available, false);
  assert.match(view.reason ?? "", /no status yet/);
});

test("an unknown state value is refused rather than rendered", () => {
  const view = readStateFromExports(api({ state: "melted" }));
  assert.equal(view.available, false);
  assert.match(view.reason ?? "", /unknown state/);
});

test("every documented state is accepted", () => {
  for (const state of ["starting", "loading", "preparing", "ready", "degraded", "error"]) {
    const view = readStateFromExports(api({ state }));
    assert.equal(view.available, true, state);
    assert.equal(view.state, state);
  }
});

test("partially formed fields are dropped instead of producing half-objects", () => {
  const view = readStateFromExports(
    api({
      state: "ready",
      project: { root: "file:///w" },
      profile: { kind: "semantic-kit" },
      engine: { name: "clangd" },
      progress: { done: "many", total: 3 },
      engines: [{ name: "clangd" }],
      onlineRun: { outcome: "fetched" },
    }),
  );
  assert.equal(view.available, true);
  assert.equal(view.project, undefined);
  assert.equal(view.profile, undefined);
  assert.equal(view.engine, undefined);
  assert.equal(view.progress, undefined);
  assert.equal(view.engines, undefined);
  assert.equal(view.onlineRun, undefined);
});

test("onlineRun is surfaced when complete", () => {
  const view = readStateFromExports(
    api({ state: "ready", onlineRun: { outcome: "fetched", message: "got it", at: "2026-10-02T12:40:11Z" } }),
  );
  assert.deepEqual(view.onlineRun, { outcome: "fetched", message: "got it", at: "2026-10-02T12:40:11Z" });
});

test("describeState is a single readable line either way", () => {
  assert.match(describeState(readStateFromExports(api(READY))), /ready · project mcpp · engine clangd/);
  assert.match(describeState(readStateFromExports(undefined)), /^unavailable \(/);
});
