#!/usr/bin/env node
/** Click Add in a real VS Code package detail, then compile/run a minimal LibSerial consumer.
 * MCPP_UI_PLAYWRIGHT points to an external optional Playwright installation.
 * MCPP_TEST_VSIX can select a downloaded release asset without rebuilding it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.MCPP_UI_PLAYWRIGHT||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const vsix=path.resolve(process.env.MCPP_TEST_VSIX||path.join(root,`mcpp-vscode-${version}.vsix`));
const project=path.resolve(process.env.MCPP_TEST_PROJECT||path.join(root,'.dev-profile/libserial-pr19'));
const profile=project+'-user-data';
const extensions=path.resolve(process.env.MCPP_TEST_EXTENSIONS||path.join(root,'.dev-profile/extensions'));
const port=Number(process.env.MCPP_TEST_PORT||9338);
const code=process.env.MCPP_UI_CODE||'code',mcpp=process.env.MCPP_UI_MCPP||'mcpp';
const manifest=path.join(project,'mcpp.toml');
const evidence=path.join(project,'evidence');
function run(executable,args){const result=spawnSync(executable,args,{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;}
async function eventually(read,accept,label,timeout=30000){const start=Date.now();let value;while(Date.now()-start<timeout){try{value=await read();if(accept(value))return value;}catch{}await new Promise(resolve=>setTimeout(resolve,150));}throw Error(label+': '+JSON.stringify(value));}
await fs.mkdir(path.join(project,'.vscode'),{recursive:true});await fs.mkdir(path.join(project,'src'),{recursive:true});await fs.mkdir(path.join(profile,'User'),{recursive:true});await fs.mkdir(evidence,{recursive:true});
await fs.writeFile(manifest,'[package]\nname="libserial-smoke"\nversion="0.1.0"\nstandard="c++23"\n');
await fs.writeFile(path.join(project,'src/main.cpp'),'#include <libserial/SerialPort.h>\n#include <iostream>\n\nint main() {\n    LibSerial::SerialPort port;\n    if (port.IsOpen()) return 1;\n    std::cout << "compat.libserial: SerialPort constructed and closed\\n";\n    return 0;\n}\n');
await fs.writeFile(path.join(project,'.vscode/settings.json'),JSON.stringify({'mcpp.path':mcpp,'mcpp.library.indexPath':'','mcpp.library.networkSearch':false,'mcpp.ui.language':'en','mcpp.diagnostics.selfCheckOnStartup':false,'mcpp.toml.indexCompletion':false},null,2));
await fs.writeFile(path.join(profile,'User/settings.json'),JSON.stringify({'workbench.startupEditor':'none','workbench.colorTheme':'Default Dark Modern','window.title':'compat.libserial · Add/build verification','git.openRepositoryInParentFolders':'never','extensions.autoUpdate':false}));
console.log(run(code,['--extensions-dir',extensions,'--user-data-dir',profile,'--install-extension',vsix,'--force']).trim());
const installed=run(code,['--extensions-dir',extensions,'--user-data-dir',profile,'--list-extensions','--show-versions']);
assert.ok(installed.split(/\r?\n/).includes('mcpp-community.mcpp-vscode@'+version),'the exact extension version is installed');
const sha256=createHash('sha256').update(await fs.readFile(vsix)).digest('hex');
console.log('Installed VSIX SHA-256: '+sha256);
run(code,['--new-window',`--remote-debugging-port=${port}`,'--extensions-dir',extensions,'--user-data-dir',profile,'--disable-workspace-trust','--skip-welcome',project,manifest]);
let browser;
await eventually(async()=>{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);return browser;},Boolean,'CDP startup');
const page=browser.contexts()[0].pages()[0];await page.setViewportSize({width:1600,height:1000});
async function palette(command){await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+P');await page.locator('.quick-input-widget:visible input').fill('>'+command);await page.locator('.quick-input-list .monaco-list-row').filter({hasText:command}).filter({visible:true}).first().click();}
async function frame(selector){return eventually(async()=>{for(const frame of page.frames())if(await frame.locator(selector).count())return frame;},Boolean,'frame '+selector);}
try{
 await eventually(()=>page.locator('.statusbar').innerText(),text=>/\bmcpp\b/.test(text),'activation');
 const reloaded=page.waitForEvent('domcontentloaded');await palette('Developer: Reload Window');await reloaded;
 await eventually(()=>page.locator('.statusbar').innerText(),text=>/\bmcpp\b/.test(text),'reactivation');
 await palette('mcpp: Search and Add a Dependency');const list=await frame('#library-search');await list.locator('#library-search').fill('compat.libserial');await list.locator('[data-id="compat.libserial"]').click();
 const detail=await frame('#detail-add');
 await eventually(()=>detail.locator('.detail-primary').getAttribute('aria-busy'),busy=>busy==='false','detail loaded');
 assert.ok((await detail.locator('.project-context').innerText()).includes(path.basename(project)),'the active scratch project is selected');
 await detail.locator('#detail-kind-toggle').click();await detail.locator('[data-kind=normal]').click();
 assert.equal(await detail.locator('#detail-add').isDisabled(),false,'Add is available for a fresh Linux project');
 const selected=await detail.locator('#detail-version').inputValue();assert.equal(selected,'1.0.0');
 assert.match(await detail.locator('#detail-command').innerText(),/mcpp add compat\.libserial@1\.0\.0$/);
 await page.screenshot({path:path.join(evidence,'before-add.png')});
 await detail.locator('#detail-add').click();
 const updated=await eventually(()=>fs.readFile(manifest,'utf8'),text=>/\[dependencies\.compat\][\s\S]*libserial\s*=\s*"1\.0\.0"/.test(text),'manifest written by Add',60000);
 await eventually(()=>detail.locator('#detail-add').innerText(),text=>text==='Already declared','added feedback');
 assert.equal(await detail.locator('#detail-add').isDisabled(),true);
 await page.screenshot({path:path.join(evidence,'after-add.png')});await fs.writeFile(path.join(evidence,'manifest-after-add.toml'),updated);
 console.log('PASS real detail Add → compat.libserial@1.0.0 written to the selected project');
 await fs.writeFile(path.join(evidence,'ui-result.json'),JSON.stringify({vsix,sha256,installed,selected,project,command:await detail.locator('#detail-command').innerText(),added:true,at:new Date().toISOString()},null,2));
}catch(error){await page.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});throw error;}finally{await browser.close();}
for(const args of [['build','--cache=local','-j','2'],['run','--cache=local']]){
 const log=path.join(evidence,args[0]+'.log');
 const stream=await fs.open(log,'w');
 const result=await new Promise((resolve,reject)=>{const child=spawn(mcpp,args,{cwd:project,stdio:['ignore',stream.fd,stream.fd]});const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error(args[0]+' timed out'));},300000);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);resolve(code);});});
 await stream.close();assert.equal(result,0,await fs.readFile(log,'utf8'));console.log('PASS mcpp '+args.join(' '));
}
const output=await fs.readFile(path.join(evidence,'run.log'),'utf8');assert.match(output,/compat\.libserial: SerialPort constructed and closed/);
console.log('Evidence: '+evidence);
