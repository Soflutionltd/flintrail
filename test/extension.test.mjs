// End to end through the real browser extension: the agent drives tabs over chrome.debugger via the
// relay, and a human demonstration recorded by the extension is replayed by Rocketwright.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture.mjs';
import { connect, refOf, testEnv, zipEntries } from './helpers.mjs';

const extPath = new URL('../extension', import.meta.url).pathname;
const fakeOp = new URL('./fake-op.mjs', import.meta.url).pathname;
chmodSync(fakeOp, 0o755);
const fakeStore = new URL('./fake-store.mjs', import.meta.url).pathname;
chmodSync(fakeStore, 0o755);
// A fake vault value, built at run time (no credential-looking string in the repository).
const vaultValue = 'vault-' + 'Q7'.repeat(12);
const storeOut = join(mkdtempSync(join(tmpdir(), 'rocketwright-store-')), 'stored.jsonl');
const stored = () => { try { return readFileSync(storeOut, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
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
  // The "user's browser" profile. Rocketwright registers its pairing host in it at startup, so the
  // extension fetches the token by itself: nobody pastes anything.
  const userDataDir = mkdtempSync(join(tmpdir(), 'rocketwright-ext-'));
  mcp = await connect(testEnv({
    ROCKETWRIGHT_MODE: 'extension', ROCKETWRIGHT_RELAY_PORT: String(relayPort), ROCKETWRIGHT_TOKEN: token,
    ROCKETWRIGHT_RELAY: 'on', ROCKETWRIGHT_PAIRING: 'on', ROCKETWRIGHT_PAIRING_DIRS: userDataDir, ROCKETWRIGHT_EXTENSION_WAIT: '1500',
    ROCKETWRIGHT_PASSWORDS: `1password:${fakeOp}`,
    ROCKETWRIGHT_MCPHUB: fakeStore, FAKE_STORE_OUT: storeOut, FAKE_VAULT_NAMES: 'EXISTING_TOKEN,OTHER,OLD_FORMAT', FAKE_VAULT_OLD_FORMAT: 'OLD_FORMAT', FAKE_VAULT_VALUE: vaultValue,
  }));
  // A normal Chromium with the Rocketwright extension installed.
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    // Extensions need the full Chromium (new headless), not the headless shell.
    ...(process.env.ROCKETWRIGHT_CHROME ? { executablePath: process.env.ROCKETWRIGHT_CHROME } : { channel: 'chromium' }),
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
  await assert.rejects(mcp.call('fl_open', { url: site.url, browser: 'safari' }), /Browser "safari" is not connected to Rocketwright\. Connected: chromium/);
  const snap = await mcp.call('fl_open', { url: site.url, browser: 'chromium', text: 0 });
  assert.match(snap, /^Tab t\d+ \[chromium\]/);
  await mcp.call('fl_close', { tab: /Tab (t\d+)/.exec(snap)[1] });
});

test('the popup shows the browser\'s name, ready to change, and a name typed whole is kept as it is', async () => {
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('label').value !== '');
  assert.equal(await popup.inputValue('#label'), 'chromium');
  await popup.close();
  const rename = async (label, expected) => {
    await sw.evaluate(async (l) => { await chrome.storage.local.set({ label: l }); ws?.close(); ws = null; await connect(); }, label);
    await waitFor(async () => new RegExp(`^${expected}: Extension connected`, 'm').test(await mcp.call('fl_extension')));
  };
  await rename('chromium', 'chromium');
  await rename('chromium-perso', 'chromium-perso');
  await rename('Travail', 'chromium-travail');
  await rename('', 'chromium');
});

