#!/usr/bin/env node
/** Real VS Code webview checks against a scratch project and the installed mcpp CLI.
 * Install the optional driver outside the repo:
 *   npm install --prefix /tmp/mcpp-ui playwright
 *   MCPP_UI_PLAYWRIGHT=/tmp/mcpp-ui/node_modules/playwright node tools/test-libraries-ui.mjs
 * Requires a graphical session, VS Code, a packaged VSIX and mcpp on PATH.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MCPP_UI_PLAYWRIGHT || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.dev-profile/libraries-ui-test');
const userData = path.join(root, '.dev-profile/libraries-ui-test-data');
const artifacts = path.join(root, '.dev-profile/libraries-ui-artifacts');
const extensions = path.join(root, '.dev-profile/extensions');
const code = process.env.MCPP_UI_CODE || 'code';
const realMcpp = process.env.MCPP_UI_MCPP || 'mcpp';
const endpoint = 'http://127.0.0.1:9334';
const manifestPath = path.join(scratch, 'mcpp.toml');
const baseManifest = '[package]\nname = "libraries-ui-test"\nversion = "0.1.0"\n\n[dependencies.compat]\nargparse = "3.2"\n';
const checks = [];
function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${argv.join(' ')}: ${result.stderr}`);
  return result.stdout;
}
async function eventually(read, predicate, label, timeout = 15000) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeout) {
    try { value = await read(); if (predicate(value)) { return value; } } catch { /* frames can navigate */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: timed out; last value ${JSON.stringify(value)}`);
}
await fs.mkdir(path.join(scratch, '.vscode'), { recursive: true });
await fs.mkdir(path.join(scratch, 'secondary'), { recursive: true });
await fs.mkdir(path.join(userData, 'User'), { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
for (const file of ['results.json', 'failure.txt', 'failure.png']) { await fs.rm(path.join(artifacts, file), { force: true }); }
await fs.writeFile(manifestPath, baseManifest);
await fs.writeFile(path.join(scratch, 'secondary/mcpp.toml'), '[package]\nname = "secondary"\nversion = "0.1.0"\n');
const wrapper = path.join(scratch, 'mcpp-ui.cjs');
await fs.writeFile(wrapper, `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
if(args[0]==='index' && args[1]==='update' && fs.existsSync(path.join(__dirname,'fail-update'))) {console.error('forced index failure');process.exit(17);}
if(args[0]==='xpkg' && fs.existsSync(path.join(__dirname,'fail-parse'))) { console.error('forced parse failure'); process.exit(17); }
if(args[0]==='add' && fs.existsSync(path.join(__dirname,'fail-add'))) { console.error('forced add failure'); process.exit(17); }
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
if(args[0]==='xpkg' && fs.existsSync(path.join(__dirname,'delay-parse'))) {sleep(25000);}
if(args[0]==='search') {
 const query=args[1]; fs.appendFileSync(path.join(__dirname,'search.log'),query+'\\n');
 sleep(query==='race-a'?1800:100);
 if(query==='argparse') {console.error('forced search failure');process.exit(17);}
 console.log('  foreign:'+query+'  Preview for '+query+'  (1.2.3)'); process.exit(0);
}
if(args[0]==='add' && fs.existsSync(path.join(__dirname,'delay-add'))) {
 fs.writeFileSync(path.join(__dirname,'add-started'),args.join(' ')); sleep(1400);
}
const result=spawnSync(${JSON.stringify(realMcpp)},args,{stdio:'inherit',env:process.env});process.exit(result.status??1);
`, { mode: 0o755 });
await fs.chmod(wrapper, 0o755);
await fs.rm(path.join(scratch, 'search.log'), { force: true });
await fs.rm(path.join(scratch, 'add-started'), { force: true });
await fs.rm(path.join(scratch, 'delay-add'), { force: true });
await fs.rm(path.join(scratch, 'fail-add'), { force: true });
await fs.rm(path.join(scratch, 'fail-update'), { force: true });
await fs.rm(path.join(scratch, 'fail-parse'), { force: true });
await fs.rm(path.join(scratch, 'delay-parse'), { force: true });
await fs.writeFile(path.join(scratch, '.vscode/settings.json'), JSON.stringify({
  'mcpp.path': wrapper, 'mcpp.library.indexPath': '', 'mcpp.library.networkSearch': false,
  'mcpp.ui.language': 'en', 'mcpp.diagnostics.selfCheckOnStartup': false,
  'mcpp.toml.indexCompletion': false,
}, null, 2));
const userSettings = { 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.colorTheme': 'Default Dark Modern', 'window.title': 'Libraries automated review · ${rootName}', 'git.openRepositoryInParentFolders': 'never', 'extensions.autoUpdate': false };
const settingsFile = path.join(userData, 'User/settings.json');
await fs.writeFile(settingsFile, JSON.stringify(userSettings));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
console.log(run(code, ['--extensions-dir', extensions, '--user-data-dir', userData, '--install-extension', path.join(root, `mcpp-vscode-${version}.vsix`), '--force']).trim());
run(code, ['--new-window', '--remote-debugging-port=9334', '--extensions-dir', extensions, '--user-data-dir', userData, '--disable-workspace-trust', '--skip-welcome', scratch, manifestPath]);
let browser;
await eventually(async () => { browser = await chromium.connectOverCDP(endpoint); return true; }, Boolean, 'VS Code CDP startup');
const page = browser.contexts()[0].pages()[0];
await page.setViewportSize({ width: 1600, height: 1000 });
await page.bringToFront();
page.on('pageerror', (error) => console.error('renderer:', error.message));
async function frameWith(selector) {
  return eventually(async () => {
    for (const frame of page.frames()) { if (await frame.locator(selector).count()) { return frame; } }
  }, Boolean, `frame ${selector}`);
}
async function palette(command) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.quick-input-widget:visible input').fill(`>${command}`);
  await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: command }).filter({ visible: true }).first().click();
}
async function check(name, action) {
  if (process.env.MCPP_UI_ONLY_REAL && !name.startsWith('real mcppls modules graph navigates')) return;
  if (process.env.MCPP_UI_ONLY_LAYOUT && name !== 'responsive layouts and themes') return;
  if (process.env.MCPP_UI_ONLY_MODULES && !name.startsWith('real mcppls modules') && !name.startsWith('module source')) return;
  const start = Date.now(); await action();
  checks.push({ name, elapsedMs: Date.now() - start, ok: true });
  console.log(`PASS ${name}`);
}
async function openPackage(id, timeout = 15000) {
  const list = await frameWith('#library-search');
  await list.locator('#library-search').fill(id);
  await list.locator(`[data-id="${id}"]`).click();
  const detail = await frameWith('#detail-main');
  await eventually(() => detail.locator('.detail-title').innerText(), (text) => text === id, 'detail identity');
  await eventually(() => detail.locator('.detail-primary').getAttribute('aria-busy'), (value) => value === 'false', 'detail loaded', timeout);
  return detail;
}
try {
  await eventually(() => page.locator('.statusbar').innerText(), (text) => /\bmcpp\b/.test(text), 'extension activation', 30000);
  const reloaded = page.waitForEvent('domcontentloaded', { timeout: 20000 });
  await palette('Developer: Reload Window');
  await reloaded;
  await eventually(() => page.locator('.statusbar').innerText(), (text) => /\bmcpp\b/.test(text), 'extension reactivation', 30000);
  await palette('View: Single Column Editor Layout');
  await page.keyboard.press('Control+P');
  await page.locator('.quick-input-widget:visible input').fill(manifestPath);
  await page.locator('.quick-input-list .monaco-list-row').filter({visible:true}).first().click();
  await eventually(()=>page.locator('.monaco-editor:visible').allTextContents().then(texts=>texts.join('\n')),text=>text.includes('libraries-ui-test'),'initial scratch project editor');
  await palette('mcpp: Search and Add a Dependency');
  const list = await frameWith('#library-search');
  await eventually(() => list.locator('[data-row]').count(), (count) => count > 200, 'official catalog');
  await check('official catalog and existing declaration', async () => {
    assert.match(await list.locator('#library-footer').innerText(), /mcpp-index/);
    assert.equal(await list.locator('[data-cross="false"]').count(), await list.locator('[data-row]').count());
    const detail = await openPackage('compat.argparse');
    await detail.locator('[data-action=selectProject]').click();
    await page.locator('.quick-input-widget:visible').getByText(scratch, { exact: true }).first().click();
    await eventually(() => detail.locator('.detail-primary').getAttribute('aria-busy'), (value) => value === 'false', 'initial project selected');
    await detail.locator('#detail-kind-toggle').click();
    await detail.locator('[data-kind=normal]').click();
    assert.equal(await detail.locator('#detail-version').inputValue(), '3.2');
    assert.equal(await detail.locator('#detail-add').isDisabled(), true);
    assert.match(await detail.locator('.project-context').innerText(), /libraries-ui-test/);
    assert.equal(await detail.locator('button[data-version]').count(), 0);
  });
  await check('official tests supply real offline usage and a full read-only source', async () => {
    const detail = await openPackage('compat.argparse');
    assert.match(await detail.locator('.detail-usage').innerText(), /argparse::ArgumentParser/);
    assert.match(await detail.locator('.detail-usage').innerText(), /Bundled official index tests/);
    assert.equal(await detail.locator('.detail-code code').first().evaluate(code=>getComputedStyle(code).backgroundColor), 'rgba(0, 0, 0, 0)');
    const heading=await detail.locator('.example-heading h2').first().boundingBox();
    const toolbar=await detail.locator('.snippet-actions').first().boundingBox();
    assert.ok(Math.abs((heading.y+heading.height/2)-(toolbar.y+toolbar.height/2))<3,'source actions must share the example heading row');
    const copy=detail.locator('.snippet-actions [data-copy]').first();
    await copy.click();
    await eventually(()=>copy.innerText(),text=>text==='Copied','example copy feedback');
    assert.equal(await copy.locator('svg').count(),1,'copy feedback keeps the icon');
    const source = detail.locator('[data-open-file]').first();
    assert.match(await source.getAttribute('data-open-file'), /^mcpp-example:/);
    await source.click();
    await eventually(() => page.locator('.monaco-editor:visible').innerText(), text => text.includes('ArgumentParser'), 'read-only test source');
    await page.locator('.monaco-editor:visible .view-lines').click({position:{x:25,y:20}});
    await page.keyboard.type('SOURCE_EDIT_MUST_BE_BLOCKED');
    assert.doesNotMatch(await page.locator('.monaco-editor:visible').innerText(),/SOURCE_EDIT_MUST_BE_BLOCKED/);
    await page.keyboard.press('Escape');
    await openPackage('compat.argparse');
  });
  await check('focused search exposes only the custom clear control', async () => {
    await list.locator('#library-search').fill('argparse');
    await list.locator('#library-search').focus();
    assert.equal(await list.locator('[data-action=clear]').count(), 1);
    assert.equal(await list.locator('#library-search').getAttribute('type'), 'text');
    assert.equal(await list.locator('#library-search').getAttribute('role'), 'searchbox');
    await list.locator('[data-action=clear]').click();
    assert.equal(await list.locator('#library-search').inputValue(), '');
    assert.equal(await list.locator('[data-action=clear]').isVisible(), false);
  });
  await check('lockfile changes stay distinct from direct declarations', async () => {
    const detail = await openPackage('compat.argparse');
    const lock = path.join(scratch, 'mcpp.lock');
    await fs.writeFile(lock, 'version = 2\n[package."argparse"]\nnamespace = "compat"\nversion = "3.1"\n');
    await eventually(() => detail.locator('.detail-controls').innerText(), (text) => text.includes('Resolved in lockfile: 3.1'), 'lock overlay');
    assert.equal(await detail.locator('#detail-version').inputValue(), '3.2');
    await fs.rm(lock, { force: true });
    await eventually(() => detail.locator('.detail-controls').innerText(), (text) => !text.includes('Resolved in lockfile'), 'lock deletion');
  });
  await check('failed index updates retain the usable catalog', async () => {
    const count = await list.locator('[data-row]').count();
    await fs.writeFile(path.join(scratch, 'fail-update'), '1');
    await list.locator('[data-action=update]').click();
    await eventually(() => list.locator('.search-status').innerText(), (text) => text.includes('Index update failed'), 'index failure feedback');
    assert.equal(await list.locator('[data-row]').count(), count);
    await fs.rm(path.join(scratch, 'fail-update'), { force: true });
  });
  await check('search, keyboard opening and stable document', async () => {
    await list.evaluate(() => { window.__librariesDocument = 'same'; });
    await list.locator('#library-search').fill('zlib');
    assert.match(await list.locator('#library-count').innerText(), /^[1-9]\d* of /);
    assert.equal(await list.locator('[data-row]:visible').first().getAttribute('data-id'), 'compat.zlib');
    await list.locator('#library-search').press('ArrowDown');
    assert.equal(await list.locator('[data-id="compat.zlib"]').evaluate((el) => document.activeElement === el), true);
    await list.locator('[data-id="compat.zlib"]').press('Enter');
    const detail = await frameWith('#detail-version');
    await eventually(() => detail.locator('.detail-title').innerText(), (text) => text === 'compat.zlib', 'keyboard open');
    assert.equal(await list.evaluate(() => window.__librariesDocument), 'same');
  });
  await check('real mcpp add --dev and fresh manifest/lock state', async () => {
    const detail = await openPackage('compat.zlib');
    await detail.evaluate(() => { window.__detailDocument = 'same'; });
    await detail.locator('#detail-kind-toggle').click();
    await detail.locator('[data-kind=dev]').click();
    assert.match(await detail.locator('#detail-command').innerText(), /--dev$/);
    await detail.locator('#detail-add').click();
    await eventually(() => fs.readFile(manifestPath, 'utf8'), (text) => /\[dev-dependencies\.compat\][\s\S]*zlib/.test(text), 'real CLI manifest edit');
    await eventually(() => detail.locator('#detail-add').innerText(), (text) => text === 'Already declared', 'updated detail declaration');
    await eventually(() => list.locator('[data-id="compat.zlib"]').getAttribute('data-added'), (state) => state === 'true', 'updated sidebar declaration');
    assert.equal(await detail.evaluate(() => window.__detailDocument), 'same');
    assert.equal(await detail.locator('[data-kind=dev]').getAttribute('aria-checked'), 'true');
    await detail.locator('[data-copy-command]').click();
    await eventually(() => detail.locator('[data-copy-command]').innerText(), (text) => text === 'Copied', 'host clipboard reply');
    await fs.writeFile(manifestPath, baseManifest);
    await eventually(() => detail.locator('#detail-add').isDisabled(), (disabled) => !disabled, 'external edit detail refresh');
    await eventually(() => list.locator('[data-id="compat.zlib"]').getAttribute('data-added'), (state) => state === 'false', 'external edit sidebar refresh');
  });
  await check('add result cannot mark a different package', async () => {
    await fs.writeFile(path.join(scratch, 'delay-add'), '1');
    const a = await openPackage('compat.zlib');
    await a.locator('#detail-kind-toggle').click();
    await a.locator('[data-kind=normal]').click();
    await a.locator('#detail-add').click();
    await eventually(() => fs.readFile(path.join(scratch, 'add-started'), 'utf8'), Boolean, 'delayed real add started');
    const b = await openPackage('compat.argparse');
    await eventually(() => fs.readFile(manifestPath, 'utf8'), (text) => /zlib\s*=/.test(text), 'A completed');
    await eventually(() => b.locator('.detail-primary').getAttribute('aria-busy'), (value) => value === 'false', 'global operation completed');
    assert.equal(await b.locator('.detail-title').innerText(), 'compat.argparse');
    assert.equal(await b.locator('#detail-version').inputValue(), '3.2');
    assert.match(await b.locator('#detail-command').innerText(), /compat\.argparse@3\.2$/);
    assert.equal(await b.locator('#detail-result').innerText(), '');
    await fs.rm(path.join(scratch, 'delay-add'), { force: true });
  });
  await check('stale network search is discarded and preview is honest', async () => {
    await list.locator('#library-network').check();
    await list.locator('#library-search').fill('race-a');
    await eventually(() => fs.readFile(path.join(scratch, 'search.log'), 'utf8'), (text) => text.includes('race-a'), 'A search started');
    await list.locator('#library-search').fill('race-b');
    await eventually(() => list.locator('[data-id="foreign.race-b"]').count(), (count) => count === 1, 'B search result');
    await new Promise((resolve) => setTimeout(resolve, 1900));
    assert.equal(await list.locator('[data-id="foreign.race-a"]').count(), 0);
    await list.locator('[data-id="foreign.race-b"]').click();
    const preview = await frameWith('#detail-main');
    await eventually(() => preview.locator('.detail-title').innerText(), (text) => text === 'foreign.race-b', 'preview identity');
    assert.match(await preview.locator('body').innerText(), /1\.2\.3/);
    assert.match(await preview.locator('body').innerText(), /Search preview/);
    assert.equal(await preview.locator('#detail-add').count(), 0);
    await list.locator('#library-search').fill('race-a');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await list.locator('#library-network').uncheck();
    await new Promise((resolve) => setTimeout(resolve, 1900));
    assert.equal(await list.locator('[data-cross="true"]').count(), 0);
  });
  await check('project picker binds writes and sidebar state to selected project', async () => {
    const detail = await openPackage('compat.argparse');
    await detail.locator('[data-action="selectProject"]').click();
    await page.locator('.quick-input-widget input').fill('secondary');
    await page.keyboard.press('Enter');
    await eventually(() => detail.locator('.project-context').innerText(), (text) => /secondary/.test(text), 'selected project');
    await eventually(() => detail.locator('#detail-add').isDisabled(), (disabled) => !disabled, 'secondary has no declaration');
    await detail.locator('#detail-add').click();
    await eventually(() => fs.readFile(path.join(scratch, 'secondary/mcpp.toml'), 'utf8'), (text) => /argparse\s*=\s*"3.2"/.test(text), 'write to secondary project');
    assert.match(await fs.readFile(manifestPath, 'utf8'), /argparse = "3.2"/);
  });
  await check('secondary dependency menu, title tags and explicit build configuration', async () => {
    const detail = await openPackage('compat.argparse');
    assert.equal(await detail.locator('input[type=checkbox]').count(), 0);
    assert.match(await detail.locator('.detail-heading').innerText(), /C\+\+23/);
    assert.match(await detail.locator('.detail-heading').innerText(), /MIT/);
    await detail.locator('#detail-kind-toggle').click();
    await page.screenshot({ path: path.join(artifacts, 'dependency-menu.png') });
    await detail.locator('[data-kind=build]').click();
    assert.equal(await detail.locator('[data-kind=build]').getAttribute('aria-checked'), 'true');
    assert.match(await detail.locator('#detail-command').innerText(), /\[build-dependencies\.compat\]/);
    assert.equal(await detail.locator('#detail-add').innerText(), 'Open mcpp.toml');
    const before = await fs.readFile(path.join(scratch, 'secondary/mcpp.toml'), 'utf8');
    await detail.locator('[data-copy-command]').click();
    await eventually(() => detail.locator('[data-copy-command]').innerText(), (text) => text === 'Copied', 'TOML snippet copy');
    await detail.locator('#detail-add').click();
    await eventually(() => page.locator('.tab.active').innerText(), (text) => text.includes('mcpp.toml'), 'manifest opened');
    assert.equal(await fs.readFile(path.join(scratch, 'secondary/mcpp.toml'), 'utf8'), before, 'build mode must not write the manifest');
  });
  await check('search and parse failures retain usable local results and recover', async () => {
    await list.locator('#library-search').fill('argparse');
    await list.locator('#library-network').check();
    await eventually(() => list.locator('.search-status').innerText(), (text) => text.includes('failed'), 'search failure feedback');
    assert.equal(await list.locator('[data-id="compat.argparse"]:visible').count(), 1);
    await list.locator('#library-network').uncheck();
    await fs.writeFile(path.join(scratch, 'fail-parse'), '1');
    const fallback = await openPackage('compat.abseil');
    assert.match(await fallback.locator('body').innerText(), /Versions are from descriptor text/);
    await fs.rm(path.join(scratch, 'fail-parse'), { force: true });
    await fallback.locator('[data-action="retry"]:visible').first().click();
    await eventually(() => fallback.locator('body').innerText(), (text) => !text.includes('Versions are from descriptor text'), 'parse recovery');
  });
  await check('a timed-out parser retains package identity and recovers on retry', async () => {
    await fs.writeFile(path.join(scratch, 'delay-parse'), '1');
    const start = Date.now();
    const detail = await openPackage('compat.apriltag', 30000);
    assert.ok(Date.now() - start >= 19000, 'parser timeout was exercised');
    assert.match(await detail.locator('body').innerText(), /Versions are from descriptor text/);
    assert.equal(await detail.locator('.detail-title').innerText(), 'compat.apriltag');
    await fs.rm(path.join(scratch, 'delay-parse'), { force: true });
    await detail.locator('[data-action="retry"]:visible').first().click();
    await eventually(() => detail.locator('body').innerText(), (text) => !text.includes('Versions are from descriptor text'), 'timeout recovery');
  });
  await check('add failures keep the selected version and permit recovery', async () => {
    const detail = await openPackage('compat.zlib');
    const version = await detail.locator('#detail-version').inputValue();
    await fs.writeFile(path.join(scratch, 'fail-add'), '1');
    await detail.locator('#detail-add').click();
    await eventually(() => detail.locator('#detail-result').innerText(), (text) => text.includes('exit 17'), 'add failure feedback');
    assert.equal(await detail.locator('#detail-version').inputValue(), version);
    assert.equal(await detail.locator('#detail-add').isDisabled(), false);
    await fs.rm(path.join(scratch, 'fail-add'), { force: true });
    await detail.locator('#detail-add').click();
    await eventually(() => detail.locator('#detail-add').innerText(), (text) => text === 'Already declared', 'add recovery');
  });
  const auxiliary = page.locator('.part.auxiliarybar');
  if (await auxiliary.count() && await auxiliary.isVisible()) { await palette('View: Toggle Secondary Side Bar Visibility'); }
  await check('sidebar widths and local filter latency', async () => {
    await openPackage('compat.argparse');
    const timings = [];
    for (const width of [180, 280, 420, 280]) {
      const sidebar = await page.locator('.part.sidebar').boundingBox();
      await page.mouse.move(sidebar.x + sidebar.width, sidebar.y + sidebar.height / 2);
      await page.mouse.down();
      await page.mouse.move(sidebar.x + width, sidebar.y + sidebar.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(100);
      const size = await list.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }));
      assert.ok(Math.abs(size.width - width) < 6, JSON.stringify(size));
      assert.ok(size.document <= size.width + 1, 'sidebar overflows');
    }
    for (const query of ['', 'zlib', 'argparse', 'compat']) {
      timings.push(await list.evaluate((query) => { const input = document.getElementById('library-search'); input.value = query; const start = performance.now(); input.dispatchEvent(new Event('input')); return performance.now() - start; }, query));
    }
    assert.ok(Math.max(...timings) < 50, 'filter exceeded 50ms: ' + timings);
    await fs.writeFile(path.join(artifacts, 'filter-timings.json'), JSON.stringify(timings));
  });
  await check('responsive layouts and themes', async () => {
    const detail = await openPackage('compat.argparse');
    const layouts = [];
    for (const [theme, className] of [['Default Dark Modern', 'vscode-dark'], ['Default Light Modern', 'vscode-light'], ['Default High Contrast', 'vscode-high-contrast']]) {
      await palette('Preferences: Color Theme');
      await page.locator('.quick-input-widget:visible input').fill(theme.replace('Default ', ''));
      await page.locator('.quick-input-list .monaco-list-row:visible').filter({ hasText: theme.replace('Default ', '') }).first().click();
      await eventually(() => detail.locator('body').getAttribute('class'), (value) => value.includes(className), `theme ${theme}`);
      const occupied = page.viewportSize().width - await detail.evaluate(() => innerWidth);
      for (const width of [480, 800, 1200, 1600, 2560]) {
        await page.setViewportSize({ width: width + occupied, height: 1000 });
        await page.waitForTimeout(150);
        const geometry = await detail.evaluate(() => {
          const header=document.querySelector('.detail-header').getBoundingClientRect();
          return { width: innerWidth, document: document.documentElement.scrollWidth, display: getComputedStyle(document.querySelector('.detail-layout')).display, columns: getComputedStyle(document.querySelector('.detail-layout')).gridTemplateColumns,
            left:header.left,right:document.documentElement.clientWidth-header.right,usage:document.querySelector('.detail-usage').getBoundingClientRect().width,aside:document.querySelector('.detail-aside').getBoundingClientRect().width };
        });
        assert.equal(geometry.display, geometry.width < 900 ? 'block' : 'grid');
        assert.ok(geometry.document <= geometry.width + 1, `${theme} width ${width}: page overflows ${JSON.stringify(geometry)}`);
        assert.ok(geometry.left >= 15 && geometry.left <= 41 && geometry.right >= 15 && geometry.right <= 41, 'detail uses editor width with bounded gutters');
        if (geometry.width >= 1200) {
          assert.ok(geometry.aside <= 321, 'metadata stays compact on wide screens');
          assert.ok(geometry.usage >= (geometry.width-geometry.left-geometry.right)*.62, 'extra width is available to example code');
        }
        layouts.push({ theme, viewport: width, ...geometry });
        await page.screenshot({ path: path.join(artifacts, `${className}-${width}.png`) });
      }
    }
    await fs.writeFile(path.join(artifacts, 'layouts.json'), JSON.stringify(layouts, null, 2));
  });
  await check('project graph renders three real manifest levels and copies Mermaid', async () => {
    const graphRoot=path.join(scratch,'graph-project');
    for(let depth=0;depth<5;depth++) {
      const directory=depth===0?graphRoot:path.join(graphRoot,`level${depth}`);
      await fs.mkdir(directory,{recursive:true});
      await fs.writeFile(path.join(directory,'mcpp.toml'),`[package]\nname="graph-level-${depth}"\nversion="0.1.0"\n`+(depth<4?`[dependencies]\nlevel${depth+1}={path="${depth===0?'':'../'}level${depth+1}"}\n`:'')+(depth===0?`[dependencies.compat]\nlibpng="1.6.50"\n[target.'cfg(windows)'.dependencies]\nwin={path="level1"}\n`:''));
    }
    await page.keyboard.press('Control+P');
    await page.locator('.quick-input-widget:visible input').fill(path.join(graphRoot,'mcpp.toml'));
    await page.locator('.quick-input-list .monaco-list-row').filter({hasText:'graph-project'}).filter({visible:true}).first().click();
    await eventually(()=>page.locator('.monaco-editor:visible').innerText(),text=>text.includes('graph-level-0'),'graph project editor');
    await palette('mcpp: Show Project Dependency Graph');
    const graph=await frameWith('#graph');
    await eventually(()=>graph.locator('#graph').innerText(), text=>text.includes('level3'), 'three-level graph');
    assert.equal(await graph.locator('#graph svg').count(),1);
    assert.doesNotMatch(await graph.locator('#graph').innerText(),/level4/);
    assert.match(await graph.locator('#graph').innerText(),/compat.zlib/);
    assert.match(await graph.locator('pre').textContent(),/-\.->/);
    assert.doesNotMatch(await graph.locator('body').innerText(),/\/home\/|Up to 3 dependency levels|Edges come from/);
    assert.match(await graph.locator('.edgeLabel').allTextContents().then(labels=>labels.join(' ')),/compat\.libpng@1\.6\.50/);
    const colors=await graph.evaluate(()=>['project','manifest','index'].map(kind=>getComputedStyle(document.querySelector('.node.'+kind+' rect')).fill));
    assert.equal(new Set(colors).size,3,'project, path and index cards have distinct colors');
    await graph.locator('#graph-export summary').click();
    await graph.locator('[data-action=copy]').click();
    await eventually(()=>graph.locator('#feedback').innerText(),text=>text==='Copied','graph copied');
    await graph.locator('[data-zoom="+"]').click();
    await graph.locator('[data-zoom=fit]').click();
    const transform = () => graph.locator('#graph svg').evaluate(svg => {
      const matrix = new DOMMatrix(getComputedStyle(svg).transform);
      return { scale: matrix.a, x: matrix.e, y: matrix.f };
    });
    const fitted = await transform();
    const canvas = await graph.locator('#graph').boundingBox();
    await page.mouse.move(canvas.x + canvas.width * .55, canvas.y + canvas.height * .55);
    await page.mouse.wheel(0, -180);
    await eventually(transform, matrix => matrix.scale > fitted.scale * 1.2, 'wheel zoom');
    const zoomed = await transform();
    const anchor = { x: canvas.width * .55, y: canvas.height * .55 };
    for (const axis of ['x', 'y']) {
      assert.ok(Math.abs((anchor[axis] - fitted[axis]) / fitted.scale - (anchor[axis] - zoomed[axis]) / zoomed.scale) < 1, 'wheel keeps the cursor anchor stable');
    }
    await page.mouse.move(canvas.x + 15, canvas.y + 15);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 85, canvas.y + 50, { steps: 8 });
    await page.mouse.up();
    const panned = await transform();
    assert.ok(Math.abs(panned.x - zoomed.x - 70) < 1 && Math.abs(panned.y - zoomed.y - 35) < 1, 'drag pans both axes');
    assert.equal(panned.scale, zoomed.scale, 'drag preserves zoom');
    assert.equal(await graph.locator('#graph.is-grabbing').count(), 0, 'release ends dragging');
    await graph.locator('[data-zoom=fit]').click();
    assert.deepEqual(await transform(), fitted, 'fit restores the complete graph');
    await page.screenshot({path:path.join(artifacts,'dependency-graph.png')});
  });
  await check('direct dependency rows show coordinates and focus their graph node', async()=>{
    const basics=page.getByRole('treeitem',{name:'Basics',exact:true});
    if(await basics.getAttribute('aria-expanded')==='true')await basics.click();
    const dependencies=page.getByRole('treeitem',{name:/^Dependencies \(\d+\)/});
    if(await dependencies.getAttribute('aria-expanded')==='false')await dependencies.click();
    const library=page.getByRole('treeitem',{name:/compat\.libpng@1\.6\.50/});
    await library.click();
    let graph=await frameWith('#graph');
    await eventually(async()=>(await frameWith('#graph')).locator('.node.is-focused').textContent(),text=>text.includes('compat.libpng'),'index dependency focused');
    assert.equal(await page.getByRole('treeitem',{name:/compat\.zlib@/}).count(),0,'transitive packages stay out of the direct list');
    const local=page.getByRole('treeitem',{name:/level1@0\.1\.0/});
    await local.click();
    graph=await frameWith('#graph');
    await eventually(async()=>(await frameWith('#graph')).locator('.node.manifest.is-focused').textContent(),text=>text.includes('graph-level-1'),'path dependency focused');
    await page.screenshot({path:path.join(artifacts,'dependency-focused.png')});
  });
  await check('real mcppls modules graph shows entries, internal expansion and only one external hop', async()=>{
    const moduleRoot=path.join(scratch,'module-project');
    await fs.mkdir(path.join(moduleRoot,'src'),{recursive:true});
    await fs.mkdir(path.join(moduleRoot,'vendor/ext/src'),{recursive:true});
    await fs.writeFile(path.join(moduleRoot,'mcpp.toml'),'[package]\nname="module-ui-test"\nversion="0.1.0"\nstandard="c++23"\n[lib]\npath="src/l0.cppm"\n[dependencies]\nexternal={path="vendor/ext"}\n');
    await fs.writeFile(path.join(moduleRoot,'src/main.cpp'),'import demo.l0;\nint main() { return 0; }\n');
    for(let i=0;i<7;i++)await fs.writeFile(path.join(moduleRoot,`src/l${i}.cppm`),`export module demo.l${i};\nimport ${i<6?`demo.l${i+1}`:'external.api'};\n`);
    await fs.writeFile(path.join(moduleRoot,'vendor/ext/mcpp.toml'),'[package]\nname="external"\nversion="0.1.0"\nstandard="c++23"\n[lib]\npath="src/api.cppm"\n');
    await fs.writeFile(path.join(moduleRoot,'vendor/ext/src/api.cppm'),'export module external.api;\nimport external.hidden;\n');
    await fs.writeFile(path.join(moduleRoot,'vendor/ext/src/hidden.cppm'),'export module external.hidden;\n');
    await page.keyboard.press('Control+P');
    await page.locator('.quick-input-widget:visible input').fill(path.join(moduleRoot,'mcpp.toml'));
    await page.locator('.quick-input-list .monaco-list-row').filter({hasText:'module-project'}).filter({visible:true}).first().click();
    await eventually(()=>page.locator('.monaco-editor:visible').innerText(),text=>text.includes('module-ui-test'),'module project editor');
    const basics=page.getByRole('treeitem',{name:'Basics',exact:true});
    if(await basics.getAttribute('aria-expanded')==='false')await basics.click();
    await page.getByRole('treeitem',{name:'C++ Modules Deps',exact:true}).click();
    const graph=await frameWith('#graph');
    await eventually(()=>graph.locator('#graph').innerText(),text=>text.includes('demo.l2'),'real module graph',35000);
    assert.match(await graph.locator('#graph').innerText(),/src\/main.cpp/);
    assert.match(await graph.locator('#graph').innerText(),/entry · lib · export module/);
    assert.doesNotMatch(await graph.locator('#graph').innerText(),/demo.l3|external.hidden/);
    await graph.locator('.node[data-node-key="demo.l2"] .fold-control').click();
    await eventually(()=>graph.locator('#graph').innerText(),text=>text.includes('demo.l3'),'expand one module level');
    await graph.locator('#graph-view-menu summary').click();
    await graph.locator('#graph-depth').selectOption('5');
    await eventually(()=>graph.locator('#graph').innerText(),text=>text.includes('demo.l4')&&!text.includes('demo.l5'),'five-level view');
    await graph.locator('#graph-view-menu summary').click();
    await graph.locator('#graph-depth').selectOption('all');
    await eventually(()=>graph.locator('#graph').innerText(),text=>text.includes('external.api'),'all internal depths');
    assert.doesNotMatch(await graph.locator('#graph').innerText(),/external.hidden/);
    assert.equal(await graph.locator('.node.index[data-node-key="external.api"]').count(),1,'local path package remains an external boundary');
    await graph.locator('#graph-search').fill('demo.l6');
    await graph.locator('#graph-search').press('Enter');
    await eventually(()=>graph.locator('.node.is-focused').textContent(),text=>text.includes('demo.l6'),'hidden module search focuses graph');
    await graph.locator('#graph-view-menu summary').click();
    await graph.locator('[data-action=overview]').click();
    await graph.locator('#graph-view-menu summary').click();
    await graph.locator('#graph-depth').selectOption('3');
    await eventually(()=>graph.locator('#graph').innerText(),text=>!text.includes('demo.l4'),'depth reset');
    await graph.locator('[data-zoom=fit]').click();
    await graph.locator('body').screenshot({path:path.join(artifacts,'module-graph.png')});
  });
  await check('module source opens read-only beside the graph and view state survives switching',async()=>{
    const graph=await frameWith('#graph');
    const original=await fs.readFile(path.join(scratch,'module-project/src/l0.cppm'),'utf8');
    await graph.locator('.node[data-node-key="demo.l0"]').click();
    assert.equal(await page.locator('.monaco-editor:visible').filter({hasText:'export module demo.l0;'}).count(),0,'single click only selects');
    await graph.locator('.node[data-node-key="demo.l0"]').click({button:'right'});
    await graph.locator('[data-context-action=locate]').click();
    assert.equal(await graph.locator('#graph-node-context').isVisible(),false,'node context menu closes after action');
    await graph.locator('.node[data-node-key="demo.l0"]').dblclick();
    const editor=page.locator('.monaco-editor:visible').filter({hasText:'export module demo.l0;'});
    await editor.waitFor();
    await editor.locator('.view-lines').click({position:{x:25,y:20}});
    await page.keyboard.type('MODULE_SOURCE_MUST_BE_READ_ONLY');
    assert.doesNotMatch(await editor.innerText(),/MODULE_SOURCE_MUST_BE_READ_ONLY/);
    assert.equal(await fs.readFile(path.join(scratch,'module-project/src/l0.cppm'),'utf8'),original);
    await page.keyboard.press('Escape');
    assert.equal(await graph.locator('#graph svg').count(),1,'graph remains mounted beside source');
    await graph.locator('[data-zoom=fit]').click();
    await graph.locator('[data-zoom="+"]').click();
    const transform=()=>graph.locator('#graph svg').evaluate(svg=>getComputedStyle(svg).transform);
    const before=await transform();
    await graph.locator('[data-mode=packages]').click();
    await eventually(()=>graph.locator('[data-mode=packages]').getAttribute('aria-pressed'),state=>state==='true','package mode');
    await eventually(()=>graph.locator('#graph').innerText(),text=>text.includes('module-ui-test'),'package graph restored');
    await graph.locator('[data-mode=modules]').click();
    await eventually(()=>graph.locator('.node.is-focused').textContent(),text=>text.includes('demo.l0'),'module selection restored');
    assert.equal(await transform(),before,'module viewport survives view switch');
    await page.screenshot({path:path.join(artifacts,'module-source-readonly.png')});
  });
  await check('module source dependency status refreshes without hiding or clearing usable rows', async()=>{
    const graph=await frameWith('#graph');
    await graph.locator('[data-mode=packages]').click();
    await eventually(()=>graph.locator('[data-mode=packages]').getAttribute('aria-pressed'),state=>state==='true','package mode for dependency state');
    const manifest=path.join(scratch,'module-project/mcpp.toml'), original=await fs.readFile(manifest,'utf8');
    const dependencyGroup=()=>page.getByRole('treeitem').filter({hasText:'Dependencies (1)'});
    try {
      await fs.writeFile(manifest,original.replace(/\[dependencies\][\s\S]*$/,''));
      const empty=page.getByRole('treeitem',{name:'This project declares no dependencies',exact:true});
      await empty.waitFor();assert.equal(await empty.getAttribute('aria-expanded'),null,'empty dependency status is one plain row');
      await fs.writeFile(manifest,original);await dependencyGroup().waitFor();
      await fs.writeFile(manifest,original+'\n[dev-dependencies]\nincomplete=');
      await eventually(()=>dependencyGroup().innerText(),text=>text.includes('Refresh pending'),'last dependencies preserved during incomplete manifest');
      await page.screenshot({path:path.join(artifacts,'dependency-state-stale.png')});
    } finally { await fs.writeFile(manifest,original); }
    await eventually(()=>dependencyGroup().innerText(),text=>!text.includes('Refresh pending'),'dependencies recover automatically');
  });
  if (process.env.MCPP_UI_REAL_PROJECT) await check('real mcppls modules graph navigates the large project and pages tests', async()=>{
    const realRoot=path.resolve(process.env.MCPP_UI_REAL_PROJECT);
    run(code, ['--extensions-dir', extensions, '--user-data-dir', userData, '--add', realRoot]);
    await palette('View: Single Column Editor Layout');
    await page.keyboard.press('Control+P');
    await page.locator('.quick-input-widget:visible input').fill(path.join(realRoot,'mcpp.toml'));
    await page.locator('.quick-input-list .monaco-list-row').filter({visible:true}).first().click();
    await eventually(()=>page.locator('.monaco-editor:visible').allTextContents().then(text=>text.join(' ')),text=>text.includes('[package]'),'real manifest');
    await palette('mcpp: Show C++ Modules Dependency Graph');
    const graph=await frameWith('#graph');
    await eventually(()=>graph.locator('#graph').innerText(),text=>text.includes('src/main.cpp')&&text.includes('mcpp.'),'large project graph',45000);
    assert.ok(await graph.locator('.edgePath,.flowchart-link').count()>0,'default entry has dependency edges');
    assert.ok(await graph.locator('.node').count()<=60,'visible node budget');
    await graph.locator('#graph-entries').selectOption('@group/tests');
    await eventually(()=>graph.locator('#entry-page').innerText(),text=>text.startsWith('1–20 /'),'first test page');
    await graph.locator('#entry-next').click();
    await eventually(()=>graph.locator('#entry-page').innerText(),text=>text.startsWith('21–40 /'),'second test page');
    const item=graph.locator('.node[data-node-key^="tests/"]').first();
    await item.click(); await graph.locator('[data-action=focus]').click();
    await eventually(()=>graph.locator('#focus-node').innerText(),text=>text.includes('tests/'),'focus selected test');
    await graph.locator('[data-action=locate]').click();
    await graph.locator('[data-zoom=fit]').click();
    await graph.locator('body').screenshot({path:path.join(artifacts,'large-project-tests.png')});
  });
  await fs.writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ checks, testedAt: new Date().toISOString(), codeVersion: run(code, ['--version']).trim(), mcppEnv: JSON.parse(run(realMcpp, ['self', 'env', '--format', 'json'])) }, null, 2));
  console.log(`UI checks passed. Evidence: ${artifacts}`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  await fs.writeFile(path.join(artifacts, 'failure.txt'), String(error.stack ?? error));
  throw error;
} finally { await browser.close(); }
