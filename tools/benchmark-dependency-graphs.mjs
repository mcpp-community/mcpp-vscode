#!/usr/bin/env node
/** Optional browser benchmark: compile first; use the same external Playwright driver as the UI suite. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {visibleGraph,mermaidGraph}=require('../dist/src/graphs/model.js');
const {chromium}=require(process.env.MCPP_UI_PLAYWRIGHT||'playwright');
const node=id=>({id:String(id),label:'app.module'+id,lines:['export module','src/module'+id+'.cppm'],kind:'project'});
const shapes={
  chain:{nodes:Array.from({length:1000},(_,i)=>node(i)),edges:Array.from({length:999},(_,i)=>({from:String(i),to:String(i+1),label:'import'})),roots:['0']},
  wide:{nodes:Array.from({length:1000},(_,i)=>node(i)),edges:Array.from({length:999},(_,i)=>({from:'0',to:String(i+1),label:'import'})),roots:['0']},
  shared:{nodes:Array.from({length:45},(_,i)=>node(i)),edges:Array.from({length:15},(_,i)=>Array.from({length:30},(_,j)=>({from:String(i),to:String(j+15),label:'import'}))).flat(),roots:Array.from({length:15},(_,i)=>String(i))},
};
const browser=await chromium.launch({headless:true,...(process.env.MCPP_UI_CHROMIUM?{executablePath:process.env.MCPP_UI_CHROMIUM}:{}),args:['--no-sandbox']});
const results=[];
try {
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  await page.setContent('<div id="graph"></div>');
  await page.addScriptTag({path:path.resolve('dist/vendor/mermaid.js')});
  for(const [shape,full] of Object.entries(shapes))for(const depth of [3,Infinity]) {
    const start=performance.now();
    const projected=visibleGraph(full,{depth,expanded:new Set(),collapsed:new Set()});
    const projectionMs=performance.now()-start;
    assert.ok(projected.nodes.length<=150&&projected.edges.length<=300);
    const {source}=mermaidGraph(projected);
    const renderMs=await page.evaluate(async source=>{
      mermaid.initialize({startOnLoad:false,htmlLabels:false,securityLevel:'strict',theme:'dark',flowchart:{htmlLabels:false},maxEdges:310});
      const start=performance.now();const result=await mermaid.render('benchmark',source);document.getElementById('graph').innerHTML=result.svg;
      return performance.now()-start;
    },source);
    results.push({shape,depth:depth===Infinity?'all':depth,nodes:projected.nodes.length,edges:projected.edges.length,projectionMs:Math.round(projectionMs*100)/100,renderMs:Math.round(renderMs),limited:projected.limited});
  }
}finally{await browser.close();}
const output=path.resolve('.dev-profile/libraries-ui-artifacts/graph-performance.json');
await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify({testedAt:new Date().toISOString(),results},null,2));
console.log(JSON.stringify(results,null,2));