test('agent tabs open in the window the user picked for the agent, else in the window used last, never a new one', async () => {
  // The user works in one window and picks another one for the agent.
  const userWindow = await sw.evaluate(async () => (await chrome.windows.getAll())[0].id);
  const agentWindowId = await sw.evaluate(async () => (await chrome.windows.create({ focused: false, url: 'about:blank' })).id);
  await sw.evaluate((id) => chrome.storage.session.set({ pickedAgentWindow: id }), agentWindowId);
  const snap = await mcp.call('fl_open', { url: site.url, text: 0 });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  const windowOf = () => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '/*' })).map((t) => t.windowId), site.url);
  assert.deepEqual(await windowOf(), [agentWindowId]);
  assert.notEqual(agentWindowId, userWindow);
  await mcp.call('fl_close', { tab });

  // The agent window was closed: the tab goes to a window the user already has, no new window.
  await sw.evaluate((id) => chrome.windows.remove(id), agentWindowId);
  const windows = () => sw.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] })).length);
  const before = await windows();
  const again = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: site.url, text: 0 }))[1];
  const [w] = await windowOf();
  assert.notEqual(w, agentWindowId);
  assert.equal(await windows(), before);
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
  await assert.rejects(mcp.call('fl_login', { tab }), /Refused by the Rocketwright extension settings in chromium: password filling is turned off/);
  // Vaults the user left out in the extension settings are never searched.
  await settings({ vaultsDeny: ['test'] });
  await assert.rejects(mcp.call('fl_login', { tab }), /never test; 1 matching login\(s\) left out by those settings/);
  await settings({ vaultsAllow: ['Clients'] });
  await assert.rejects(mcp.call('fl_login', { tab }), /only Clients/);
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
  await assert.rejects(mcp.call('fl_adopt', { url: '/details', browser: 'chromium' }), /127\.0\.0\.1 is in the Rocketwright extension's list of sites agents never take over/);
  await settings({});
  await again.close();
});

test('fl_open takes over the tab already showing the address, and fl_release lets it go without closing it', async () => {
  const own = await ctx.newPage();
  await own.goto(site.url + '/search?q=mine');
  const count = () => sw.evaluate(async () => (await chrome.tabs.query({})).length);
  const before = await count();
  const snap = await mcp.call('fl_open', { url: site.url + '/search', browser: 'chromium', text: 0 });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  assert.match(snap, /search\?q=mine/, 'the user\'s own tab, not a new one');
  assert.equal(await count(), before);
  assert.match(await mcp.call('fl_release', { tab }), /released: still open/);
  assert.doesNotMatch(await mcp.call('fl_tabs'), new RegExp(`${tab} `));
  assert.ok(!own.isClosed());
  const driven = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' })).some((t) => attached.has(t.id)), site.url + '/search');
  assert.equal(driven, false, 'no longer attached, so the debugging bar can go');
  // One more tab of a site the user already has open is refused, by newTab as by newWindow...
  await assert.rejects(
    mcp.call('fl_open', { url: site.url + '/search', browser: 'chromium', newTab: true, text: 0 }),
    /is already open in chromium: use that tab instead of opening one more/
  );
  await assert.rejects(
    mcp.call('fl_open', { url: site.url + '/details', browser: 'chromium', newWindow: true, text: 0 }),
    /is already open in chromium/
  );
  assert.equal(await count(), before, 'nothing was opened');
  // ... unless it is asked for on purpose.
  const fresh = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: site.url + '/search', browser: 'chromium', newTab: true, evenIfSiteOpen: true, text: 0 }))[1];
  assert.equal(await count(), before + 1);
  await mcp.call('fl_close', { tab: fresh });
  await own.close();
});

test('fl_open brings the tab this conversation already drives to another page of its site, and refuses a second one', async () => {
  const count = () => sw.evaluate(async () => (await chrome.tabs.query({})).length);
  const first = await mcp.call('fl_open', { url: site.url + '/details', browser: 'chromium', text: 0 });
  const tab = /Tab (t\d+)/.exec(first)[1];
  const before = await count();
  const second = await mcp.call('fl_open', { url: site.url + '/search?q=next', browser: 'chromium', text: 0 });
  assert.equal(/Tab (t\d+)/.exec(second)[1], tab, 'the same tab');
  assert.match(second, new RegExp(`Tab ${tab} was already yours, on .*/details: it went to this address`), 'the agent is told the page it held is gone');
  assert.match(second, /URL: .*\/search\?q=next/);
  assert.equal(await count(), before, 'no second tab of the site');
  await assert.rejects(
    mcp.call('fl_open', { url: site.url + '/upload', browser: 'chromium', newTab: true, text: 0 }),
    new RegExp(`is already open in chromium \\(tab ${tab} of this conversation\\)`)
  );
  assert.equal(await count(), before);
  await mcp.call('fl_close', { tab });
});

