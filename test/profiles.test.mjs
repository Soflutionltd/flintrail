// Browser profiles of this computer: the relay names each connected browser after its profile
// ("Soflution"), agents pick a window of it or a new one, and a profile that is not open is listed and
// opened on demand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture.mjs';
import { connect, testEnv } from './helpers.mjs';

const extPath = new URL('../extension', import.meta.url).pathname;
let site, mcp, ctx, userDataDir;

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Chrome may restart the extension's service worker under load: always talk to the current one.
const worker = async () => ctx.serviceWorkers()[0] || ctx.waitForEvent('serviceworker');
const sw = { evaluate: async (fn, arg) => (await worker()).evaluate(fn, arg) };
const tabId = (snap) => /Tab (t\d+)/.exec(snap)[1];
const windowsOf = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u })).map((t) => t.windowId), url);

before(async () => {
  site = await startFixture();
  userDataDir = mkdtempSync(join(tmpdir(), 'flintrail-profiles-'));
  mcp = await connect(testEnv({
    FLINTRAIL_MODE: 'extension', FLINTRAIL_RELAY_PORT: String(await freePort()), FLINTRAIL_TOKEN: 'profiles-' + Math.random().toString(36).slice(2),
    FLINTRAIL_RELAY: 'on', FLINTRAIL_PAIRING: 'on', FLINTRAIL_PAIRING_DIRS: userDataDir, FLINTRAIL_EXTENSION_WAIT: '2000',
  }));
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(process.env.FLINTRAIL_CHROME ? { executablePath: process.env.FLINTRAIL_CHROME } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });
  await waitFor(async () => /chromium: Extension connected/.test(await mcp.call('fl_extension')));
  // The user named this profile "Soflution", and has a second profile, "Compta", that is not open.
  const state = JSON.parse(readFileSync(join(userDataDir, 'Local State'), 'utf8'));
  state.profile = { ...(state.profile || {}), info_cache: { Default: { name: 'Soflution' }, 'Profile 7': { name: 'Compta' } } };
  mkdirSync(join(userDataDir, 'Profile 7'), { recursive: true });
  writeFileSync(join(userDataDir, 'Local State'), JSON.stringify(state));
  await sw.evaluate(async () => { ws?.close(); ws = null; await connect(); });
  await waitFor(async () => /chromium-soflution: /.test(await mcp.call('fl_extension')));
});

after(async () => {
  await ctx?.close();
  await mcp?.client.close();
  site?.server.close();
});

test('a connected browser is named after its profile, and picked by that name', async () => {
  const listed = await mcp.call('fl_extension');
  assert.match(listed, /^chromium-soflution: Extension connected \(Chromium, profile "Soflution", extension 1\.5\.3\)/m);
  const snap = await mcp.call('fl_open', { url: site.url, browser: 'Soflution', text: 0 });
  assert.match(snap, /^Tab t\d+ \[chromium-soflution\]/);
  await mcp.call('fl_close', { tab: tabId(snap) });
});

test('a tab opens in the window the agent names, or in a new window', async () => {
  const userWindow = await sw.evaluate(async () => (await chrome.windows.create({ focused: false, url: 'about:blank' })).id);
  const listed = await mcp.call('fl_extension', { tabs: true });
  assert.match(listed, new RegExp(`window ${userWindow}: \\(blank\\)`));
  const inWindow = tabId(await mcp.call('fl_open', { url: site.url + '/search', browser: 'Soflution', window: userWindow, text: 0 }));
  assert.deepEqual(await windowsOf(site.url + '/search'), [userWindow]);
  const before = await sw.evaluate(async () => (await chrome.windows.getAll()).map((w) => w.id));
  const inNew = tabId(await mcp.call('fl_open', { url: site.url + '/upload', browser: 'Soflution', newWindow: true, text: 0 }));
  const [created] = await windowsOf(site.url + '/upload');
  assert.ok(!before.includes(created), 'opened in a window that did not exist before');
  await assert.rejects(mcp.call('fl_open', { url: site.url, browser: 'Soflution', window: 999999 }), /Window 999999 is closed/);
  // Opened at the same time, each tab still lands in the window asked for.
  const [one, two] = await Promise.all([
    mcp.call('fl_open', { url: site.url + '/canvas', browser: 'Soflution', window: userWindow, text: 0 }),
    mcp.call('fl_open', { url: site.url + '/login', browser: 'Soflution', newWindow: true, text: 0 }),
  ]);
  assert.deepEqual(await windowsOf(site.url + '/canvas'), [userWindow]);
  const [loginWindow] = await windowsOf(site.url + '/login');
  assert.ok(loginWindow !== userWindow && !before.includes(loginWindow), 'the newWindow tab got its own window');
  await mcp.call('fl_close', { tab: tabId(one) });
  await mcp.call('fl_close', { tab: tabId(two) });
  // Extension mode has no dedicated browser: without a name, newWindow applies to the first user browser.
  const unnamed = await mcp.call('fl_open', { url: site.url + '/dialogs', newWindow: true, text: 0 });
  assert.match(unnamed, /^Tab t\d+ \[chromium-soflution\]/);
  const [unnamedWindow] = await windowsOf(site.url + '/dialogs');
  assert.ok(!before.includes(unnamedWindow) && unnamedWindow !== created, 'opened in yet another new window');
  await mcp.call('fl_close', { tab: tabId(unnamed) });
  await mcp.call('fl_close', { tab: inWindow });
  await mcp.call('fl_close', { tab: inNew });
});

test('a profile that is not open is listed, and fl_open says how to open it', async () => {
  assert.match(await mcp.call('fl_extension'), /Not open \(fl_open with browser "<profile name>" opens it\): chromium "Compta"/);
  // Test browsers have no application to launch: Flintrail says so instead of waiting forever.
  await assert.rejects(mcp.call('fl_open', { url: site.url, browser: 'Compta' }), /cannot open chromium profile "Compta" by itself/);
});

test('on macOS a profile opens with its own application and profile folder', { skip: platform() !== 'darwin' }, async () => {
  const { openCommand } = await import('../dist/profiles.js');
  assert.deepEqual(
    openCommand({ brand: 'brave', dataDir: '/x', app: 'Brave Browser', dir: 'Profile 1', name: 'Soflution' }),
    ['open', ['-na', 'Brave Browser', '--args', '--profile-directory=Profile 1']],
  );
  assert.equal(openCommand({ brand: 'arc', dataDir: '/x', app: null, dir: 'Default', name: 'Arc' }), null);
});
