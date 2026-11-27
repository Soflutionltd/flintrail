// One Rocketwright drives its dedicated browser and a user browser connected through the extension at the
// same time, each chosen by name.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

before(async () => {
  site = await startFixture();
  userDataDir = mkdtempSync(join(tmpdir(), 'rocketwright-multi-'));
  // Launch mode: Rocketwright owns a dedicated headless browser ("agent"), and the relay runs alongside it.
  mcp = await connect(testEnv({
    ROCKETWRIGHT_RELAY_PORT: String(await freePort()), ROCKETWRIGHT_TOKEN: 'multi-' + Math.random().toString(36).slice(2),
    ROCKETWRIGHT_RELAY: 'on', ROCKETWRIGHT_PAIRING: 'on', ROCKETWRIGHT_PAIRING_DIRS: userDataDir,
  }));
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(process.env.ROCKETWRIGHT_CHROME ? { executablePath: process.env.ROCKETWRIGHT_CHROME } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });
  await waitFor(async () => /chromium: Extension connected/.test(await mcp.call('fl_extension')));
});

after(async () => {
  await ctx?.close();
  await mcp?.client.close();
  site?.server.close();
});

test('pairing host is registered only for the Rocketwright extension', () => {
  const manifest = join(userDataDir, 'NativeMessagingHosts', 'com.soflution.flintrail.json');
  assert.ok(existsSync(manifest));
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.deepEqual(m.allowed_origins, [
    'chrome-extension://hgkglidmccenjlhdcplcpkgbadonplnb/', // unpacked and release zip
    'chrome-extension://amgonogobcfmneginonbkfjlbbnecchp/', // Chrome Web Store listing
  ]);
  assert.equal(m.type, 'stdio');
});

test('the dedicated browser and a user browser are driven side by side', async () => {
  const agent = await mcp.call('fl_open', { url: site.url, text: 0 });
  assert.match(agent, /^Tab t\d+ \[agent\]/);
  const user = await mcp.call('fl_open', { url: site.url + '/search', browser: 'chromium', text: 0 });
  assert.match(user, /^Tab t\d+ \[chromium\]/);
  // The second tab really lives in the user's browser, the first one does not.
  assert.ok(ctx.pages().some((p) => p.url().includes('/search')));
  assert.ok(!ctx.pages().some((p) => p.url() === site.url + '/'));
  const tabs = await mcp.call('fl_tabs');
  assert.match(tabs, /\[agent\]/);
  assert.match(tabs, /\[chromium\]/);
  assert.match(await mcp.call('fl_extension'), /^agent: dedicated browser \(launch mode\)/m);
});
