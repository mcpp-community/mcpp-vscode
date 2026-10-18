import assert from "node:assert/strict";
import test from "node:test";
import { graphRoots, visibleGraph, mermaidGraph, type VisualGraph, type VisualNode } from "../../src/graphs/model";
const node=(id:string):VisualNode=>({id,label:id,lines:[],kind:"project"});
const state={depth:3,expanded:new Set<string>(),collapsed:new Set<string>()};
const chain:VisualGraph={nodes:Array.from({length:12},(_,i)=>node(String(i))),edges:Array.from({length:11},(_,i)=>({from:String(i),to:String(i+1)})),roots:["0"]};
test("depth folding expands a branch one hop and all keeps complete deep data",()=>{
  let graph=visibleGraph(chain,state);assert.equal(graph.nodes.length,4);assert.equal(graph.hidden.get("3"),1);
  graph=visibleGraph(chain,{...state,expanded:new Set(["3"])});assert.equal(graph.nodes.length,5);assert.equal(graph.hidden.get("4"),1);
  graph=visibleGraph(chain,{...state,depth:Infinity});assert.equal(graph.nodes.length,12);
  graph=visibleGraph(chain,{...state,depth:Infinity,collapsed:new Set(["2"])});assert.equal(graph.nodes.length,3);assert.equal(graph.hidden.get("2"),1);
});
test("collapsing one parent preserves a shared child reached through another parent; cycles terminate",()=>{
  const graph:VisualGraph={nodes:["a","b","shared","leaf"].map(node),edges:[{from:"a",to:"shared"},{from:"b",to:"shared"},{from:"shared",to:"leaf"},{from:"leaf",to:"b"}],roots:["a","b"]};
  const visible=visibleGraph(graph,{...state,depth:Infinity,collapsed:new Set(["a"])});
  assert.equal(visible.nodes.length,4);assert.ok(visible.edges.some(edge=>edge.from==="b"&&edge.to==="shared"));
  assert.ok(!visible.edges.some(edge=>edge.from==="a"));
});
test("every directed component has a root, including disconnected cycles and isolated nodes",()=>{
  const nodes=["a","b","c","d","e"].map(node),edges=[{from:"a",to:"b"},{from:"c",to:"d"},{from:"d",to:"c"}];
  const roots=graphRoots(nodes,edges,["a"]);assert.deepEqual(roots,["a","e","c"]);
  assert.equal(visibleGraph({nodes,edges,roots},{...state,depth:Infinity}).nodes.length,5);
});
test("node and edge budgets independently bound wide and dense subgraphs and retain hidden counts",()=>{
  const wide:VisualGraph={nodes:Array.from({length:1000},(_,i)=>node(String(i))),edges:Array.from({length:999},(_,i)=>({from:"0",to:String(i+1)})),roots:["0"]};
  const visible=visibleGraph(wide,{...state,depth:Infinity});assert.equal(visible.nodes.length,150);assert.equal(visible.limited,true);assert.equal(visible.hidden.get("0"),850);
  const dense:VisualGraph={nodes:wide.nodes.slice(0,30),edges:Array.from({length:30},(_,i)=>Array.from({length:30},(_,j)=>({from:String(i),to:String(j)}))).flat(),roots:["0"]};
  const capped=visibleGraph(dense,{...state,depth:Infinity});assert.equal(capped.edges.length,300);assert.equal(capped.limited,true);assert.ok(capped.hidden.size);
});
test("hidden-node focus includes direct importers but not their unrelated branches",()=>{
  const focused=visibleGraph(chain,{...state,focus:"9"});assert.deepEqual(focused.nodes.map(node=>node.id),["8","9","10","11"]);
});
test("Mermaid labels cannot inject graph syntax and fold counts are generated before layout",()=>{
  const graph=visibleGraph({...chain,nodes:chain.nodes.map((node,i)=>i===0?{...node,label:'bad"]\nclick n0 "https://example.test"'}:node)},state);
  const {source,nodeIds}=mermaidGraph(graph);assert.doesNotMatch(source,/\nclick/);assert.match(source,/#34;/);assert.match(source,/＋1/);assert.equal(nodeIds.length,4);
});