test('fl_open on another page of a site the user has open brings that tab there, in its own window', async () => {
  const own = await ctx.newPage();
  await own.goto(site.url + '/details');
  const count = () => sw.evaluate(async () => (await chrome.tabs.query({})).length);
  const before = await count();
  const snap = await mcp.call('fl_open', { url: site.url + '/search?q=asked', browser: 'chromium', text: 0 });
  assert.match(snap, /URL: .*\/search\?q=asked/);
  assert.equal(await count(), before, 'no new tab, no new window');
  assert.match(own.url(), /\/search\?q=asked/, 'the user\'s own tab went to the page asked for');
  await mcp.call('fl_release', { tab: /Tab (t\d+)/.exec(snap)[1] });
  await own.close();
});

test('fl_open never takes a tab of another site whose address merely mentions the one asked for', async () => {
  // localhost is another site than 127.0.0.1, even on the same server.
  const decoy = await ctx.newPage();
  await decoy.goto(site.url.replace('127.0.0.1', 'localhost') + '/details?next=' + encodeURIComponent(site.url) + '&raw=' + site.url + '/search');
  const tab = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: site.url + '/search', browser: 'chromium', text: 0 }))[1];
  assert.match(decoy.url(), /^http:\/\/localhost/, 'the other site\'s tab was left alone');
  await mcp.call('fl_close', { tab });
  await decoy.close();
});

test('a new tab goes to the window that already holds the site, never to a new window', async () => {
  // The user has the site open in a second window, in a tab another agent already drives (so it is not taken).
  const other = await sw.evaluate(async (u) => (await chrome.windows.create({ focused: false, url: u + '/details' })).id, site.url);
  await waitFor(async () => (await sw.evaluate(async (w) => (await chrome.tabs.query({ windowId: w }))[0]?.url, other))?.includes('/details'));
  const busy = await sw.evaluate(async (w) => { const [t] = await chrome.tabs.query({ windowId: w }); await attach(t.id); return t.id; }, other);
  const windows = () => sw.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] })).length);
  const before = await windows();
  const tab = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: site.url + '/search', browser: 'chromium', text: 0 }))[1];
  assert.equal(await windows(), before);
  const where = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '/search' })).map((t) => t.windowId), site.url);
  assert.deepEqual(where, [other]);
  await mcp.call('fl_close', { tab });
  await sw.evaluate(async ({ w, t }) => { await detach(t); await chrome.windows.remove(w); }, { w: other, t: busy });
});

