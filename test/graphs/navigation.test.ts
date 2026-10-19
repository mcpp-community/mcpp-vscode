import assert from "node:assert/strict";
import test from "node:test";
import { groupedGraph, visibleGraph, type VisualGraph, INITIAL_GRAPH_BUDGET } from "../../src/graphs/model";
const node = (id: string) => ({ id, label: id, lines: [], kind: "project" as const });
const state = { depth: 3, upstreamDepth: 2, expanded: new Set<string>(), collapsed: new Set<string>() };
test("150 test roots cannot consume the budget before their imports", () => {
  const graph = { nodes: [...Array.from({ length: 151 }, (_, i) => node(`test${i}`)), node("dep")],
    edges: Array.from({ length: 151 }, (_, i) => ({ from: `test${i}`, to: "dep" })), roots: Array.from({ length: 151 }, (_, i) => `test${i}`) };
  const visible = visibleGraph(graph, state, INITIAL_GRAPH_BUDGET);
  assert.ok(visible.edges.length > 0); assert.ok(visible.nodes.some(node => node.id === "dep"));
  assert.ok(visible.nodes.length <= INITIAL_GRAPH_BUDGET.nodes && visible.edges.length <= INITIAL_GRAPH_BUDGET.edges);
});
test("two parent hops exclude sibling imports and high fan-in leaves downstream capacity", () => {
  const graph: VisualGraph = { nodes: ["focus", "parent", "grandparent", "sibling", "child", ...Array.from({length: 100}, (_, i) => `parent${i}`)].map(node),
    edges: [{ from: "grandparent", to: "parent" }, { from: "parent", to: "focus" }, { from: "parent", to: "sibling" }, { from: "focus", to: "child" }, ...Array.from({length: 100}, (_, i) => ({from: `parent${i}`, to: "focus"}))], roots: ["grandparent"] };
  const visible = visibleGraph(graph, { ...state, focus: "focus" }, INITIAL_GRAPH_BUDGET);
  assert.ok(visible.nodes.some(node => node.id === "child"));
  assert.ok(!visible.nodes.some(node => node.id === "sibling"));
  const small = visibleGraph({ ...graph, edges: graph.edges.slice(0, 4) }, { ...state, focus: "focus" });
  assert.ok(small.nodes.some(node => node.id === "grandparent"));
});
test("successive local depths extend the selected interior node; collapse preserves shared reachability", () => {
  const graph: VisualGraph = { nodes: ["a", "b", "c", "d", "e", "f", "other"].map(node), edges: ["a", "b", "c", "d", "e"].map((from, i) => ({ from, to: ["b", "c", "d", "e", "f"][i] })), roots: ["a"] };
  const one = visibleGraph(graph, { ...state, focus: "a", localDepth: new Map([["b", 3]]) });
  assert.ok(one.nodes.some(node => node.id === "e")); assert.ok(!one.nodes.some(node => node.id === "f"));
  const two = visibleGraph(graph, { ...state, focus: "a", localDepth: new Map([["b", 4]]) });
  assert.ok(two.nodes.some(node => node.id === "f"));
  const shared = { ...graph, edges: [...graph.edges, { from: "a", to: "other" }, { from: "other", to: "c" }] };
  const folded = visibleGraph(shared, { ...state, focus: "a", collapsed: new Set(["b"]) });
  assert.ok(folded.nodes.some(node => node.id === "c")); assert.ok(!folded.edges.some(edge => edge.from === "b"));
});
test("group pages contain twenty entries and virtual edges cost no import depth", () => {
  const ids = Array.from({length: 149}, (_, i) => `test${i}`);
  const graph: VisualGraph = { nodes: [...ids.map(node), node("dep")], edges: ids.map(from => ({from, to: "dep"})), roots: ids,
    groups: [{id: "@group/tests", label: "Tests", nodes: ids}] };
  const grouped = groupedGraph(graph, "@group/tests", 20);
  assert.equal(grouped.edges.filter(edge => edge.containment).length, 20);
  const visible = visibleGraph(grouped, {...state, depth: 1});
  assert.ok(visible.nodes.some(node => node.id === "dep")); assert.ok(!visible.nodes.some(node => node.id === "test0"));
});
test("edge budget cannot strand nodes and large cyclic graphs terminate", () => {
  const graph = {nodes: Array.from({length: 10000}, (_, i) => node(String(i))), edges: Array.from({length: 50000}, (_, i) => ({from: String(i % 10000), to: String((i + 1 + Math.floor(i / 10000)) % 10000)})), roots:["0"]};
  const visible = visibleGraph(graph, {...state, depth: Infinity}, {nodes: 80, edges: 20});
  assert.ok(visible.nodes.length <= 21); assert.equal(visible.edges.length, 20);
  for (const node of visible.nodes.filter(node => node.id !== "0")) assert.ok(visible.edges.some(edge => edge.from === node.id || edge.to === node.id));
});
