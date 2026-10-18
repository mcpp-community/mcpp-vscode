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
await fs.writeFile(manifestPath, baseManifest);
await fs.writeFile(path.join(scratch, 'secondary/mcpp.toml'), '[package]\nname = "secondary"\nversion = "0.1.0"\n');
const wrapper = path.join(scratch, 'mcpp-ui.cjs');
await fs.writeFile(wrapper, `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
if(args[0]==='xpkg' && fs.existsSync(path.join(__dirname,'fail-parse'))) { console.error('forced parse failure'); process.exit(17); }
if(args[0]==='add' && fs.existsSync(path.join(__dirname,'fail-add'))) { console.error('forced add failure'); process.exit(17); }
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
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
await fs.rm(path.join(scratch, 'fail-parse'), { force: true });
await fs.writeFile(path.join(scratch, '.vscode/settings.json'), JSON.stringify({
  'mcpp.path': wrapper, 'mcpp.library.indexPath': '', 'mcpp.library.networkSearch': false,
  'mcpp.ui.language': 'en', 'mcpp.diagnostics.selfCheckOnStartup': false,
  'mcpp.toml.indexCompletion': false,
}, null, 2));
const userSettings = { 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.colorTheme': 'Default Dark Modern', 'window.title': 'Libraries automated review · ${rootName}', 'git.openRepositoryInParentFolders': 'never' };
const settingsFile = path.join(userData, 'User/settings.json');
await fs.writeFile(settingsFile, JSON.stringify(userSettings));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
console.log(run(code, ['--extensions-dir', extensions, '--user-data-dir', userData, '--install-extension', path.join(root, `mcpp-vscode-${version}.vsix`), '--force']).trim());
run(code, ['--new-window', '--remote-debugging-port=9334', '--extensions-dir', extensions, '--user-data-dir', userData, '--disable-workspace-trust', '--skip-welcome', scratch]);
let browser;
await eventually(async () => { browser = await chromium.connectOverCDP(endpoint); return true; }, Boolean, 'VS Code CDP startup');
const page = browser.contexts()[0].pages()[0];
await page.setViewportSize({ width: 1600, height: 1000 });
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
  const start = Date.now(); await action();
  checks.push({ name, elapsedMs: Date.now() - start, ok: true });
  console.log(`PASS ${name}`);
}
async function openPackage(id) {
  const list = await frameWith('#library-search');
  await list.locator('#library-search').fill(id);
  await list.locator(`[data-id="${id}"]`).click();
  const detail = await frameWith('#detail-main');
  await eventually(() => detail.locator('.detail-title').innerText(), (text) => text === id, 'detail identity');
  await eventually(() => detail.locator('.detail-primary').getAttribute('aria-busy'), (value) => value === 'false', 'detail loaded');
  return detail;
}
try {
  await eventually(() => page.locator('.statusbar').innerText(), (text) => /\bmcpp\b/.test(text), 'extension activation', 30000);
  const reloaded = page.waitForEvent('domcontentloaded', { timeout: 20000 });
  await palette('Developer: Reload Window');
  await reloaded;
  await eventually(() => page.locator('.statusbar').innerText(), (text) => /\bmcpp\b/.test(text), 'extension reactivation', 30000);
  await palette('mcpp: Search and Add a Dependency');
  const list = await frameWith('#library-search');
  await eventually(() => list.locator('[data-row]').count(), (count) => count > 200, 'official catalog');
  await check('official catalog and existing declaration', async () => {
    assert.match(await list.locator('#library-footer').innerText(), /mcpp-index/);
    assert.equal(await list.locator('[data-cross="false"]').count(), await list.locator('[data-row]').count());
    const detail = await openPackage('compat.argparse');
    assert.equal(await detail.locator('#detail-version').inputValue(), '3.2');
    assert.equal(await detail.locator('#detail-add').isDisabled(), true);
    assert.match(await detail.locator('.project-context').innerText(), /libraries-ui-test/);
    assert.equal(await detail.locator('button[data-version]').count(), 0);
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
      for (const width of [480, 800, 1200]) {
        await page.setViewportSize({ width: width + occupied, height: 1000 });
        await page.waitForTimeout(150);
        const geometry = await detail.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, display: getComputedStyle(document.querySelector('.detail-layout')).display, columns: getComputedStyle(document.querySelector('.detail-layout')).gridTemplateColumns }));
        assert.equal(geometry.display, geometry.width < 900 ? 'block' : 'grid');
        assert.ok(geometry.document <= geometry.width + 1, `${theme} width ${width}: page overflows ${JSON.stringify(geometry)}`);
        layouts.push({ theme, viewport: width, ...geometry });
        await page.screenshot({ path: path.join(artifacts, `${className}-${width}.png`) });
      }
    }
    await fs.writeFile(path.join(artifacts, 'layouts.json'), JSON.stringify(layouts, null, 2));
  });
  await fs.writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ checks, testedAt: new Date().toISOString(), codeVersion: run(code, ['--version']).trim(), mcppEnv: JSON.parse(run(realMcpp, ['self', 'env', '--format', 'json'])) }, null, 2));
  console.log(`UI checks passed. Evidence: ${artifacts}`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  await fs.writeFile(path.join(artifacts, 'failure.txt'), String(error.stack ?? error));
  throw error;
} finally { await browser.close(); }
