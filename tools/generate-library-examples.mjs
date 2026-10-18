#!/usr/bin/env node
// Pin real, tracked upstream tests for offline usage pages; never copy build artefacts.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repo=process.env.MCPP_INDEX_REPO || path.resolve(root,'../mcpp-index');
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:8*1024*1024});
const commit=git('rev-parse',process.env.MCPP_INDEX_REF || 'HEAD').trim();
const files=git('ls-tree','-r','--name-only',commit,'tests/examples').trim().split('\n');
const projects=[];
for(const manifest of files.filter(f=>/^tests\/examples\/[^/]+\/mcpp\.toml$/.test(f)).sort()) {
  const directory=path.posix.dirname(manifest);
  const sources=files.filter(f=>f.startsWith(directory+'/tests/') && /\.(cpp|cppm|cc)$/.test(f)).sort();
  if(sources.length) projects.push({project:path.posix.basename(directory),text:git('show',commit+':'+manifest),files:sources.map(p=>({path:p,text:git('show',commit+':'+p)}))});
}
if(!projects.length) throw new Error('No tracked example projects');
fs.writeFileSync(path.join(root,'data/library-examples.json'),JSON.stringify({repository:'https://github.com/mcpp-community/mcpp-index',commit,projects},null,2)+'\n');
console.log(`Pinned ${projects.length} upstream example projects at ${commit}`);
