#!/usr/bin/env node
/** Compile first. Optional real fixture: MCPP_GRAPH_JSON and MCPP_GRAPH_ROOT. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {visibleGraph,mermaidGraph,INITIAL_GRAPH_BUDGET}=require('../dist/src/graphs/model.js');
const {buildModuleGraph,moduleEntries,moduleOwnership,parseModuleGraph,sourcePath}=require('../dist/src/projects/moduleGraph.js');
const {readProjectSummary}=require('../dist/src/projects/summary.js');
const {chromium}=require('playwright');
const node=id=>({id:String(id),label:'app.module'+id,lines:['export module','src/module'+id+'.cppm'],kind:'project'});
const shapes={
  chain:{nodes:Array.from({length:1000},(_,i)=>node(i)),edges:Array.from({length:999},(_,i)=>({from:String(i),to:String(i+1)})),roots:['0']},
  wide:{nodes:Array.from({length:1000},(_,i)=>node(i)),edges:Array.from({length:999},(_,i)=>({from:'0',to:String(i+1)})),roots:['0']},
  shared:{nodes:Array.from({length:45},(_,i)=>node(i)),edges:Array.from({length:15},(_,i)=>Array.from({length:30},(_,j)=>({from:String(i),to:String(j+15)}))).flat(),roots:Array.from({length:15},(_,i)=>String(i))},
  tests:{nodes:Array.from({length:152},(_,i)=>node(i)),edges:Array.from({length:151},(_,i)=>({from:String(i),to:'151'})),roots:Array.from({length:151},(_,i)=>String(i))},
};
let realFocus;
if(process.env.MCPP_GRAPH_JSON&&process.env.MCPP_GRAPH_ROOT){
  const root=path.resolve(process.env.MCPP_GRAPH_ROOT),raw=parseModuleGraph(await fs.readFile(process.env.MCPP_GRAPH_JSON,'utf8'));
  const manifest=await fs.readFile(path.join(root,'mcpp.toml'),'utf8');
  const files=new Set(raw.modules.flatMap(node=>node.files.map(file=>sourcePath(root,file)))),names=new Set(raw.modules.map(node=>node.name));
  const exists=file=>fs.access(file).then(()=>true,()=>false);
  for(const edge of raw.imports)if(!names.has(edge.from)&&await exists(sourcePath(root,edge.from)))files.add(sourcePath(root,edge.from));
  const entries=moduleEntries(root,manifest,readProjectSummary(root,manifest.split(/\r?\n/)).name||path.basename(root),[...files]);
  for(const file of entries.keys())if(await exists(file))files.add(file);
  shapes.real=buildModuleGraph(root,raw,await moduleOwnership(root,[...files],exists),entries);
  realFocus=shapes.real.groups?.[0]?.nodes[0];
}
const browser=await chromium.launch({headless:true,...(process.env.MCPP_UI_CHROMIUM?{executablePath:process.env.MCPP_UI_CHROMIUM}:{}),args:['--no-sandbox']});
const results=[];
try{
 const page=await browser.newPage({viewport:{width:1400,height:900}});await page.setContent('<div id="graph"></div>');await page.addScriptTag({path:path.resolve('dist/vendor/mermaid.js')});
 for(const [shape,full]of Object.entries(shapes)){
  const start=performance.now();const projected=visibleGraph(full,{depth:3,upstreamDepth:2,focus:shape==='real'?realFocus:undefined,expanded:new Set(),collapsed:new Set()},INITIAL_GRAPH_BUDGET);const projectionMs=performance.now()-start;
  assert.ok(projected.nodes.length<=INITIAL_GRAPH_BUDGET.nodes&&projected.edges.length<=INITIAL_GRAPH_BUDGET.edges);
  if(shape==='tests'||shape==='real')assert.ok(projected.edges.length>0,'entries retain connected dependencies');
  const {source}=mermaidGraph(projected),times=[];
  for(let sample=0;sample<20;sample++)times.push(await page.evaluate(async source=>{
    mermaid.initialize({startOnLoad:false,htmlLabels:false,securityLevel:'strict',theme:'dark',fontFamily:'system-ui',markdownAutoWrap:false,flowchart:{htmlLabels:false,useMaxWidth:true,wrappingWidth:1000,nodeSpacing:30,rankSpacing:90,padding:18},maxEdges:310});
    const start=performance.now();const result=await mermaid.render('benchmark',source);document.getElementById('graph').innerHTML=result.svg;return performance.now()-start;
  },source));
  const sorted=[...times].sort((a,b)=>a-b);results.push({shape,nodes:projected.nodes.length,edges:projected.edges.length,projectionMs,medianMs:(sorted[9]+sorted[10])/2,p95Ms:sorted[18],samples:times,limited:projected.limited});
 }
 const output=path.resolve('.dev-profile/graph-ui-artifacts/graph-performance.json');await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify({browser:await browser.version(),results},null,2));
 console.log(JSON.stringify(results.map(({samples,...summary})=>summary),null,2));
}finally{await browser.close()}