test('fl_capture_secret puts a token a page shows once straight into the vault, never in a reply', async () => {
  // Fake values, built at run time (no credential-looking string in the repository).
  const token = 'github_pat_' + '11AAAA0000' + 'b'.repeat(72);
  const other = 'github_pat_' + '22CCCC1111' + 'd'.repeat(72);
  const page = await ctx.newPage();
  await page.goto(`${site.url}/token-created?t=${token}`);
  // A tab the agent already drives on that site: sealed once the secret is captured.
  const own = /Tab (t\d+)/.exec(await mcp.call('fl_adopt', { url: '/token-created', browser: 'chromium', text: 0 }))[1];
  // The test site is not github.com: a known kind is only taken on the site that issues it, and every miss reads the same.
  await assert.rejects(mcp.call('fl_capture_secret', { browser: 'chromium', url: '/token-created', kind: 'github', to: 'mcphub:X' }), /Nothing captured \(or not confirmed by the user\): no single github secret on an open github\.com page matching that address/);
  // Any other kind: a literal prefix, and the user's click.
  const confirm = async (call, answer = '#allow') => {
    const asked = ctx.waitForEvent('page', (p) => p.url().includes('/confirm.html'));
    const pending = mcp.call('fl_capture_secret', call);
    pending.catch(() => { /* checked by the caller */ });
    const win = await asked;
    await win.waitForSelector(`${answer}:not([disabled])`);
    const title = await win.textContent('h1');
    const details = await win.textContent('dl');
    // The window's title says what it asks.
    const windowTitle = await win.title();
    await win.click(answer);
    return { pending, title, details, windowTitle };
  };
  const first = await confirm({ browser: 'chromium', url: '/token-created', kind: 'prefix', prefix: 'github_pat_', to: 'mcphub:ideekdo/GITHUB_TOKEN' });
  assert.match(first.title, /capture a secret/);
  assert.match(first.windowTitle, /capture a secret/);
  assert.match(first.details, /^Website.*Secret.*Stored/s);
  assert.ok(!first.details.includes('replacing'));
  const out = await first.pending;
  assert.match(out, /Captured a secret from 127\.0\.0\.1 \(93 characters, starts with github_pat_\) into McpHub vault of ideekdo as GITHUB_TOKEN/);
  assert.ok(!out.includes(token));
  const [entry] = stored();
  assert.deepEqual(entry.args, ['vault', 'set', '--tenant', 'ideekdo', 'GITHUB_TOKEN']);
  assert.equal(entry.input, token, 'the value went on standard input only');
  // The tab already driven on that site refuses scripts until it changes page.
  const sealed = await mcp.call('fl_extract', { tab: own, js: 'return document.querySelector("code").textContent' });
  assert.match(sealed, /Blocked: this page holds a password, code or secret Rocketwright filled or captured/);
  assert.ok(!sealed.includes(token));
  await mcp.call('fl_release', { tab: own });
  // A tab of that site the agent takes over afterwards is sealed too, and so is its next page for a few minutes; the value is masked anyway.
  const again = /Tab (t\d+)/.exec(await mcp.call('fl_adopt', { url: '/token-created', browser: 'chromium', text: 0 }))[1];
  assert.match(await mcp.call('fl_extract', { tab: again, js: 'return 1' }), /Blocked: this page holds a password, code or secret/);
  await mcp.call('fl_act', { tab: again, actions: [{ do: 'goto', url: `${site.url}/token-created?t=${token}` }] });
  assert.ok(!(await mcp.call('fl_extract', { tab: again, js: 'return document.querySelector("code").textContent' })).includes(token));
  assert.ok(!(await mcp.call('fl_snapshot', { tab: again })).includes(token));
  await mcp.call('fl_release', { tab: again });

  // Two different tokens on the page: nothing is captured rather than the wrong one, with the same message as any miss.
  await page.goto(`${site.url}/token-created?t=${token}&t=${other}`);
  await assert.rejects(mcp.call('fl_capture_secret', { browser: 'chromium', url: '/token-created', kind: 'prefix', prefix: 'github_pat_', to: 'mcphub:X' }), /Nothing captured \(or not confirmed by the user\): no single such secret on an open page matching that address/);
  // A value the page does not show (hidden field, password field, hidden element) is never taken.
  await page.goto(`${site.url}/token-created?h=${other}`);
  await assert.rejects(mcp.call('fl_capture_secret', { browser: 'chromium', url: '/token-created', kind: 'prefix', prefix: 'github_pat_', to: 'mcphub:X' }), /Nothing captured/);
  await page.goto(`${site.url}/token-created?t=${token}&t=${other}`);
  // The query string of a tab is never matched (it can hold codes).
  await assert.rejects(mcp.call('fl_capture_secret', { browser: 'chromium', url: 'token-created?t=', kind: 'prefix', prefix: 'github_pat_', to: 'mcphub:X' }), /Nothing captured/);
  // A free pattern is not accepted, only known kinds or a literal prefix.
  await assert.rejects(mcp.call('fl_capture_secret', { browser: 'chromium', url: '/token-created', kind: 'prefix', prefix: '.*', to: 'mcphub:X' }), /prefix: the literal start of the secret/);
  await assert.rejects(mcp.call('fl_capture_secret', { browser: 'chromium', url: '/token-created', kind: 'prefix', prefix: 'github_pat', to: 'mcphub:X' }), /ending in "_" or "-"/);
  // No clipboard: an agent could paste it where it reads it.
  await assert.rejects(mcp.call('fl_capture_secret', { browser: 'chromium', url: '/token-created', kind: 'prefix', prefix: 'github_pat_', to: 'clipboard' }), /No clipboard/);
  // Turned off by the user.
  await page.goto(`${site.url}/token-created?t=${token}`);
  await sw.evaluate(() => chrome.storage.local.set({ fillSettings: { capture: false } }));
  await assert.rejects(mcp.call('fl_capture_secret', { browser: 'chromium', url: '/token-created', kind: 'prefix', prefix: 'github_pat_', to: 'mcphub:X' }), /capturing secrets shown on a page is turned off/);
  await sw.evaluate(() => chrome.storage.local.set({ fillSettings: {} }));
  // Replacing a name the vault already holds is said to the user, and a refusal stores nothing.
  const count = stored().length;
  const replace = await confirm({ browser: 'chromium', url: '/token-created', kind: 'prefix', prefix: 'github_pat_', to: 'mcphub:EXISTING_TOKEN' }, '#deny');
  assert.match(replace.details, /replacing McpHub vault as EXISTING_TOKEN/);
  // A refusal reads the same as a miss: it does not tell the agent such a secret was there.
  await assert.rejects(replace.pending, /Nothing captured \(or not confirmed by the user\): no single such secret/);
  assert.equal(stored().length, count);
  // Questions turned off by the user, in the extension: even a replacement goes ahead without a window.
  const windows = [];
  const onPage = (p) => { if (p.url().includes('/confirm.html')) windows.push(p); };
  ctx.on('page', onPage);
  await sw.evaluate(() => chrome.storage.local.set({ fillSettings: { askSecrets: false } }));
  const silent = await mcp.call('fl_capture_secret', { browser: 'chromium', url: '/token-created', kind: 'prefix', prefix: 'github_pat_', to: 'mcphub:EXISTING_TOKEN' });
  assert.match(silent, /Captured a secret from 127\.0\.0\.1/);
  assert.equal(stored().length, count + 1);
  assert.deepEqual(windows, [], 'no question asked');
  ctx.off('page', onPage);
  await sw.evaluate(() => chrome.storage.local.set({ fillSettings: {} }));
  await page.close();
});

