// End to end through the real browser extension: the agent drives tabs over chrome.debugger via the
// relay, and a human demonstration recorded by the extension is replayed by Flintrail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture.mjs';
import { connect, refOf, testEnv } from './helpers.mjs';

const extPath = new URL('../extension', import.meta.url).pathname;
const fakeOp = new URL('./fake-op.mjs', import.meta.url).pathname;
chmodSync(fakeOp, 0o755);
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
  // The "user's browser" profile. Flintrail registers its pairing host in it at startup, so the
  // extension fetches the token by itself: nobody pastes anything.
  const userDataDir = mkdtempSync(join(tmpdir(), 'flintrail-ext-'));
  mcp = await connect(testEnv({
    FLINTRAIL_MODE: 'extension', FLINTRAIL_RELAY_PORT: String(relayPort), FLINTRAIL_TOKEN: token,
    FLINTRAIL_RELAY: 'on', FLINTRAIL_PAIRING: 'on', FLINTRAIL_PAIRING_DIRS: userDataDir, FLINTRAIL_EXTENSION_WAIT: '1500',
    FLINTRAIL_PASSWORDS: `1password:${fakeOp}`,
  }));
  // A normal Chromium with the Flintrail extension installed.
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    // Extensions need the full Chromium (new headless), not the headless shell.
    ...(process.env.FLINTRAIL_CHROME ? { executablePath: process.env.FLINTRAIL_CHROME } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await waitFor(async () => /Extension connected/.test(await mcp.call('fl_extension')), 20000);
});

after(async () => {
  await ctx?.close();
  await mcp?.client.close();
  site?.server.close();
});

test('the extension pairs by itself and is listed by name', async () => {
  assert.match(sw.url(), /^chrome-extension:\/\/hgkglidmccenjlhdcplcpkgbadonplnb\//);
  const { paired } = await sw.evaluate(() => chrome.storage.local.get('paired'));
  assert.equal(paired, true);
  assert.match(await mcp.call('fl_extension'), /^chromium: Extension connected/m);
  await assert.rejects(mcp.call('fl_open', { url: site.url, browser: 'safari' }), /Browser "safari" is not connected to Flintrail\. Connected: chromium/);
  const snap = await mcp.call('fl_open', { url: site.url, browser: 'chromium', text: 0 });
  assert.match(snap, /^Tab t\d+ \[chromium\]/);
  await mcp.call('fl_close', { tab: /Tab (t\d+)/.exec(snap)[1] });
});

test('agent tabs open only in the agent window, never in the user\'s window', async () => {
  // The user works in one window and picks another one for the agent.
  const userWindow = await sw.evaluate(async () => (await chrome.windows.getAll())[0].id);
  const agentWindowId = await sw.evaluate(async () => (await chrome.windows.create({ focused: false, url: 'about:blank' })).id);
  await sw.evaluate((id) => chrome.storage.session.set({ agentWindow: id }), agentWindowId);
  const snap = await mcp.call('fl_open', { url: site.url, text: 0 });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  const windowOf = () => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '/*' })).map((t) => t.windowId), site.url);
  assert.deepEqual(await windowOf(), [agentWindowId]);
  assert.notEqual(agentWindowId, userWindow);
  await mcp.call('fl_close', { tab });

  // The agent window was closed: the agent opens a window of its own instead of using the user's.
  await sw.evaluate((id) => chrome.windows.remove(id), agentWindowId);
  const again = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: site.url, text: 0 }))[1];
  const [w] = await windowOf();
  assert.notEqual(w, userWindow);
  assert.notEqual(w, agentWindowId);
  await mcp.call('fl_close', { tab: again });
});

