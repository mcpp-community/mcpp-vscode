import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

type Payload = { type: string; state?: { key: string; generation: number; declared?: string; groups?: { normal: { declared: boolean } } }; html?: string };
let index = "";
let receive: (message: unknown) => void;
const messages: Payload[] = [];
const uri = (value: string): { fsPath: string; toString(): string } => ({ fsPath: value, toString: () => value });
const panel = {
  title: "", reveal() {}, onDidDispose() {}, dispose() {},
  webview: {
    html: "", cspSource: "vscode-webview://test", asWebviewUri: (value: unknown) => value,
    onDidReceiveMessage: (callback: typeof receive) => { receive = callback; },
    postMessage: async (message: Payload) => { messages.push(message); return true; },
  },
};
const vscode = {
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)), file: uri },
  ViewColumn: { Active: 1 }, ProgressLocation: { Window: 1, Notification: 2 },
  workspace: { isTrusted: true, registerTextDocumentContentProvider: () => ({ dispose() {} }), getConfiguration: () => ({ inspect: (key: string) => ({ globalValue: key === "library.indexPath" ? index : undefined }) }) },
  window: {
    createWebviewPanel: () => panel,
    withProgress: (_options: unknown, action: () => Promise<unknown>) => action(),
    showInformationMessage() {}, showErrorMessage() {}, showWarningMessage() {},
  },
  env: { language: "en" },
};
const loader = Module as unknown as { _load(request: string, parent: unknown, main: boolean): unknown };
const original = loader._load;
loader._load = function (request, parent, main) { return request === "vscode" ? vscode : original.call(loader, request, parent, main); };
const { createLibraryDetailOpener }: typeof import("../../src/library/detailPanel") = createRequire(__filename)("../../src/library/detailPanel");
loader._load = original;

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5000) { if (await predicate()) { return; } await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail("Timed out waiting for detail operation");
}

test("an in-flight add keeps its original project and cannot update a different package page", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "mcpp-detail-operation-")));
  index = path.join(root, "index");
  await fs.mkdir(path.join(index, "pkgs"), { recursive: true });
  const a = path.join(index, "pkgs/compat.a.lua");
  const b = path.join(index, "pkgs/compat.b.lua");
  for (const [file, name] of [[a, "a"], [b, "b"]]) {
    await fs.writeFile(file, `package = { name = "${name}", namespace = "compat", xpm = { linux = { ["1.0"] = {} }, macosx = { ["1.0"] = {} }, windows = { ["1.0"] = {} } } }`);
  }
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  for (const directory of [first, second]) { await fs.mkdir(directory); await fs.writeFile(path.join(directory, "mcpp.toml"), '[package]\nname = "test"\n'); }
  const script = path.join(root, "fake.cjs");
  await fs.writeFile(script, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
if(args[0]==='xpkg'){console.log(JSON.stringify({namespace:'compat',name:path.basename(args[2],'.lua').split('.').pop(),versions:{linux:['1.0'],macosx:['1.0'],windows:['1.0']}}));}
else if(args[0]==='add'){fs.writeFileSync(path.join(__dirname,'started'),process.cwd());setTimeout(()=>{fs.appendFileSync('mcpp.toml','\\n[dependencies.compat]\\na = "1.0"\\n');},250);}
`, { mode: 0o755 });
  let executable = script;
  if (process.platform === "win32") {
    executable = path.join(root, "fake.cmd");
    await fs.writeFile(executable, '@node "%~dp0fake.cjs" %*\r\n');
  }
  let project = first;
  let dependencyChanges = 0;
  const subscriptions: Array<{ dispose(): unknown }> = [];
  const opener = createLibraryDetailOpener({ extensionUri: uri(root), subscriptions } as never, {
    projectRoot: () => project, mcppExecutable: () => executable, isTrusted: () => true,
    output: { appendLine() {}, show() {} } as never,
    onDependenciesChanged: () => { dependencyChanges++; },
  });
  try {
    await opener(a);
    const state = messages.filter((message) => message.type === "detailUpdate").at(-1)!.state!;
    receive({ type: "add", version: "9.0", dev: false, pageKey: state.key, generation: state.generation });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(await fs.readFile(path.join(first, "mcpp.toml"), "utf8"), '[package]\nname = "test"\n');
    receive({ type: "add", version: "1.0", dev: false, pageKey: state.key, generation: state.generation });
    await until(async () => !!(await fs.stat(path.join(root, "started")).catch(() => undefined)));
    project = second;
    await opener(b);
    await until(() => dependencyChanges === 1);
    await until(() => messages.at(-1)?.state?.key === b && messages.at(-1)?.html?.includes('aria-busy="false"') === true);
    assert.match(await fs.readFile(path.join(first, "mcpp.toml"), "utf8"), /a = "1.0"/);
    assert.doesNotMatch(await fs.readFile(path.join(second, "mcpp.toml"), "utf8"), /dependencies/);
    assert.equal(messages.at(-1)?.state?.groups?.normal.declared, false);
    assert.doesNotMatch(messages.at(-1)?.html ?? "", /Added compat\.a/);
    const count = messages.length;
    receive({ type: "add", version: "1.0", dev: false, pageKey: a, generation: state.generation });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(messages.length, count, "messages from a stale page must be ignored");
  } finally {
    for (const subscription of subscriptions) { subscription.dispose(); }
    await fs.rm(root, { recursive: true, force: true });
  }
});
