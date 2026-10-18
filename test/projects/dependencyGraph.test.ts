import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildDependencyGraph, graphMermaid, type GraphReader } from "../../src/projects/dependencyGraph";

test("graph shows three dependency hops, shared edges and cycles without inventing lock edges", async () => {
  const root = path.resolve("project");
  const reader: GraphReader = {
    manifest: async () => '[dependencies.compat]\na="1"\nb="2"\n[dev-dependencies]\ntest="3"\n[build-dependencies]\ncodegen="4"',
    descriptor: (id) => ({id, resolved: id === "compat.a" ? "1.2" : undefined, dependencies: ({"compat.a":["compat.c"],"compat.b":["compat.c"],"compat.c":["compat.a","compat.d"]} as Record<string,string[]>)[id]?.map(id=>({id,dev:false})) ?? []}),
  };
  const graph = await buildDependencyGraph(root, "demo", reader);
  assert.equal(graph.nodes.find(n=>n.name==="compat.c")?.depth, 2);
  assert.equal(graph.nodes.find(n=>n.name==="compat.d")?.depth, 3);
  assert.equal(graph.nodes.filter(n=>n.name==="compat.c").length, 1);
  assert.ok(graph.edges.some(e=>e.from==="compat.c"&&e.to==="compat.a"));
  assert.equal(graph.nodes.find(n=>n.name==="compat.a")?.version, "1.2");
  assert.ok(graph.edges.some(e=>e.kind==="dev"));
  assert.ok(graph.edges.some(e=>e.kind==="build"));
  const shallow = await buildDependencyGraph(root, "demo", reader, 2);
  assert.ok(!shallow.nodes.some(n=>n.name==="compat.d"));
});

test("path packages traverse their manifests; unavailable and conditional declarations remain explicit", async () => {
  const root = path.resolve("workspace/app"), local=path.resolve(root,"../local");
  const graph = await buildDependencyGraph(root, "app", {
    manifest: async directory=>directory===root ? '[dependencies]\nremote={git="https://example.test/repo"}\n[dependencies.local]\npath="../local"\n[target.\'cfg(windows)\'.dependencies]\nwin="1"' : directory===local ? '[dependencies]\nleaf="2"' : undefined,
    descriptor: () => undefined,
  });
  assert.equal(graph.nodes.find(n=>n.key===local)?.source,"manifest");
  assert.ok(graph.edges.some(e=>e.from===local&&e.to==="unknown:leaf"));
  assert.equal(graph.nodes.find(n=>n.name==="remote")?.source,"unknown");
  assert.ok(graph.edges.some(e=>e.conditional&&e.to==="unknown:win"));
});

test("large graphs are bounded and untrusted labels cannot escape Mermaid strings", async () => {
  const graph=await buildDependencyGraph("root", 'evil"]\nclick n0 "https://example.test"', {
    manifest:async()=>"[dependencies]\n"+Array.from({length:200},(_,i)=>`dep${i}="1"`).join("\n"),descriptor:()=>undefined,
  });
  assert.equal(graph.nodes.length,120); assert.equal(graph.limited,true);
  const source=graphMermaid(graph);
  assert.doesNotMatch(source,/\nclick/);assert.match(source,/#34;/);
});
