import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildModuleGraph, moduleEntries, moduleOwnership, parseModuleGraph, type ModuleGraphJson } from "../../src/projects/moduleGraph";
import { visibleGraph } from "../../src/graphs/model";

const root = path.resolve("workspace/app");
const defaults = { depth: 3, expanded: new Set<string>(), collapsed: new Set<string>() };
test("mcppls graph preserves main imports and all internal depths, but stops at external/path modules", async () => {
  const raw: ModuleGraphJson = { modules: [
    ...Array.from({length: 8}, (_,i) => ({ name: `app.m${i}`, files: [`src/m${i}.cppm`], external: false })),
    { name: "dep", files: ["vendor/dep/src/dep.cppm"], external: false },
    { name: "transitive", files: ["vendor/dep/src/other.cppm"], external: false },
    { name: "std", files: [path.resolve("kit/std.cppm")], external: true },
  ], imports: [{from:"src/main.cpp",to:"app.m0"}, ...Array.from({length:7},(_,i)=>({from:`app.m${i}`,to:`app.m${i+1}`})), {from:"app.m7",to:"dep"},{from:"dep",to:"transitive"}] };
  const files = [...raw.modules.flatMap(node=>node.files),"src/main.cpp"].map(file=>path.resolve(root,file));
  const owned = await moduleOwnership(root, files, async file=>file===path.join(root,"vendor/dep/mcpp.toml"));
  const graph = buildModuleGraph(root, raw, owned, moduleEntries(root, "", "app"));
  assert.ok(graph.nodes.find(node=>node.id==="src/main.cpp")?.entry);
  assert.equal(graph.edges.length,9);
  assert.ok(graph.nodes.some(node=>node.id==="app.m7"));
  assert.equal(graph.nodes.find(node=>node.id==="dep")?.kind,"index");
  assert.ok(!graph.nodes.some(node=>node.id==="transitive"||node.id==="std"));
  const initial = visibleGraph(graph,defaults);
  assert.ok(!initial.nodes.some(node=>node.id==="app.m7"));
  const full = visibleGraph(graph,{...defaults,depth:Infinity});
  assert.ok(full.nodes.some(node=>node.id==="app.m7"));
  assert.ok(full.nodes.some(node=>node.id==="dep"));
});
test("module entry conventions use explicit main/lib paths and preserve isolated library roots", () => {
  const entries = moduleEntries(root,'[targets."demo app"]\nkind="bin"\nmain="app/start.cpp"\n[lib]\npath="interface/root.cppm"',"pkg.core");
  assert.equal(entries.get(path.join(root,"app/start.cpp")),"demo app");
  assert.equal(entries.get(path.join(root,"interface/root.cppm")),"lib");
  assert.ok(!entries.has(path.join(root,"src/main.cpp")));
  const inferred=moduleEntries(root,"","pkg.core");
  assert.ok(inferred.has(path.join(root,"src/core.cppm")));
  const graph=buildModuleGraph(root,{modules:[{name:"core",files:["src/core.cppm"],external:false}],imports:[]},new Set([path.join(root,"src/core.cppm"),path.join(root,"src/main.cpp")]),inferred);
  assert.ok(graph.nodes.find(node=>node.id==="core")?.entry);
  assert.ok(graph.nodes.find(node=>node.id==="src/main.cpp")?.entry);
});
test("partitions and unknown imported modules retain identity without fabricated files", () => {
  const graph=buildModuleGraph(root,{modules:[{name:"app:types",files:["src/types.cppm"],external:false}],imports:[{from:"app:types",to:"missing"}]},new Set([path.join(root,"src/types.cppm")]),new Map());
  assert.equal(graph.nodes.find(node=>node.id==="app:types")?.kind,"manifest");
  assert.equal(graph.nodes.find(node=>node.id==="missing")?.files,undefined);
  assert.equal(graph.nodes.find(node=>node.id==="missing")?.kind,"unknown");
});
test("malformed and upstream-truncated graphs cannot masquerade as complete", () => {
  for(const value of ['null','{}','{"modules":[{}],"imports":[]}','{"modules":[],"imports":[null]}'])assert.throws(()=>parseModuleGraph(value));
  const graph=buildModuleGraph(root,parseModuleGraph('{"modules":[],"imports":[],"truncated":true}'),new Set(),new Map());
  assert.equal(graph.truncated,true);
});
