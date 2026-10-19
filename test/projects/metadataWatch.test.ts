import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ProjectMetadataWatch } from "../../src/projects/metadataWatch";
test("metadata fallback reads only two stamps while visible and emits each change once",()=>{
  const values=new Map<string,string>();let reads=0;
  const watcher=new ProjectMetadataWatch(file=>{reads++;return values.get(file)||"missing";});
  watcher.capture("project");assert.equal(reads,2);
  assert.deepEqual(watcher.changes(false),[]);assert.equal(reads,2);
  assert.deepEqual(watcher.changes(),[]);assert.equal(reads,4);
  const manifest=path.join("project","mcpp.toml");values.set(manifest,"new");
  assert.deepEqual(watcher.changes(),[manifest]);assert.deepEqual(watcher.changes(),[]);
  values.set(manifest,"newer");watcher.capture("project");assert.deepEqual(watcher.changes(),[],"a normal refresh captures the version before fallback runs");
  watcher.capture();const before=reads;assert.deepEqual(watcher.changes(),[]);assert.equal(reads,before);
});
