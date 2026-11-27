// fl_mail_code in the user's own browser: the mailbox tab the user has open is taken for the search only, given back
// as it was, and the user's extension settings decide whether a code may be typed.
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
const CODE = '5093318';
let site, mcp, ctx, port;

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
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
  port = new URL(site.url).port;
  const userDataDir = mkdtempSync(join(tmpdir(), 'rocketwright-mail-'));
  mcp = await connect(testEnv({
    ROCKETWRIGHT_MODE: 'extension', ROCKETWRIGHT_RELAY_PORT: String(await freePort()), ROCKETWRIGHT_TOKEN: 'mail-' + Math.random().toString(36).slice(2),
    ROCKETWRIGHT_RELAY: 'on', ROCKETWRIGHT_PAIRING: 'on', ROCKETWRIGHT_PAIRING_DIRS: userDataDir,
    ROCKETWRIGHT_MAIL_HOSTS: 'gmail.localhost=gmail',
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

test('the user\'s mailbox tab is read for the code, then given back where it was, never driven', async () => {
  site.mails.splice(0, site.mails.length, {
    id: 'm1', from: 'noreply@notify.acme.localhost', name: 'Acme', subject: 'Your sign-in code', at: Date.now() - 60_000,
    html: `<p>Your code</p><div style="font-size:28px">${CODE}</div><p>© 2026 Acme</p>`,
  });
  // The user's own tab, open before the agent came.
  const inbox = await ctx.newPage();
  await inbox.goto(`http://gmail.localhost:${port}/mail/u/0/`);
  await inbox.waitForSelector('tr.zA');
  const tab = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: `http://dash.acme.localhost:${port}/code`, browser: 'chromium', text: 0 }))[1];
  const out = await mcp.call('fl_mail_code', { tab, from: 'acme.localhost', waitSeconds: 0 });
  assert.match(out, /Code from noreply@notify\.acme\.localhost \("Your sign-in code", received .*\): 7 characters, typed and submitted/);
  assert.ok(!out.includes(CODE));
  await waitFor(async () => site.codes.includes(CODE));
  // Given back: not among the agent's tabs, and on the list the user left.
  const tabs = await mcp.call('fl_tabs');
  assert.doesNotMatch(tabs, /gmail\.localhost/);
  await waitFor(async () => inbox.url().endsWith('#inbox'));
  await mcp.call('fl_close', { tab });
});
