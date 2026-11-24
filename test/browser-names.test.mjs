// Each browser keeps the name it got the first time it connected, whatever the order browsers connect in
// afterwards: an agent told "brave-2" yesterday finds the same browser today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { connect, testEnv } from './helpers.mjs';

const extPath = new URL('../extension', import.meta.url).pathname;
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

const dirs = [mkdtempSync(join(tmpdir(), 'flintrail-name-a-')), mkdtempSync(join(tmpdir(), 'flintrail-name-b-'))];
const env = testEnv({
  FLINTRAIL_MODE: 'extension', FLINTRAIL_RELAY_PORT: String(await freePort()), FLINTRAIL_TOKEN: 'names-' + Math.random().toString(36).slice(2),
  FLINTRAIL_RELAY: 'on', FLINTRAIL_PAIRING: 'on', FLINTRAIL_PAIRING_DIRS: dirs.join(','),
});
const open = (dir) => chromium.launchPersistentContext(dir, {
  headless: true,
  ...(process.env.FLINTRAIL_CHROME ? { executablePath: process.env.FLINTRAIL_CHROME } : { channel: 'chromium' }),
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
const instanceOf = async (ctx) => {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  return waitFor(async () => (await sw.evaluate(() => chrome.storage.local.get('instance'))).instance);
};
const names = () => JSON.parse(readFileSync(join(env.FLINTRAIL_HOME, 'browsers.json'), 'utf8'));
const portFree = () => new Promise((resolve) => {
  const s = createServer().once('error', () => resolve(false)).listen(Number(env.FLINTRAIL_RELAY_PORT), '127.0.0.1', () => s.close(() => resolve(true)));
});

// One "day": a relay starts, the browsers connect in this order, each is named, everything closes.
async function day(order) {
  const mcp = await connect(env);
  const ctxs = [];
  for (const i of order) {
    ctxs[i] = await open(dirs[i]);
    const instance = await instanceOf(ctxs[i]);
    await waitFor(async () => {
      const key = names()[instance]?.key;
      return key && new RegExp(`^${key}: Extension connected`, 'm').test(await mcp.call('fl_extension'));
    });
  }
  const byDir = await Promise.all([0, 1].map(async (i) => names()[await instanceOf(ctxs[i])].key));
  for (const c of ctxs) await c.close();
  await mcp.client.close();
  // The relay leaves once nobody uses it: whatever it held in memory is gone.
  await waitFor(portFree, 30000);
  return byDir;
}

test('a browser keeps its name, even after the relay restarts and browsers come back in another order', async () => {
  const first = await day([0, 1]);
  assert.notEqual(first[0], first[1]);
  assert.match(first[0], /^chromium/);
  // The profile name can show up on a later start: the name may then become it, once.
  const second = await day([1, 0]);
  const third = await day([1, 0]);
  const fourth = await day([0, 1]);
  assert.deepEqual(third, second);
  assert.deepEqual(fourth, second);
});