test('fl_paste_secret types a vault secret into a field after the user\'s click, never into the agent\'s view', async () => {
  const page = await ctx.newPage();
  await page.goto(`${site.url}/paste-form`);
  const snap = await mcp.call('fl_adopt', { url: '/paste-form', browser: 'chromium', text: 0 });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  const key = refOf(snap, /password "API key"$/);
  const ask = async (args, answer) => {
    const asked = ctx.waitForEvent('page', (p) => p.url().includes('/confirm.html'));
    const pending = mcp.call('fl_paste_secret', { tab, ...args });
    pending.catch(() => { /* checked below */ });
    const win = await asked;
    await win.waitForSelector(`${answer}:not([disabled])`);
    const shown = { title: await win.textContent('h1'), details: await win.textContent('dl') };
    await win.click(answer);
    return { pending, ...shown };
  };
  // Refused by the user: nothing is read from the vault, nothing typed.
  const no = await ask({ ref: key, from: 'mcphub:EXISTING_TOKEN' }, '#deny');
  assert.match(no.title, /paste a secret from your vault/);
  assert.match(no.details, /127\.0\.0\.1.*McpHub vault as EXISTING_TOKEN.*into the password field the page calls "API key"/s);
  await assert.rejects(no.pending, /Refused by the Rocketwright extension in chromium: the user declined/);
  assert.equal(await page.evaluate(() => document.querySelector('[name=key]').value), '');
  // Allowed: typed and submitted, and the agent only learns the length.
  const yes = await ask({ ref: key, from: 'mcphub:EXISTING_TOKEN', submit: true }, '#allow');
  const out = await yes.pending;
  assert.match(out, /Pasted the secret from McpHub vault as EXISTING_TOKEN into "API key" on 127\.0\.0\.1 \(\d+ characters\), confirmed by the user/);
  assert.ok(!out.includes(vaultValue));
  assert.equal(await page.evaluate(() => window.savedKey), vaultValue);
  // The page is closed to scripts and screenshots, and the value is masked anyway.
  assert.match(await mcp.call('fl_extract', { tab, js: 'return window.savedKey' }), /Blocked: this page holds a password, code or secret/);
  // Not a field the user can see and edit, a missing name, a tab where the agent ran a script: refused before asking.
  await page.goto(`${site.url}/paste-form`);
  await assert.rejects(mcp.call('fl_paste_secret', { tab, selector: 'button', from: 'mcphub:EXISTING_TOKEN' }), /only goes into a text, password or text area field/);
  await assert.rejects(mcp.call('fl_paste_secret', { tab, label: 'Email', from: 'mcphub:EXISTING_TOKEN' }), /only goes into a text, password or text area field/);
  // A form sent to another site, or by GET with Enter pressed: the value would leave the page or land in the address.
  await assert.rejects(mcp.call('fl_paste_secret', { tab, label: 'Other site', from: 'mcphub:EXISTING_TOKEN' }), /form is sent to another site/);
  await assert.rejects(mcp.call('fl_paste_secret', { tab, label: 'Search', from: 'mcphub:EXISTING_TOKEN', submit: true }), /form is sent to another site, or by GET with submit/);
  await assert.rejects(mcp.call('fl_paste_secret', { tab, label: 'API key', from: 'clipboard' }), /from: "mcphub:NAME"/);
  // A 1Password vault the user excluded is not read, even with a click.
  await sw.evaluate(() => chrome.storage.local.set({ fillSettings: { vaultsDeny: ['Clients'] } }));
  await assert.rejects(mcp.call('fl_paste_secret', { tab, label: 'API key', from: '1password:clients/Deploy key' }), /the vault "clients" is not one Rocketwright may use/);
  await sw.evaluate(() => chrome.storage.local.set({ fillSettings: {} }));
  // The site stays sealed a few minutes after the paste: the next page may show the secret again.
  assert.match(await mcp.call('fl_extract', { tab, js: 'return 1' }), /Blocked: this page holds a password, code or secret/);
  // Questions turned off by the user, in the extension: the paste goes ahead without a window, and says so.
  const quiet = await ctx.newPage();
  await quiet.goto(`${site.url}/paste-form?quiet=1`);
  const quietTab = /Tab (t\d+)/.exec(await mcp.call('fl_adopt', { url: '/paste-form?quiet=1', browser: 'chromium', text: 0 }))[1];
  const asked = [];
  const onAsk = (p) => { if (p.url().includes('/confirm.html')) asked.push(p); };
  ctx.on('page', onAsk);
  await sw.evaluate(() => chrome.storage.local.set({ fillSettings: { askSecrets: false } }));
  const pasted = await mcp.call('fl_paste_secret', { tab: quietTab, label: 'API key', from: 'mcphub:EXISTING_TOKEN' });
  assert.match(pasted, /Pasted the secret .* not asked \(the user turned questions off\)/);
  assert.ok(!pasted.includes(vaultValue));
  assert.equal(await quiet.evaluate(() => document.querySelector('[name=key]').value), vaultValue);
  assert.deepEqual(asked, [], 'no question asked');
  ctx.off('page', onAsk);
  await sw.evaluate(() => chrome.storage.local.set({ fillSettings: {} }));
  await mcp.call('fl_release', { tab: quietTab });
  await quiet.close();
  // An older McpHub printed "NAME = value": that line is never typed into the field.
  const old = await ctx.newPage();
  await old.goto(`${site.url.replace('127.0.0.1', 'localhost')}/paste-form`);
  const oldTab = /Tab (t\d+)/.exec(await mcp.call('fl_adopt', { url: 'localhost', browser: 'chromium', text: 0 }))[1];
  const asked2 = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('confirm.html') });
  const pending2 = mcp.call('fl_paste_secret', { tab: oldTab, label: 'API key', from: 'mcphub:OLD_FORMAT' });
  pending2.catch(() => {});
  const win2 = await asked2;
  await win2.waitForSelector('#allow:not([disabled])');
  await win2.click('#allow');
  await assert.rejects(pending2, /McpHub printed the name with the value \(an older McpHub\): update it, then try again\. Nothing was pasted/);
  assert.equal(await old.evaluate(() => document.querySelector('[name=key]').value), '');
  await mcp.call('fl_release', { tab: oldTab });
  await old.close();
  // Elsewhere, once the agent ran a script in the tab, no paste.
  await mcp.call('fl_act', { tab, actions: [{ do: 'goto', url: site.url.replace('127.0.0.1', 'localhost') + '/paste-form' }], snapshot: false });
  assert.match(await mcp.call('fl_extract', { tab, js: 'return 1' }), /-> 1/);
  await assert.rejects(mcp.call('fl_paste_secret', { tab, label: 'API key', from: 'mcphub:EXISTING_TOKEN' }), /Refused: you ran JavaScript in this tab/);
  await mcp.call('fl_release', { tab });
  await page.close();
});