test('the opened tab is shown in its window, and survives the extension reconnecting', async () => {
  const snap = await mcp.call('fl_open', { url: site.url + '/search', browser: 'chromium', text: 0 });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  const shown = () => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u })).map((t) => t.active), site.url + '/search');
  assert.deepEqual(await shown(), [true]);
  // The browser restarts the extension's service worker now and then: its connection to the relay drops,
  // and the tab must stay driven by the same conversation once it is back.
  await sw.evaluate(() => ws.close());
  assert.match(await mcp.call('fl_snapshot', { tab }), /search/i);
  assert.match(await mcp.call('fl_tabs'), new RegExp(`${tab} .*\\/search`));
  await mcp.call('fl_close', { tab });
});

test('password filling follows the extension settings, and only the user answers a confirmation', async () => {
  const settings = (v) => sw.evaluate((s) => chrome.storage.local.set({ fillSettings: s }), v);
  const tab = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: site.url + '/login', browser: 'chromium', text: 0 }))[1];
  // A fresh load of the form: after a fill, the page is closed to scripts until it changes.
  const empty = () => mcp.call('fl_act', { tab, actions: [{ do: 'goto', url: site.url + '/login' }] });
  const leaks = (text) => text.includes('S3cret') || text.includes('123456');

  // Default: filled without asking, and recorded in the extension's history without any value.
  assert.match(await mcp.call('fl_login', { tab, submit: false }), /filled username, password, one-time code\./);
  const history = async () => (await sw.evaluate(() => chrome.storage.local.get('fillHistory'))).fillHistory || [];
  const fillHistory = await waitFor(async () => { const h = await history(); return h.length ? h : null; });
  assert.deepEqual([fillHistory[0].domain, fillHistory[0].item, fillHistory[0].approval], ['127.0.0.1', 'Fixture shop', 'silent']);
  assert.ok(!leaks(JSON.stringify(fillHistory)));

  await empty();
  await settings({ enabled: false });
  await assert.rejects(mcp.call('fl_login', { tab }), /Refused by the Flintrail extension settings in chromium: password filling is turned off/);
  // A subdomain in the list never allows its parent domain.
  await settings({ allDomains: false, domains: ['sub.127.0.0.1', 'github.com'] });
  await assert.rejects(mcp.call('fl_login', { tab }), /127\.0\.0\.1 is not one of the allowed domains/);
  await empty();
  await settings({ allDomains: false, domains: ['127.0.0.1'] });
  assert.match(await mcp.call('fl_login', { tab, submit: false }), /filled username, password, one-time code\./);

  await empty();
  await settings({ totp: false });
  const noCode = await mcp.call('fl_login', { tab, submit: false });
  assert.match(noCode, /filled username, password\. The page also asks for a code/);

  // Confirmation: a window of the extension asks; the agent cannot answer it, the user's click does.
  await settings({ confirm: true });
  for (const [button, expected] of [['#deny', /the user declined/], ['#allow', /confirmed by the user/]]) {
    await empty();
    const asked = ctx.waitForEvent('page', (p) => p.url().includes('/confirm.html'));
    const pending = mcp.call('fl_login', { tab, submit: false }).then((out) => out, (e) => e.message);
    const win = await asked;
    await win.waitForSelector('#domain:not(:empty)');
    assert.equal(await win.textContent('#domain'), '127.0.0.1');
    assert.match(await win.textContent('#item'), /Fixture shop/);
    // While the user decides, the agent can run no script in that tab (it would catch the value).
    assert.match(await mcp.call('fl_extract', { tab, js: 'return 1' }), /Blocked: fl_login is filling this tab/);
    // A bare click, as an app driving the accessibility tree would send, answers nothing.
    await win.waitForSelector('#allow:not([disabled])');
    await win.evaluate(() => document.getElementById('allow').click());
    await win.waitForTimeout(300);
    assert.ok(!win.isClosed(), 'a click without a real press must be ignored');
    await win.click(button);
    const out = await pending;
    assert.match(out, expected);
    assert.ok(!leaks(out));
  }
  await waitFor(async () => (await history())[0]?.approval === 'confirmed by the user');
  await settings({});
  await mcp.call('fl_close', { tab });
});

