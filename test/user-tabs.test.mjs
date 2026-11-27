// The tabs the user already has open, and the tabs a click opens: listed with an id the agent adopts directly, and a
// tab opened by the agent's click (target=_blank, window.open) driven at once.
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'rocketwright-tabs-'));
  mcp = await connect(testEnv({
    ROCKETWRIGHT_MODE: 'extension', ROCKETWRIGHT_RELAY_PORT: String(await freePort()), ROCKETWRIGHT_TOKEN: 'tabs-' + Math.random().toString(36).slice(2),
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

test('fl_tabs all lists the user\'s open tabs with an id, and fl_adopt takes one by that id', async () => {
  const mine = await ctx.newPage();
  await mine.goto(site.url + '/search?user=1');
  assert.equal(await mcp.call('fl_tabs'), 'No tabs.');
  const listed = await mcp.call('fl_tabs', { all: true });
  assert.match(listed, /^Driven by you: none\.$/m);
  const line = listed.split('\n').find((l) => / Search$/.test(l));
  assert.ok(line, listed);
  assert.match(line, new RegExp(`^  #(\\d+) window "[^"]+": ${site.url.replace(/[.]/g, '\\.')}  Search$`));
  assert.match(listed, /fl_adopt \{browser:"<name>", id:<#id>\}/);
  const id = Number(/#(\d+)/.exec(line)[1]);
  await assert.rejects(mcp.call('fl_adopt', { browser: 'chromium', id, url: '/search' }), /Give url or id/);
  const snap = await mcp.call('fl_adopt', { browser: 'chromium', id, text: 0 });
  assert.match(snap, /^Tab (t\d+) \[chromium\]\nURL: .*\/search\?user=1/);
  const tab = /Tab (t\d+)/.exec(snap)[1];
  const after = await mcp.call('fl_tabs', { browser: 'chromium' });
  assert.match(after, new RegExp(`Driven by you:\\n  ${tab}  \\[chromium\\]  .*\\/search\\?user=1`));
  assert.match(after, /#\d+ window "[^"]+": .*  Search  \[driven\]/);
  await assert.rejects(mcp.call('fl_adopt', { browser: 'chromium', id }), /No tab #\d+ in chromium that this conversation may take/);
  await mcp.call('fl_release', { tab });
  await mine.close();
});

test('a tab opened by a click (target=_blank, window.open) is driven at once and named in the answer', async () => {
  const tab = /Tab (t\d+)/.exec(await mcp.call('fl_open', { url: site.url + '/opener', browser: 'chromium', text: 0 }))[1];
  const out = await mcp.call('fl_act', { tab, actions: [{ do: 'click', text: 'Open landing' }] });
  const m = /New tab (t\d+) \[[\w-]+\] opened by this page, now driven: (\S+)\. Read it with fl_snapshot/.exec(out);
  assert.ok(m, out);
  assert.equal(m[2], site.url + '/landing?k=•••');
  assert.ok(!out.includes('abcdefgh12345678'), 'its one-time part is masked');
  assert.match(await mcp.call('fl_snapshot', { tab: m[1], text: 100 }), /Landed here/);
  // Opened by the page's own script: named in the answer, or in the next one.
  const said = await mcp.call('fl_act', { tab, actions: [{ do: 'click', text: 'Pop search' }, { do: 'wait', ms: 300 }] });
  const next = /New tab (t\d+)/.test(said) ? said : await waitFor(async () => { const s = await mcp.call('fl_snapshot', { tab, text: 0 }); return /New tab t\d+/.test(s) ? s : null; });
  const popped = /New tab (t\d+) \[[\w-]+\] opened by this page, now driven: \S+\/search\./.exec(next);
  assert.ok(popped, next);
  assert.match(await mcp.call('fl_snapshot', { tab: popped[1], text: 0 }), /Title: Search/);
  for (const t of [m[1], popped[1], tab]) await mcp.call('fl_close', { tab: t });
});