test('emulation in the user\'s browser goes through the extension, and the tab gets its own look back when released', async () => {
  const page = await ctx.newPage();
  // Another host than the one the capture and paste tests sealed for a few minutes.
  await page.goto(`${site.url.replace('127.0.0.1', 'localhost')}/env`);
  const env = () => page.evaluate(() => JSON.parse(window.env()));
  const before = await env();
  const tab = /Tab (t\d+)/.exec(await mcp.call('fl_adopt', { url: '/env', browser: 'chromium', text: 0 }))[1];
  assert.match(await mcp.call('fl_emulate', { tab, device: 'Pixel 7', colorScheme: 'dark' }), /Emulating Pixel 7/);
  // Chrome keeps the time zone from extensions: said plainly, with where it works.
  await assert.rejects(mcp.call('fl_emulate', { tab, timezone: 'America/New_York' }), /Chrome does not let an extension change this in your own browser.*dedicated browser/);
  const now = await env();
  assert.equal(now.dark, true);
  assert.match(now.ua, /Android/);
  const pdf = await mcp.call('fl_pdf', { tab, name: 'env-user-browser' });
  assert.match(pdf, /PDF saved: .*env-user-browser\.pdf/);
  await mcp.call('fl_release', { tab });
  const after = await env();
  assert.deepEqual([after.tz, after.dark, after.ua], [before.tz, before.dark, before.ua]);
  // The phone screen is gone (the test browser's own window size, not the size its test harness forced, comes back).
  assert.equal(now.width, 412);
  assert.notEqual(after.width, 412);
  assert.equal(after.touch, before.touch);
  await page.close();
});