test('an agent takes over a tab the user has open, unless the settings say no', async () => {
  const settings = (v) => sw.evaluate((s) => chrome.storage.local.set({ adoptSettings: s }), v);
  // The user's own tab, never shared from the extension.
  const own = await ctx.newPage();
  await own.goto(site.url + '/details');
  const adopted = await mcp.call('fl_adopt', { url: '/details', browser: 'chromium', text: 0 });
  assert.match(adopted, /^Tab t\d+ \[chromium\]/);
  const tab = /Tab (t\d+)/.exec(adopted)[1];
  assert.match(await mcp.call('fl_snapshot', { tab }), /details/i);
  await mcp.call('fl_close', { tab });

  const again = await ctx.newPage();
  await again.goto(site.url + '/details');
  // An empty address would match any tab: refused before reaching the browser.
  await assert.rejects(mcp.call('fl_adopt', { url: '', browser: 'chromium' }), /at least 3|too_small|>=3/i);
  await settings({ adoptOpenTabs: false });
  await assert.rejects(mcp.call('fl_adopt', { url: '/details', browser: 'chromium' }), /taking over open tabs is turned off/);
  await settings({ adoptOpenTabs: true, neverAdopt: ['127.0.0.1'] });
  await assert.rejects(mcp.call('fl_adopt', { url: '/details', browser: 'chromium' }), /127\.0\.0\.1 is in the Flintrail extension's list of sites agents never take over/);
  await settings({});
  await again.close();
});

test('browser and extension pages, the settings included, are never driven', async () => {
  const settingsPage = `chrome-extension://${new URL(sw.url()).host}/options.html`;
  await assert.rejects(mcp.call('fl_open', { url: settingsPage, browser: 'chromium' }), /never opens browser or extension pages/);
  const tab = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: site.url, browser: 'chromium', text: 0 }))[1];
  assert.match(await mcp.call('fl_act', { tab, actions: [{ do: 'goto', url: 'chrome://settings' }] }), /never opens browser or extension pages/);
  assert.doesNotMatch(await mcp.call('fl_tabs'), /chrome:\/\/settings/);
  await mcp.call('fl_close', { tab });
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

test('upload, dialogs and coordinate clicks work through the extension too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fl-ext-up-'));
  const file = join(dir, 'releve.csv');
  writeFileSync(file, 'abc');
  const up = await mcp.call('fl_open', { url: site.url + '/upload', text: 0 });
  const upTab = /Tab (t\d+)/.exec(up)[1];
  assert.match(await mcp.call('fl_act', { tab: upTab, actions: [{ do: 'upload', selector: '#file', files: [file] }] }), /Got releve\.csv:3/);
  assert.match(await mcp.call('fl_act', { tab: upTab, diff: false, actions: [{ do: 'upload', ref: refOf(up, /Choose files/), files: [file] }] }), /Got releve\.csv:3/);
  await mcp.call('fl_close', { tab: upTab });

  const dlg = await mcp.call('fl_open', { url: site.url + '/dialogs', text: 0 });
  const dlgTab = /Tab (t\d+)/.exec(dlg)[1];
  const accepted = await mcp.call('fl_act', { tab: dlgTab, actions: [{ do: 'dialog', accept: true }, { do: 'click', role: 'button', name: 'Delete' }] });
  assert.match(accepted, /Deleted/);
  await mcp.call('fl_close', { tab: dlgTab });

  const cv = await mcp.call('fl_open', { url: site.url + '/canvas', text: 0 });
  const cvTab = /Tab (t\d+)/.exec(cv)[1];
  assert.match(await mcp.call('fl_act', { tab: cvTab, actions: [{ do: 'mouse', x: 150, y: 230 }] }), /Hit 150,230/);
  await mcp.call('fl_close', { tab: cvTab });
});
