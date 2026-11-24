import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  let mcp, env;
  // A temporary folder of its own: the test sees every working copy Playwright leaves there.
  const work = mkdtempSync(join(tmpdir(), 'flintrail-work-'));
  before(async () => { env = testEnv({ FLINTRAIL_PASSWORDS: `1password:${bin('fake-op.mjs')}`, TMPDIR: work }); mcp = await connect(env); });
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

    // Scripts and screenshots are refused on the page that holds the filled secrets: base64 or a picture would slip past masking.
    const read = await mcp.call('fl_extract', { tab, js: 'return btoa(f.password.value + f.otp.value)' });
    assert.match(read, /Blocked: this page holds a password, code or secret Flintrail filled/);
    assert.ok(!read.includes(Buffer.from('S3cret').toString('base64').slice(0, 6)));
    await assert.rejects(mcp.call('fl_screenshot', { tab }), /Blocked: this page holds a password/);
    // The code box shows no value in snapshots, even if the page turned it into plain text.
    assert.match(await mcp.call('fl_snapshot', { tab }), /\] text "Code"\n|\] text "Code"$/m);
    const logs = await mcp.call('fl_console', { tab, level: 'all' });
    assert.match(logs, /signing in with/);
    assert.ok(!leaks(logs), 'console messages must be masked');
    // Audit log: which login, where, how approved, never a value.
    const audit = readFileSync(join(env.FLINTRAIL_HOME, 'fill-audit.log'), 'utf8');
    assert.match(audit, /"domain":"127\.0\.0\.1","item":"Fixture shop","ref":"fixture1","source":"1password","filled":\["username","password","one-time code"\],"approval":"dedicated browser"/);
    assert.ok(!leaks(audit), 'the audit log holds no value');
    await mcp.call('fl_close', { tab });
  });

  test('a trace is refused while another tab of the browser holds a filled password', async () => {
    const filled = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
    await mcp.call('fl_login', { tab: filled, submit: false });
    const other = tabOf(await mcp.call('fl_open', { url: `${site.url}/` }));
    await assert.rejects(mcp.call('fl_trace', { tab: other, action: 'start' }), /Blocked: this page holds a password/);
    await mcp.call('fl_close', { tab: filled });
    assert.match(await mcp.call('fl_trace', { tab: other, action: 'start' }), /Trace started/);
    assert.match(await mcp.call('fl_close', { tab: other }), /Trace saved/);
  });

  test('a trace and a video running when a password is filled are deleted, never saved', async () => {
    const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
    await mcp.call('fl_trace', { tab, action: 'start', name: 'with-login' });
    await mcp.call('fl_video', { tab, action: 'start', name: 'with-login' });
    await mcp.call('fl_login', { tab });
    assert.match(await mcp.call('fl_trace', { tab, action: 'stop' }), /Trace deleted: Flintrail filled a password, a code or a secret while it recorded/);
    assert.match(await mcp.call('fl_video', { tab, action: 'stop' }), /Video deleted: Flintrail filled a password/);
    // Nothing left on disk, under any name.
    await new Promise((r) => setTimeout(r, 500));
    const left = existsSync(env.FLINTRAIL_DOWNLOADS) ? readdirSync(env.FLINTRAIL_DOWNLOADS).filter((f) => /with-login/.test(f)) : [];
    assert.deepEqual(left, []);
    // Nor in Playwright's own working folders, where it keeps a copy until the browser closes: no trace file, picture
    // or video is left there.
    const copies = readdirSync(work).filter((d) => /^playwright-(artifacts|tracing)-/.test(d))
      .flatMap((d) => readdirSync(join(work, d), { recursive: true }).map((f) => join(work, d, String(f))))
      .filter((f) => statSync(f).isFile() && /\.(trace|network|jpe?g|webm|png)$/.test(f));
    assert.deepEqual(copies, [], 'no working copy left');
    assert.ok(readdirSync(work).some((d) => d.startsWith('playwright-artifacts-')), 'the browser did use this folder');
    // A new trace on the signed-in page is refused until it loads another page.
    await assert.rejects(mcp.call('fl_trace', { tab, action: 'start' }), /Blocked: this page holds a password/);
    await mcp.call('fl_close', { tab });
  });

  test('fills only the password or code field the agent names, never a text field', async () => {
    const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
    const snap = await mcp.call('fl_snapshot', { tab });
    const ref = (name) => new RegExp(`\\[(e\\d+)\\][^\\n]*${name}`, 'i').exec(snap)?.[1];
    await assert.rejects(mcp.call('fl_login', { tab, field: ref('email'), submit: false }), /Refused: field e\d+ is not a password or one-time code field/);
    const out = await mcp.call('fl_login', { tab, field: ref('password'), submit: false });
    assert.match(out, /filled password\./);
    assert.ok(!leaks(out));
    // Only that field was filled: the form sends an empty e-mail and a (masked) password.
    await mcp.call('fl_act', { tab, actions: [{ do: 'press', key: 'Enter', target: ref('password') }] });
    await mcp.call('fl_act', { tab, actions: [{ do: 'wait', text: 'Wrong credentials' }] });
    assert.match(await mcp.call('fl_network', { filter: '/api/login' }), /"email":"","password":"•••"/);
    await mcp.call('fl_close', { tab });
  });

  test('refuses a page where the agent ran JavaScript: it could catch the value as it is filled', async () => {
    const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
    await mcp.call('fl_extract', { tab, js: 'f.password.addEventListener("input", (e) => { window.caught = e.target.value; }); return "listening"' });
    await assert.rejects(mcp.call('fl_login', { tab }), /Refused: you ran JavaScript in this tab/);
    // Even after a reload: a window the script opened would outlive it. A new tab is clean.
    await mcp.call('fl_act', { tab, actions: [{ do: 'goto', url: `${site.url}/login` }] });
    await assert.rejects(mcp.call('fl_login', { tab }), /Refused: you ran JavaScript in this tab/);
    await mcp.call('fl_close', { tab });
    const fresh = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
    assert.match(await mcp.call('fl_login', { tab: fresh, submit: false }), /filled username, password, one-time code\./);
    await mcp.call('fl_close', { tab: fresh });
  });

  test('never fills a payment card or bank item', async () => {
    const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
    await assert.rejects(mcp.call('fl_login', { tab, item: 'Company card' }), /No saved login "Company card"/);
    assert.match(await mcp.call('fl_extract', { tab, js: 'return f.password.value === ""' }), /true/);
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

test('1Password vaults: every vault by default, only the ones the user lists, never the ones they exclude', async () => {
  const run = async (extra, check) => {
    const mcp = await connect(testEnv({ FLINTRAIL_PASSWORDS: `1password:${bin('fake-op.mjs')}`, ...extra }));
    try {
      const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
      await check(mcp, tab);
      await mcp.call('fl_close', { tab });
    } finally {
      await mcp.client.close();
    }
  };
  // Excluded: the only matching login is left out, and the message says where Flintrail looked and why.
  await run({ FLINTRAIL_EXCLUDE_VAULTS: 'test' }, async (mcp, tab) => {
    // The excluded vault is not even named, nor what it holds: only how many logins the settings left out.
    await assert.rejects(mcp.call('fl_login', { tab }), (e) => /1Password vaults searched: none the settings allow; the user's vault settings: every vault, never test; 1 matching login\(s\) left out by those settings/.test(e.message) && !/Fixture shop|ann@example/.test(e.message));
    assert.match(await mcp.call('fl_extract', { tab, js: 'return f.password.value === ""' }), /true/);
  });
  // Only other vaults allowed: the same.
  await run({ FLINTRAIL_VAULTS: 'Clients, Work' }, async (mcp, tab) => {
    await assert.rejects(mcp.call('fl_login', { tab }), /only Clients, Work.*1 matching login\(s\) left out by those settings/);
  });
  // Listed (any case): used.
  await run({ FLINTRAIL_VAULTS: 'clients,TEST' }, async (mcp, tab) => {
    assert.match(await mcp.call('fl_login', { tab }), /1password login "Fixture shop"/);
  });
  // A service account is told apart: it only opens the vaults it was given.
  await run({ FLINTRAIL_EXCLUDE_VAULTS: 'Test', OP_SERVICE_ACCOUNT_TOKEN: 'not-a-real-token' }, async (mcp, tab) => {
    await assert.rejects(mcp.call('fl_login', { tab }), /service account only opens the shared vaults it was given \(never Private/);
  });
});

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

    // The browser's own saved login is for ann: asked for another account, nothing is submitted.
    const other = tabOf(await mcp.call('fl_open', { url: `${site.url}/login?otp=0` }));
    const sentBefore = site.hits.filter((h) => h.endsWith('/api/login')).length;
    await assert.rejects(mcp.call('fl_login', { tab: other, account: 'carol@example.com' }), /Refused: no saved login for carol@example\.com .*other accounts: the browser's own saved login \(ann@example\.com\)\. Nothing was filled/);
    assert.equal(site.hits.filter((h) => h.endsWith('/api/login')).length, sentBefore);
    assert.match(await mcp.call('fl_login', { tab: other, account: 'ANN@example.com' }), /Browser password manager: filled username, password, submitted/);
    await mcp.call('fl_close', { tab: other });

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
      await assert.rejects(mcp.call('fl_login', { tab }), /Refused: the page asks for the password of carol@example\.com, none of the saved logins is for that account\. Nothing was filled/);
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
      // An account kept in a hidden part of the page is not the one the step is about.
      assert.deepEqual((await attempt(`${as('carol@example.com')}&hidden=${encodeURIComponent('ann@example.com')}`)).sent, 0);
      // Odd characters stuck to an address do not make it another address.
      for (const odd of ['•ann@example.com', '••ann@example.com', 'x#ann@example.com', "o'ann@example.com"]) {
        assert.deepEqual((await attempt(as(odd))).sent, 0, odd);
      }
      // Two accounts on the step: not clear whose password is asked.
      const both = await attempt(`${as('ann@example.com')}&note=${encodeURIComponent('Not you? Switch to carol@example.com')}`);
      assert.match(both.out, /Refused: the page shows several accounts/);
      assert.equal(both.sent, 0);
      // A frame of another website naming the saved account says nothing about this sign-in.
      const framed = `${site.url.replace('127.0.0.1', 'localhost')}/login-step?${as('ann@example.com')}`;
      assert.deepEqual((await attempt(`${as('carol@example.com')}&frame=${encodeURIComponent(framed)}`)).sent, 0);
      // A page too large to read whole: refused rather than guessed, and quickly.
      const t0 = Date.now();
      const huge = await attempt(`${as('carol@example.com')}&pad=45000`);
      assert.match(huge.out, /Refused: this page is too large to tell which account/);
      assert.equal(huge.sent, 0);
      // A very long text without any address is read fast and changes nothing.
      assert.deepEqual((await attempt(`${as('ann@example.com')}&long=10000`)).sent, 1);
      assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
      // An address split by markup still reads as one.
      assert.deepEqual((await attempt('note=' + encodeURIComponent('<b>ann</b>@example.com'))).sent, 1);
      // A very long address read on the page is cut in the message.
      const long = await attempt(as(`${'x'.repeat(400)}@example.com`));
      assert.equal(long.sent, 0);
      assert.ok(long.out.length < 700, `message of ${long.out.length} characters`);
    } finally { await mcp.client.close(); }
  });

  test('a name the page shows by chance does not pick a saved login', async () => {
    const run = async (username, query) => {
      const mcp = await connect(testEnv({ FLINTRAIL_PASSWORDS: `1password:${bin('fake-op.mjs')}`, FAKE_OP_USERNAME: username }));
      try {
        const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login-step?${query}` }));
        const before = site.attempts.length;
        const out = await mcp.call('fl_login', { tab }).catch((e) => e.message);
        await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'wait', ms: 250 }] });
        return { out, sent: site.attempts.length - before };
      } finally { await mcp.client.close(); }
    };
    const ann = `as=${encodeURIComponent('ann@example.com')}`;
    // A plain username is an ordinary word: the page saying "support" is not the account "support".
    const word = await run('support', `${ann}&note=${encodeURIComponent('Contact support if you are locked out')}`);
    assert.match(word.out, /Refused: the page asks for the password of ann@example\.com/);
    assert.equal(word.sent, 0);
    // The site's contact address in the footer is not the account either.
    const footer = await run('help@example.com', `${ann}&support=1`);
    assert.match(footer.out, /Refused: the page asks for the password of ann@example\.com/);
    assert.equal(footer.sent, 0);
    // Letters outside ASCII and a leading bullet do not turn one address into another.
    assert.equal((await run('ann@example.com', `as=${encodeURIComponent('éann@example.com')}`)).sent, 0);
    assert.equal((await run('joann@example.com', `as=${encodeURIComponent('•ann@example.com')}`)).sent, 0);
    assert.equal((await run('ann@example.com', `as=${encodeURIComponent('• ann@example.com')}`)).sent, 1);
  });

  test('asked for one account, a saved login for another is never used', async () => {
    const posts = () => site.hits.filter((h) => h.endsWith('/api/login')).length + site.attempts.length;
    const mcp = await connect(testEnv({ FLINTRAIL_PASSWORDS: `1password:${bin('fake-op.mjs')}` }));
    try {
      // A plain sign-in form that names nobody, and the only saved login is ann's.
      const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login` }));
      const before = posts();
      await assert.rejects(mcp.call('fl_login', { tab, account: 'carol@example.com' }),
        /Refused: no saved login for carol@example\.com on 127\.0\.0\.1 .*other accounts: "Fixture shop" \(ann@example\.com.*Nothing was filled/);
      await assert.rejects(mcp.call('fl_login', { tab, account: 'carol@example.com', item: 'fixture1' }), /Refused: no saved login for carol@example\.com/);
      await assert.rejects(mcp.call('fl_login', { tab, account: '  ' }), /account is empty/);
      // Read without running a script (fl_login refuses a tab the agent ran JavaScript in): no e-mail typed, nothing sent.
      assert.doesNotMatch(await mcp.call('fl_snapshot', { tab }), /email "Email[^"]*" = /);
      assert.equal(posts(), before);

      // The account asked for is the saved one, whatever the case: it signs in, and a recorded flow keeps the lock.
      await mcp.call('fl_record_start', { name: 'locked-signin', startUrl: `${site.url}/login` });
      assert.match(await mcp.call('fl_login', { tab, account: 'Ann@Example.com' }), /filled username, password, one-time code, submitted/);
      await mcp.call('fl_record_stop');
      assert.match(await mcp.call('fl_flow', { name: 'locked-signin' }), /"account": "Ann@Example\.com"/);
      await mcp.call('fl_close', { tab });
    } finally { await mcp.client.close(); }

    // Two saved logins: asking for bob on a step that names ann fills nothing.
    const two = await connect(testEnv({ FLINTRAIL_PASSWORDS: `1password:${bin('fake-op.mjs')}`, FAKE_OP_SECOND: '1' }));
    try {
      const tab = tabOf(await two.call('fl_open', { url: `${site.url}/login-step?as=${encodeURIComponent('ann@example.com')}` }));
      const before = posts();
      await assert.rejects(two.call('fl_login', { tab, account: 'bob@example.com' }), /Refused: the page asks for the password of ann@example\.com/);
      assert.equal(posts(), before);
      await two.call('fl_close', { tab });
      const own = tabOf(await two.call('fl_open', { url: `${site.url}/login-step?as=${encodeURIComponent('bob@example.com')}` }));
      assert.match(await two.call('fl_login', { tab: own, account: 'bob@example.com' }), /bob@example\.com.*filled password, submitted/);
      await two.call('fl_act', { tab: own, snapshot: false, actions: [{ do: 'wait', text: 'Step done' }] });
      assert.deepEqual(site.attempts.at(-1), { email: 'bob@example.com', password: 'Second pass 77' });
      await two.call('fl_close', { tab: own });
    } finally { await two.client.close(); }
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
