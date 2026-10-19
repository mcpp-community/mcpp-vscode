import assert from "node:assert/strict";
import test from "node:test";
import { assertCompleteManifest, retainProjectDependencies } from "../../src/projects/dependencyState";
import { buildProjectTree, type ProjectSummary } from "../../src/views/models";
test("temporary read failures preserve dependencies; successful removal clears them", () => {
  const previous: ProjectSummary = {root: "/app", dependencies: [{name: "lib"}]};
  const stale = retainProjectDependencies({root: "/app", error: "temporarily unavailable"}, previous)!;
  assert.equal(stale.dependencyState, "stale"); assert.equal(stale.dependencies?.length, 1);
  const row = buildProjectTree(stale).find(node => node.id === "project.dependencies"); assert.equal(row?.children?.length, 1);
  const empty = retainProjectDependencies({root: "/app", dependencies: []}, stale)!;
  assert.equal(empty.dependencyState, "empty"); assert.equal(buildProjectTree(empty).find(node => node.id === "project.dependencies")?.children, undefined);
  const other = retainProjectDependencies({root: "/other", error: "missing"}, stale)!;
  assert.equal(other.dependencies, undefined); assert.equal(other.dependencyState, "error");
  assert.ok(buildProjectTree(other).find(node => node.id === "project.dependencies")?.command);
});
test("incomplete edits cannot clear the last valid list, complete multiline manifests remain valid", () => {
  for (const text of ['[dependencies', '[dependencies]\nlib = "', '[dependencies]\nlib = ', 'garbage', '[dependencies]\nlib={version=}']) assert.throws(() => assertCompleteManifest(text));
  for (const text of ['', '# comment', '[dependencies]\nlib="1"', '[test]\ndiscover = [\n"tests/**/*.cpp",\n]\n', '[custom]\nratio=1.5\nwhen=2026-10-20']) assert.doesNotThrow(() => assertCompleteManifest(text));
});
