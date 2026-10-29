import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture.mjs';
import { connect, testEnv } from './helpers.mjs';

const bin = (name) => {
  const p = new URL(`./${name}`, import.meta.url).pathname;
  chmodSync(p, 0o755);
  return p;
};
const SECRET = 'S3cret pass&"42';
const leaks = (out) => [SECRET, JSON.stringify(SECRET).slice(1, -1), encodeURIComponent(SECRET), '123456'].some((s) => out.includes(s));
const tabOf = (snap) => /Tab (t\d+)/.exec(snap)[1];

let site;
before(async () => { site = await startFixture(); });
after(() => site.server.close());

describe('1Password CLI source', () => {
  let mcp;
  before(async () => { mcp = await connect(testEnv({ FLINTRAIL_PASSWORDS: `1password:${bin('fake-op.mjs')}` })); });
  after(() => mcp.client.close());

  test('signs in and never returns the password or the code', async () => {
    const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
    const out = await mcp.call('fl_login', { tab });
    assert.match(out, /1password login "Fixture shop".*filled username, password, one-time code, submitted/);
    const done = await mcp.call('fl_act', { tab, actions: [{ do: 'wait', text: 'Welcome' }] });
    assert.match(done, /Welcome ann@example.com/);
    assert.ok(!leaks(out + done));

    const net = await mcp.call('fl_network', { filter: '/api/login' });
    assert.match(net, /•••/);
    assert.ok(!leaks(net), 'request body must be masked');

    const read = await mcp.call('fl_extract', { tab, js: 'return [f.password.value, f.otp.value]' });
    assert.ok(!leaks(read), 'page reads must be masked');
    await mcp.call('fl_close', { tab });
  });

  test('refuses a login whose website does not match the page', async () => {
    const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
    await assert.rejects(mcp.call('fl_login', { tab, item: 'Elsewhere' }), /Refused: .*elsewhere\.example/);
    const read = await mcp.call('fl_extract', { tab, js: 'return f.email.value' });
    assert.doesNotMatch(read, /bob@example/);
    await mcp.call('fl_close', { tab });
  });

  test('a recorded flow stores the source and login ID, not the secret, and replays the sign-in', async () => {
    await mcp.call('fl_record_start', { name: 'signin' });
    const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
    await mcp.call('fl_login', { tab });
    await mcp.call('fl_act', { tab, actions: [{ do: 'wait', text: 'Welcome' }] });
    await mcp.call('fl_record_stop', {});
    await mcp.call('fl_close', { tab });

    const flow = await mcp.call('fl_flow', { name: 'signin' });
    assert.match(flow, /"do": "login"/);
    assert.match(flow, /"source": "1password"/);
    assert.match(flow, /"item": "fixture1"/);
    assert.ok(!flow.includes('S3cret'));

    const run = await mcp.call('fl_run', { name: 'signin' });
    assert.match(run, /^OK "signin"/);
    assert.match(run, /Welcome ann@example.com/);
  });
});

for (const [kind, file] of [['bitwarden', 'fake-bw.mjs'], ['command', 'fake-command.mjs']]) {
  test(`${kind} source signs in with username, password and one-time code`, async () => {
    const mcp = await connect(testEnv({ FLINTRAIL_PASSWORDS: `${kind}:${bin(file)}` }));
    try {
      const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
      const out = await mcp.call('fl_login', { tab });
      assert.match(out, new RegExp(`${kind} login "Fixture shop".*filled username, password, one-time code, submitted`));
      const done = await mcp.call('fl_act', { tab, actions: [{ do: 'wait', text: 'Welcome' }] });
      assert.match(done, /Welcome ann@example.com/);
      assert.ok(!leaks(out + done + (await mcp.call('fl_network', { filter: '/api/login' }))));
    } finally {
      await mcp.client.close();
    }
  });
}

test('FLINTRAIL_PASSWORDS=off removes fl_login', async () => {
  const mcp = await connect(testEnv({ FLINTRAIL_PASSWORDS: 'off' }));
  try {
    const { tools } = await mcp.client.listTools();
    assert.ok(!tools.some((t) => t.name === 'fl_login'));
  } finally {
    await mcp.client.close();
  }
});

const chromeBin = chromium.executablePath();
test('browser source: the browser\'s own saved password, confirmed by a real click', { skip: !existsSync(chromeBin) && 'Chromium not installed' }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'flintrail-pm-'));
  const chrome = spawn(chromeBin, ['--headless=new', '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let mcp;
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
    const cdpUrl = `http://127.0.0.1:${readFileSync(portFile, 'utf8').split('\n')[0]}`;
    // Seed the profile the way the user would by saving a password once.
    const seed = await chromium.connectOverCDP(cdpUrl);
    const pm = await seed.contexts()[0].newPage();
    await pm.goto('chrome://password-manager/passwords');
    await pm.evaluate((url) => chrome.passwordsPrivate.addPassword({ url, username: 'ann@example.com', password: 'S3cret pass&"42', note: '', useAccountStore: false }), `${site.url}/login`);
    await pm.close();
    await seed.close();

    mcp = await connect(testEnv({ FLINTRAIL_MODE: 'attach', FLINTRAIL_CDP_URL: cdpUrl, FLINTRAIL_ALLOW_ANY_BROWSER: '1', FLINTRAIL_PASSWORDS: 'browser' }));
    const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login?otp=0` }));
    const out = await mcp.call('fl_login', { tab });
    assert.match(out, /Browser password manager: filled username, password, submitted/);
    const done = await mcp.call('fl_act', { tab, actions: [{ do: 'wait', text: 'Welcome' }] });
    assert.match(done, /Welcome ann@example.com/);
    assert.ok(!leaks(out + done + (await mcp.call('fl_network', { filter: '/api/login' }))), 'what the browser filled is masked too');

    await mcp.call('fl_record_start', { name: 'browser-signin' });
    const rec = tabOf(await mcp.call('fl_open', { url: `${site.url}/login?otp=0` }));
    await mcp.call('fl_login', { tab: rec });
    await mcp.call('fl_act', { tab: rec, actions: [{ do: 'wait', text: 'Welcome' }] });
    await mcp.call('fl_record_stop', {});
    const flow = await mcp.call('fl_flow', { name: 'browser-signin' });
    assert.match(flow, /"source": "browser"/);
    assert.doesNotMatch(flow, /"item"|S3cret/);
    assert.match(await mcp.call('fl_run', { name: 'browser-signin' }), /Welcome ann@example.com/);

    const blank = tabOf(await mcp.call('fl_open', { url: `${site.url}/` }));
    await assert.rejects(mcp.call('fl_login', { tab: blank }), /No saved login for 127\.0\.0\.1 \(tried browser\)/);
  } finally {
    await mcp?.client.close();
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
