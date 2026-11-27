// Several Rocketwright processes (one per conversation) drive the same user browser at once through the
// shared relay daemon: each sees only its own tabs, closing one never cuts the others off, browsers are
// picked by the name the user gave them, and the relay only talks to whoever proves it knows the token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { startFixture } from './fixture.mjs';
import { connect, testEnv } from './helpers.mjs';
import { readFileSync } from 'node:fs';

// The extension's own version, as it reports it: a test never pins a release's number.
const EXT_VERSION = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')).version.replaceAll('.', '\\.');

const extPath = new URL('../extension', import.meta.url).pathname;
const token = 'multi-client-' + Math.random().toString(36).slice(2);
let site, relayPort, env, a, b, ctx;

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
const mac = (key, message) => createHmac('sha256', key).update(message).digest('hex');

/** Opens a raw connection to the relay and returns the first message it sends, or the close code. */
function rawRelay(path, headers = {}, onChallenge) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${path}`, { headers });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'challenge' && onChallenge) { onChallenge(ws, m); return; }
      resolve({ message: m, ws });
    });
    ws.on('close', (code) => resolve({ code }));
    ws.on('error', () => resolve({ code: 'error' }));
  });
}

before(async () => {
  site = await startFixture();
  relayPort = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'rocketwright-multi-client-'));
  // Same computer, same token, same relay port: two conversations, each with its own Rocketwright.
  env = testEnv({
    ROCKETWRIGHT_MODE: 'extension', ROCKETWRIGHT_RELAY_PORT: String(relayPort), ROCKETWRIGHT_TOKEN: token,
    ROCKETWRIGHT_RELAY: 'on', ROCKETWRIGHT_PAIRING: 'on', ROCKETWRIGHT_PAIRING_DIRS: userDataDir, ROCKETWRIGHT_EXTENSION_WAIT: '3000',
  });
  a = await connect(env);
  b = await connect(env);
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(process.env.ROCKETWRIGHT_CHROME ? { executablePath: process.env.ROCKETWRIGHT_CHROME } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });
  await waitFor(async () => /chromium: Extension connected/.test(await a.call('fl_extension')));
  await waitFor(async () => /chromium: Extension connected/.test(await b.call('fl_extension')));
});

after(async () => {
  await ctx?.close();
  await a?.client.close();
  await b?.client.close();
  site?.server.close();
});

test('two conversations drive the same browser, each sees only its own tabs', async () => {
  const ta = tabId(await a.call('fl_open', { url: site.url + '/search', browser: 'chromium', text: 0 }));
  const tb = tabId(await b.call('fl_open', { url: site.url + '/upload', browser: 'chromium', text: 0 }));
  assert.ok(ctx.pages().some((p) => p.url().includes('/search')));
  assert.ok(ctx.pages().some((p) => p.url().includes('/upload')));
  // Neither can take over the other's tab.
  await assert.rejects(b.call('fl_adopt', { url: '/search', browser: 'chromium' }), /No open tab/);
  await assert.rejects(a.call('fl_adopt', { url: '/upload', browser: 'chromium' }), /No open tab/);
  assert.match(await a.call('fl_tabs'), /search/);
  assert.doesNotMatch(await a.call('fl_tabs'), /upload/);
  // Both still work side by side.
  assert.match(await a.call('fl_snapshot', { tab: ta }), /Search/);
  assert.match(await b.call('fl_snapshot', { tab: tb }), /Import/);
  await a.call('fl_close', { tab: ta });
  await b.call('fl_close', { tab: tb });
});

test('a tab the user shares goes to the first conversation that adopts it', async () => {
  await sw.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    await new Promise((r) => setTimeout(r, 500));
    const targetInfo = await attach(tab.id);
    send({ type: 'shared', tabId: tab.id, targetInfo });
  }, site.url + '/dialogs');
  const adopted = await b.call('fl_adopt', { url: '/dialogs', browser: 'chromium', text: 0 });
  assert.match(adopted, /^Tab t\d+ \[chromium\]/);
  await assert.rejects(a.call('fl_adopt', { url: '/dialogs', browser: 'chromium' }), /No open tab/);
  await b.call('fl_close', { tab: tabId(adopted) });
});

test('the user names a browser, agents pick it by that name and see its open sites', async () => {
  await sw.evaluate(async () => {
    await chrome.storage.local.set({ label: 'IdéeKdo' });
    ws?.close();
    ws = null;
    await connect();
  });
  await waitFor(async () => new RegExp(String.raw`chromium-ideekdo: Extension connected \(Chromium "IdéeKdo", extension ${EXT_VERSION}\)`).test(await a.call('fl_extension')));
  const snap = await a.call('fl_open', { url: site.url, browser: 'IdéeKdo', text: 0 });
  assert.match(snap, /^Tab t\d+ \[chromium-ideekdo\]/);
  const listed = await b.call('fl_extension', { tabs: true });
  assert.match(listed, new RegExp(`window \\d+: ${site.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+Shop`));
  // Origin and title only: never the path or the query string.
  assert.doesNotMatch(listed, /\/details|\/search\?/);
  await a.call('fl_close', { tab: tabId(snap) });
});

test('closing one conversation leaves the others connected', async () => {
  const tb = tabId(await b.call('fl_open', { url: site.url + '/canvas', browser: 'chromium-ideekdo', text: 0 }));
  await a.client.close();
  a = null;
  await new Promise((r) => setTimeout(r, 500));
  assert.match(await b.call('fl_snapshot', { tab: tb }), /Canvas/);
  // A second tab of the same site, on purpose: both stay driven.
  const again = tabId(await b.call('fl_open', { url: site.url + '/search', browser: 'chromium-ideekdo', evenIfSiteOpen: true, text: 0 }));
  assert.notEqual(again, tb);
  await b.call('fl_close', { tab: again });
  await b.call('fl_close', { tab: tb });
  // A new conversation joins the same relay and finds the browser right away.
  a = await connect(env);
  assert.match(await a.call('fl_extension'), /chromium-ideekdo: Extension connected/);
});

test('the relay refuses web pages, wrong tokens and impostors', async () => {
  // A web page can reach 127.0.0.1, but always sends its origin: refused before any message.
  assert.deepEqual(await rawRelay('/client', { Origin: 'https://evil.example' }), { code: 'error' });
  // Wrong token: the HMAC does not match.
  const wrong = await rawRelay('/client', {}, (ws, m) => ws.send(JSON.stringify({ type: 'hello', mac: mac('nope', 'client:' + m.nonce), cnonce: 'x' })));
  assert.equal(wrong.code, 4401);
  // Right token: the relay proves it knows the token too.
  const ok = await rawRelay('/client', {}, (ws, m) => ws.send(JSON.stringify({ type: 'hello', mac: mac(token, 'client:' + m.nonce), cnonce: 'c1', pid: 1 })));
  assert.equal(ok.message.type, 'welcome');
  assert.equal(ok.message.mac, mac(token, 'relay:c1'));
  ok.ws.close();
  // An extension 1.3 (token in clear) still connects, and agents are told to reload it.
  const legacy = await rawRelay('/extension', {}, (ws) => ws.send(JSON.stringify({ type: 'hello', token, version: '1.3.0', browser: 'Brave', instance: 'old-one' })));
  assert.equal(legacy.message.type, 'welcome');
  // The relay sends the new browser list to the conversations just after the welcome: wait for it.
  const outdated = /brave: Extension connected \(Brave, extension 1\.3\.0\) \(outdated: reload the extension/;
  await waitFor(async () => outdated.test(await b.call('fl_extension')));
  assert.match(await b.call('fl_extension'), outdated);
  // It cannot pick a window: refused, instead of a tab silently opening somewhere else.
  await assert.rejects(b.call('fl_open', { url: site.url, browser: 'brave', newWindow: true }), /extension 1\.3\.0 cannot pick a window/);
  legacy.ws.close();
});

test('a relay left over from an older Rocketwright is replaced when nobody else uses it', async () => {
  const { WebSocketServer } = await import('ws');
  const port = await freePort();
  let retired = false;
  // An old daemon: same token, older version, alone on its port.
  const old = new WebSocketServer({ host: '127.0.0.1', port });
  old.on('connection', (ws) => {
    const nonce = 'old-nonce';
    ws.send(JSON.stringify({ type: 'challenge', nonce, version: '0.9.0', protocol: 1 }));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'welcome', mac: mac(token, 'relay:' + m.cnonce), version: '0.9.0', protocol: 1, clients: 1, browsers: [] }));
      if (m.method === 'retire') { retired = true; ws.send(JSON.stringify({ id: m.id, result: { ok: true } })); old.close(); for (const c of old.clients) c.terminate(); }
    });
  });
  const fresh = await connect({ ...env, ROCKETWRIGHT_RELAY_PORT: String(port) });
  await waitFor(async () => retired && /relay 127\.0\.0\.1:\d+, version \d+\.\d+\.\d+\)/.test(await fresh.call('fl_extension')) &&
    !/version 0\.9\.0/.test(await fresh.call('fl_extension')), 10000);
  await fresh.client.close();
});

test('an older Rocketwright holding the port is reported clearly', async () => {
  const { createServer: createHttp } = await import('node:http');
  const port = await freePort();
  // Rocketwright 1.3 kept the relay in one conversation and hangs up on any path but its own.
  const old = createHttp((_req, res) => res.writeHead(404).end());
  old.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise((r) => old.listen(port, '127.0.0.1', r));
  const fresh = await connect({ ...env, ROCKETWRIGHT_RELAY_PORT: String(port) });
  assert.match(await fresh.call('fl_extension'), /held by an older Rocketwright \(1\.3 or earlier\)/);
  await fresh.client.close();
  old.close();
});