test('network rules, a trace and a video work in the user\'s browser, and the trace leaves out page copies and network there', async () => {
  const page = await ctx.newPage();
  await page.goto(`${site.url.replace('127.0.0.1', 'localhost')}/stock`);
  const tab = /Tab (t\d+)/.exec(await mcp.call('fl_adopt', { url: '/stock', browser: 'chromium', text: 0 }))[1];
  const load = async () => {
    await mcp.call('fl_act', { tab, actions: [{ do: 'click', selector: '#load' }, { do: 'wait', network: true, ms: 8000 }], snapshot: false });
    return page.locator('#out').textContent();
  };
  assert.match(await mcp.call('fl_trace', { tab, action: 'start', name: 'user-browser' }), /every action with a picture before and after \(no page copy or network log/);
  assert.match(await mcp.call('fl_video', { tab, action: 'start', actions: false }), /Filming tab: \d+x\d+\. fl_video stop/);
  await mcp.call('fl_mock', { tab, action: 'respond', url: '/api/stock', body: '{"left":0}' });
  assert.match(await load(), /^200 \{"left":0\}/);
  const zip = /Trace saved: (.*\.zip) \(/.exec(await mcp.call('fl_trace', { tab, action: 'stop' }))[1];
  assert.equal(readFileSync(zip).subarray(0, 2).toString(), 'PK');
  // No page copy, no network log: they would hold the user's cookies.
  const files = zipEntries(zip);
  assert.equal(files.get('trace.network').length, 0, 'no network entry in a trace of the user\'s browser');
  assert.ok(!files.get('trace.trace').includes('frame-snapshot'), 'no page copy in a trace of the user\'s browser');
  assert.ok(files.get('trace.trace').includes('"type":"before"'), 'the actions are in it');
  const filmed = await mcp.call('fl_release', { tab });
  assert.match(filmed, /released: still open in the browser, no longer driven\. Video saved: .*\.webm/);
  // Released: the rule went with it, the real API answers the user.
  await page.click('#load');
  await page.waitForFunction(() => /left":12/.test(document.getElementById('out').textContent));
  await page.close();
});

test('a trace is saved when the user closes the last tab it recorded', async () => {
  const page = await ctx.newPage();
  await page.goto(`${site.url.replace('127.0.0.1', 'localhost')}/stock`);
  const tab = /Tab (t\d+)/.exec(await mcp.call('fl_adopt', { url: '/stock', browser: 'chromium', text: 0 }))[1];
  await mcp.call('fl_trace', { tab, action: 'start', name: 'closed-by-user' });
  await page.close();
  await new Promise((r) => setTimeout(r, 1500));
  const page2 = await ctx.newPage();
  await page2.goto(`${site.url.replace('127.0.0.1', 'localhost')}/rows`);
  const other = /Tab (t\d+)/.exec(await mcp.call('fl_adopt', { url: '/rows', browser: 'chromium', text: 0 }))[1];
  assert.match(await mcp.call('fl_trace', { tab: other, action: 'stop' }), /The trace stopped when its last tab closed\. Trace saved: .*closed-by-user/);
  await assert.rejects(mcp.call('fl_trace', { tab: other, action: 'stop' }), /No trace is running/);
  await mcp.call('fl_release', { tab: other });
  await page2.close();
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
