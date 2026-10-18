import assert from "node:assert/strict";
import test from "node:test";
import { queryModuleGraph } from "../../src/cli/moduleGraph";
test("module graph CLI uses structured output, bounds process time/output and enforces trust",async()=>{
  let calls=0;
  const run=async(executable:string,args:string[],cwd?:string,options?:{timeoutMs?:number;maxBufferMiB?:number})=>{
    calls++;assert.equal(executable,"mcppls");assert.equal(cwd,"project");assert.deepEqual(args,["query","module","--graph","--root","project","--timeout","20","--format","json"]);assert.equal(options?.timeoutMs,30000);assert.equal(options?.maxBufferMiB,8);
    return {exitCode:0,stdout:'{"modules":[],"imports":[]}',stderr:""};
  };
  await assert.rejects(queryModuleGraph(false,"mcppls","project",run),/Trust/);assert.equal(calls,0);
  const graph=await queryModuleGraph(true,"mcppls","project",run);assert.deepEqual(graph.modules,[]);assert.equal(calls,1);
});
test("module graph command failure remains retryable instead of returning an empty graph",async()=>{
  await assert.rejects(queryModuleGraph(true,"mcppls","project",async()=>({exitCode:2,stdout:"",stderr:"not ready"})),/not ready/);
});
