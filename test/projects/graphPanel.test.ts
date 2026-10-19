import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (predicate()) { return; } await tick(); }
  assert.ok(predicate(), "host state did not settle");
}

test("real graph host coalesces file events, ignores lock-only events, defers hidden reads and rejects cross-view publications", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-panel-"));
  const roots = [path.join(directory, "a"), path.join(directory, "b")];
  for (const root of roots) {
    await mkdir(path.join(root, "src"), {recursive:true});
    await writeFile(path.join(root, "mcpp.toml"), `[package]\nname="${path.basename(root)}"\n`);
    await mkdir(path.join(root, "tests"));
    await Promise.all(Array.from({length:25},(_,i)=>writeFile(path.join(root,`tests/test${i}.cpp`), "int main(){}\n")));
    await writeFile(path.join(root, "src/main.cpp"), "int main(){}\n");
    await writeFile(path.join(root, "src/lib.cppm"), "export module app;\n");
  }
  const messages: Array<Record<string, any>> = [], commands = new Map<string, (...args: any[]) => Promise<void>>();
  const fileEvents: Array<(uri: any) => void> = [];
  let receive: (message: any) => void = () => {}, visibility: () => void = () => {}, queries = 0;
  let holdSnapshot = false, releaseSnapshot: (() => void) | undefined;
  const disposable = {dispose(){}};
  const uri = (file: string) => ({fsPath:file, toString:()=>file});
  const panel = {
    visible:true,
    reveal(){}, onDidChangeViewState(listener: () => void){visibility=listener;return disposable;}, onDidDispose(){return disposable;}, dispose(){},
    webview:{cspSource:"test",asWebviewUri:(value: any)=>value,
      onDidReceiveMessage(listener: (message: any) => void){receive=listener;return disposable;},
      async postMessage(message: Record<string, any>){messages.push(message); if(message.type==="snapshot"&&holdSnapshot){holdSnapshot=false;await new Promise<void>(resolve=>{releaseSnapshot=resolve;});} return true;},html:""},
  };
  const vscode = {
    Uri:{file:uri,parse:uri,joinPath:(base: any,...parts: string[])=>uri(path.join(base.fsPath,...parts))},
    EventEmitter:class{event=()=>disposable;fire(){}dispose(){}},
    RelativePattern:class{constructor(public root: string,public pattern: string){}},ViewColumn:{Active:1,Beside:2},
    workspace:{isTrusted:true,onDidSaveTextDocument:()=>disposable,findFiles:async(pattern: {root: string})=>Array.from({length:25},(_,i)=>uri(path.join(pattern.root,`tests/test${i}.cpp`))),registerTextDocumentContentProvider:()=>disposable,
      createFileSystemWatcher:()=>({dispose(){},onDidChange(listener: (uri: any)=>void){fileEvents.push(listener);return disposable;},onDidCreate:()=>disposable,onDidDelete:()=>disposable})},
    window:{createWebviewPanel:()=>panel,showInformationMessage(){},showErrorMessage(error: string){throw new Error(error);}},
    extensions:{getExtension:()=>undefined},tasks:{onDidEndTaskProcess:()=>disposable},
    commands:{registerCommand:(id: string,handler: (...args: any[])=>Promise<void>)=>{commands.set(id,handler);return disposable;}},
  };
  const filename = path.resolve(__dirname,"../../src/projects/dependencyGraphPanel.js"), nativeRequire=createRequire(filename);
  const exports: Record<string, any> = {};
  const context = {extensionUri:uri(directory),subscriptions:[] as Array<{dispose():void}>};
  const customRequire = (id: string) => {
    if(id==="vscode")return vscode;
    if(id==="../cli/moduleGraph")return {queryModuleGraph:async(_trusted: boolean,_executable: string,root: string)=>{
      queries++;return {modules:[{name:`app.${path.basename(root)}`,files:["src/lib.cppm"],external:false}],imports:[{from:"src/main.cpp",to:`app.${path.basename(root)}`} ]};
    }};
    if(id==="../library/indexLocator")return {};
    if(id==="../webview/document")return {WebviewDocument:class{assets(){return {nonce:"test",styleUri:"test",cspSource:"test"};}paint(){}invalidate(){}}};
    return nativeRequire(id);
  };
  runInNewContext(await readFile(filename,"utf8"),{exports,require:customRequire,setTimeout,clearTimeout,AbortController,process,Buffer});
  try {
    exports.registerDependencyGraph(context,()=>({root:roots[0]}));
    const open=commands.get("mcpp.project.showModuleDependencyGraph")!;
    await open({root:roots[0]});receive({type:"ready"});
    await until(()=>messages.some(message=>message.type==="graph"));assert.equal(queries,1);
    assert.equal(messages.find(message=>message.type==="graph")?.center,false,"initial view keeps Fit instead of centering the root");
    const viewKey=`modules:${roots[0]}`;
    receive({type:"action",action:"select",viewKey,id:"app.a"});await tick();assert.equal(queries,1);
    receive({type:"action",action:"group",viewKey,group:"@group/tests"});await tick();
    assert.equal(messages.filter(message=>message.type==="graph").at(-1)?.selected,"@group/tests");
    receive({type:"action",action:"select",viewKey,id:"tests/test0.cpp"});
    receive({type:"action",action:"page",viewKey,next:true});await tick();
    assert.equal(messages.filter(message=>message.type==="graph").at(-1)?.selected,"@group/tests","paging clears a selection from the previous page");
    for(let i=0;i<100;i++)fileEvents[0](uri(path.join(roots[0],"src/lib.cppm")));
    await until(()=>queries===2);await tick(300);assert.equal(queries,2);
    fileEvents[0](uri(path.join(roots[0],"mcpp.lock")));await tick(250);assert.equal(queries,2);
    panel.visible=false;visibility();for(let i=0;i<100;i++)fileEvents[0](uri(path.join(roots[0],"src/lib.cppm")));
    await tick(250);assert.equal(queries,2);panel.visible=true;visibility();await until(()=>queries===3);await tick(50);assert.equal(queries,3);
    // Reopening a disposed webview requires a fresh snapshot. Pause its delivery and switch projects.
    holdSnapshot=true;
    const switching=open({root:roots[1]});await until(()=>!!releaseSnapshot);
    await open({root:roots[0]});
    const beforeRelease=messages.length;releaseSnapshot!();await switching;await tick();
    assert.ok(messages.slice(beforeRelease).every(message=>message.type!=="graph"||message.viewKey===viewKey));
    assert.equal(messages.filter(message=>message.type==="graph").at(-1)?.viewKey,viewKey);
  } finally {
    releaseSnapshot?.();
    for(const subscription of context.subscriptions)subscription.dispose();
    await rm(directory,{recursive:true,force:true});
  }
});
