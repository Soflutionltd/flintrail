// End to end through the real browser extension: the agent drives tabs over chrome.debugger via the
// relay, and a human demonstration recorded by the extension is replayed by Flintrail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture.mjs';
import { connect, refOf, testEnv } from './helpers.mjs';

const extPath = new URL('../extension', import.meta.url).pathname;
const token = 'test-token-' + Math.random().toString(36).slice(2);
let site, mcp, ctx, sw;

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitFor(fn, ms = 10000) {
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
  const relayPort = await freePort();
  mcp = await connect(testEnv({ FLINTRAIL_MODE: 'extension', FLINTRAIL_RELAY_PORT: String(relayPort), FLINTRAIL_TOKEN: token }));
  // The "user's browser": a normal Chromium with the Flintrail extension installed.
  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'flintrail-ext-')), {
    headless: true,
    // Extensions need the full Chromium (new headless), not the headless shell.
    ...(process.env.FLINTRAIL_CHROME ? { executablePath: process.env.FLINTRAIL_CHROME } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await sw.evaluate(async ([token, port]) => {
    await chrome.storage.local.set({ token, port, autoConnect: true });
    await connect();
  }, [token, relayPort]);
  await waitFor(async () => /Extension connected/.test(await mcp.call('fl_extension')));
});

after(async () => {
  await ctx?.close();
  await mcp?.client.close();
  site?.server.close();
});

test('agent drives the browser through the extension', async () => {
  const snap = await mcp.call('fl_open', { url: site.url });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  assert.match(snap, /Parking permit/);
  const out = await mcp.call('fl_act', {
    tab,
    actions: [
      { do: 'fill', ref: refOf(snap, /Plate/), value: 'EXT-1' },
      { do: 'check', ref: refOf(snap, /checkbox/) },
      { do: 'click', role: 'button', name: 'Continue' },
      { do: 'click', selector: '[data-testid=confirm]' },
      { do: 'wait', text: 'active' },
    ],
  });
  assert.match(out, /Ticket T\d+ active/);
  assert.equal(site.orders.at(-1).plate, 'EXT-1');
  // The tab really lives in the user's browser.
  assert.ok(ctx.pages().some((p) => p.url().includes('/details')));
  await mcp.call('fl_close', { tab });
});

test('teach by demonstration, then replay with a variable', async () => {
  const page = await ctx.newPage();
  await page.goto(site.url);
  const started = await sw.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({ url: url + '/*' })).sort((a, b) => b.id - a.id)[0];
    return startDemo('demo-permit', tab);
  }, site.url);
  assert.match(started, /Recording "demo-permit" started/);
  await page.waitForTimeout(200);

  // The human does the task by hand.
  await page.click('input[name=plate]');
  await page.keyboard.type('HUMAN-1');
  await page.click('input[type=checkbox]');
  await page.click('button[type=submit]');
  await page.click('[data-testid=confirm]');
  await page.waitForSelector('#done');
  assert.equal(site.orders.at(-1).plate, 'HUMAN-1');

  const saved = await sw.evaluate(() => stopDemo());
  assert.match(saved, /Flow "demo-permit" saved: 4 steps/);
  const flow = JSON.parse(await mcp.call('fl_flow', { name: 'demo-permit' }));
  assert.deepEqual(flow.steps.map((s) => s.do), ['fill', 'check', 'click', 'click']);
  assert.equal(flow.steps[0].value, 'HUMAN-1');

  assert.match(await mcp.call('fl_flow_set_var', { name: 'demo-permit', step: 0, var: 'plate' }), /\{\{plate\}\}/);
  const run = await mcp.call('fl_run', { name: 'demo-permit', vars: { plate: 'REPLAY-9' } });
  assert.match(run, /^OK "demo-permit"/);
  assert.equal(site.orders.at(-1).plate, 'REPLAY-9');
  await page.close();
});

test('passwords are never recorded', async () => {
  const page = await ctx.newPage();
  await page.goto('data:text/html,<input type=password id=p><button>Go</button>');
  await page.goto(site.url);
  await sw.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({ url: url + '/*' })).sort((a, b) => b.id - a.id)[0];
    return startDemo('demo-secret', tab);
  }, site.url);
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const i = document.createElement('input'); i.type = 'password'; i.id = 'pw'; document.body.prepend(i);
  });
  await page.click('#pw');
  await page.keyboard.type('hunter2');
  await page.click('input[type=checkbox]');
  await sw.evaluate(() => stopDemo());
  const flow = await mcp.call('fl_flow', { name: 'demo-secret' });
  assert.doesNotMatch(flow, /hunter2/);
  await page.close();
});
