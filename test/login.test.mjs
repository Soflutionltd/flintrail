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
    const done = await mcp.call('fl_act', { tab, diff: false, actions: [{ do: 'wait', text: 'Welcome' }] });
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
      const done = await mcp.call('fl_act', { tab, diff: false, actions: [{ do: 'wait', text: 'Welcome' }] });
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
  // Linux CI runners forbid the unprivileged user namespaces Chrome's sandbox needs (Playwright passes the same flag).
  const chrome = spawn(chromeBin, ['--headless=new', '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let mcp;
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(portFile), `Chrome did not start (exit code ${chrome.exitCode})`);
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
    const done = await mcp.call('fl_act', { tab, diff: false, actions: [{ do: 'wait', text: 'Welcome' }] });
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
    // A Chrome that already exited never emits 'exit' again: waiting for it would hang the suite.
    if (chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((r) => chrome.once('exit', r));
      chrome.kill();
      await exited;
    }
    // Chrome's helper processes keep writing to the profile for a moment after the main one is gone.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 40) throw error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
});

describe('a sign-in step that already names the account', () => {
  const step = (email) => `${site.url}/login-step?as=${encodeURIComponent(email)}`;

  test('with two saved logins for the site, the one the page names is used', async () => {
    const mcp = await connect(testEnv({ FLINTRAIL_PASSWORDS: `1password:${bin('fake-op.mjs')}`, FAKE_OP_SECOND: '1' }));
    try {
      // The other login is the one saved under this exact address: the page's account still wins.
      for (const [email, password] of [['ann@example.com', SECRET], ['bob@example.com', 'Second pass 77']]) {
        const tab = tabOf(await mcp.call('fl_open', { url: step(email) }));
        const before = site.attempts.length;
        const out = await mcp.call('fl_login', { tab });
        assert.match(out, new RegExp(`\\(${email.replace('.', '\\.')}, .*filled password, submitted`));
        await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'wait', text: 'Step done' }] });
        assert.deepEqual(site.attempts.slice(before), [{ email, password }]);
        assert.ok(!out.includes(password));
        await mcp.call('fl_close', { tab });
      }
      // An account neither login is for: nothing is sent, the agent is told to choose.
      const tab = tabOf(await mcp.call('fl_open', { url: step('carol@example.com') }));
      const before = site.attempts.length;
      await assert.rejects(mcp.call('fl_login', { tab }), /Several saved logins match and the page does not say which account it is \(it shows carol@example\.com\)/);
      assert.equal(site.attempts.length, before);
      // Named explicitly, a login is used as asked.
      assert.match(await mcp.call('fl_login', { tab, item: 'bob@example.com' }), /bob@example\.com.*filled password/);
      await mcp.call('fl_close', { tab });
    } finally { await mcp.client.close(); }
  });

  test('look-alike, hidden and labelled account names are told apart', async () => {
    const mcp = await connect(testEnv({ FLINTRAIL_PASSWORDS: `1password:${bin('fake-op.mjs')}` }));
    const attempt = async (query) => {
      const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login-step?${query}` }));
      const before = site.attempts.length;
      const out = await mcp.call('fl_login', { tab }).catch((e) => e.message);
      await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'wait', ms: 250 }] });
      await mcp.call('fl_close', { tab });
      return { out, sent: site.attempts.length - before };
    };
    const as = (v) => `as=${encodeURIComponent(v)}`;
    try {
      // The saved login is ann@example.com. Another account whose name contains it is not it.
      assert.deepEqual((await attempt(as('joann@example.com'))).sent, 0);
      assert.deepEqual((await attempt(as('ann@example.com.evil.test'))).sent, 0);
      // Partly hidden names: the one that fits is used, the one that cannot fit is refused.
      assert.deepEqual((await attempt(as('a••@example.com'))).sent, 1);
      assert.deepEqual((await attempt(as('an*@example.com'))).sent, 1);
      const hidden = await attempt(as('c••••@example.com'));
      assert.match(hidden.out, /Refused: the page asks for the password of c••••@example\.com/);
      assert.equal(hidden.sent, 0);
      assert.deepEqual((await attempt(as('a••@other.test'))).sent, 0);
      // Named in a label rather than in the text.
      assert.deepEqual((await attempt('label=' + encodeURIComponent('ann@example.com'))).sent, 1);
      assert.deepEqual((await attempt('label=' + encodeURIComponent('carol@example.com'))).sent, 0);
      // A support address in the footer is not an account: the step that names nobody still signs in.
      assert.deepEqual((await attempt('support=1')).sent, 1);
      // A very long address read on the page is cut in the message.
      const long = await attempt(as(`${'x'.repeat(400)}@example.com`));
      assert.equal(long.sent, 0);
      assert.ok(long.out.length < 700, `message of ${long.out.length} characters`);
    } finally { await mcp.client.close(); }
  });

  test('a single saved login is not used for another account the page names', async () => {
    const mcp = await connect(testEnv({ FLINTRAIL_PASSWORDS: `1password:${bin('fake-op.mjs')}` }));
    try {
      const tab = tabOf(await mcp.call('fl_open', { url: step('carol@example.com') }));
      const before = site.attempts.length;
      await assert.rejects(mcp.call('fl_login', { tab }), /Refused: the page asks for the password of carol@example\.com, the saved login .*ann@example\.com.* is another account\. Nothing was filled/);
      await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'wait', ms: 300 }] });
      assert.equal(site.attempts.length, before);
      await mcp.call('fl_close', { tab });
    } finally { await mcp.client.close(); }
  });
});
