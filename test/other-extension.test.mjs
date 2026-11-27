// Another extension putting its own frame in a page (a password manager's autofill menu) makes the browser stop
// any extension from driving that tab. The agent is told so, with what to change, instead of "tab not found".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture.mjs';
import { connect, testEnv } from './helpers.mjs';

const extPath = new URL('../extension', import.meta.url).pathname;
const otherPath = new URL('./fake-password-manager', import.meta.url).pathname;
let site, mcp, ctx;

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

before(async () => {
  site = await startFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'rocketwright-other-'));
  mcp = await connect(testEnv({
    ROCKETWRIGHT_MODE: 'extension', ROCKETWRIGHT_RELAY_PORT: String(await freePort()), ROCKETWRIGHT_TOKEN: 'other-' + Math.random().toString(36).slice(2),
    ROCKETWRIGHT_RELAY: 'on', ROCKETWRIGHT_PAIRING: 'on', ROCKETWRIGHT_PAIRING_DIRS: userDataDir,
  }));
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(process.env.ROCKETWRIGHT_CHROME ? { executablePath: process.env.ROCKETWRIGHT_CHROME } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extPath},${otherPath}`, `--load-extension=${extPath},${otherPath}`],
  });
  await waitFor(async () => /chromium: Extension connected/.test(await mcp.call('fl_extension')));
});

after(async () => {
  await ctx?.close();
  await mcp?.client.close();
  site?.server.close();
});

test('a frame of another extension: the agent is told why the tab is no longer driven', async () => {
  const tab = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: site.url + '/login', browser: 'chromium', text: 0 }))[1];
  // The agent's next call on that tab gets the reason (the extension finds it out within a moment).
  const err = await waitFor(() => mcp.call('fl_snapshot', { tab }).then(() => null, (e) => (/no longer driven/.test(e.message) ? e.message : null)));
  assert.match(err, /no longer driven: another extension \(a password manager\?\) put its own frame in this page.*"Site access" to "On click"/);
  // A page without a password field is not touched by that extension and stays driven.
  const plain = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: site.url, browser: 'chromium', text: 0 }))[1];
  await new Promise((r) => setTimeout(r, 1500));
  assert.match(await mcp.call('fl_snapshot', { tab: plain, text: 0 }), /URL:/);
  await mcp.call('fl_close', { tab: plain });
});

test('the agent is warned as soon as another extension puts its widget in a page it drives', async () => {
  const snap = await mcp.call('fl_open', { url: site.url + '/search', browser: 'chromium', text: 0 });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  assert.doesNotMatch(snap, /another extension/);
  // What 1Password adds next to a field it can fill.
  const page = ctx.pages().find((p) => p.url().includes('/search'));
  await page.evaluate(() => document.body.append(document.createElement('com-1password-button')));
  const warned = await waitFor(async () => { const s = await mcp.call('fl_snapshot', { tab, text: 0 }); return /Warning: another extension \(1Password\)/.test(s) ? s : null; });
  assert.match(warned, /"Site access" to "On click"/);
  await mcp.call('fl_close', { tab });
});

test('a page that already holds a password manager widget is said so the moment the agent takes it', async () => {
  // The user's own tab, not driven: the widget is there before any agent.
  const page = await ctx.newPage();
  await page.goto(site.url + '/search?before=1');
  await page.evaluate(() => document.body.append(document.createElement('com-1password-button')));
  await new Promise((r) => setTimeout(r, 1800));
  const snap = await mcp.call('fl_adopt', { url: '/search?before=1', browser: 'chromium', text: 0 });
  assert.match(snap, /Warning: another extension \(1Password\) put its own frame in this page/);
  const tab = /Tab (t\d+)/.exec(snap)[1];
  await mcp.call('fl_release', { tab });
  await page.close();
});
