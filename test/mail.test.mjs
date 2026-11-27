// fl_mail_code and fl_mail_link: a code or a link sent to the mailbox open in the browser is used by Rocketwright
// itself, never shown to the agent. Fake Gmail and Outlook pages stand in for the real ones (served on *.localhost,
// which the browser sends to this computer), declared to Rocketwright with ROCKETWRIGHT_MAIL_HOSTS.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.mjs';
import { connect, refOf, testEnv } from './helpers.mjs';

const CODE = '4812736';
const OTHER_CODE = '9911223';
const TOKEN = 'tok3n0123456789abcdefXYZ';
const tabOf = (snap) => /Tab (t\d+)/.exec(snap)[1];
const minutesAgo = (n) => Date.now() - n * 60_000;

let site, port, mcp;
const at = (host, path) => `http://${host}:${port}${path}`;
const codeMail = (o = {}) => ({
  id: 'm1', from: 'noreply@notify.acme.localhost', name: 'Acme', subject: 'Your Acme verification code', at: minutesAgo(2), preview: 'Use this code to sign in',
  html: `<p>Hello,</p><p>Your verification code is:</p><p style="font-size:24px"><strong>${CODE}</strong></p><p>It expires in 10 minutes. Order 2026 of your account.</p><p>© 2026 Acme Inc, 12 Main Street</p>`,
  ...o,
});
const setMails = (...list) => { site.mails.splice(0, site.mails.length, ...list); };

before(async () => {
  site = await startFixture();
  port = new URL(site.url).port;
  mcp = await connect(testEnv({ ROCKETWRIGHT_MAIL_HOSTS: 'gmail.localhost=gmail,outlook.localhost=outlook' }));
});
after(async () => {
  await mcp?.client.close();
  site?.server.close();
});

describe('reading what a webmail shows', () => {
  test('the time an e-mail arrived, in the formats webmails use', async () => {
    const { parseMailTime } = await import('../dist/mail.js');
    const now = new Date(2026, 10, 27, 10, 45);
    const read = (t, lang) => parseMailTime(t, now, lang)?.at.getTime();
    assert.equal(read('10:42 AM'), new Date(2026, 10, 27, 10, 42).getTime());
    assert.equal(read('Fri, Nov 27, 2026, 10:42 AM'), new Date(2026, 10, 27, 10, 42).getTime());
    assert.equal(read('ven. 27 nov. 2026, 10:42', 'fr-FR'), new Date(2026, 10, 27, 10, 42).getTime());
    assert.equal(read('mar. 24 nov. 2026 09:05', 'fr-FR'), new Date(2026, 10, 24, 9, 5).getTime());
    assert.equal(read('27/11/2026 10:40', 'fr-FR'), new Date(2026, 10, 27, 10, 40).getTime());
    assert.equal(read('Fri, 11/27/2026, 10:41 AM', 'en-US'), new Date(2026, 10, 27, 10, 41).getTime());
    assert.equal(read('2:30 PM'), new Date(2026, 10, 26, 14, 30).getTime(), 'a time still ahead today was yesterday');
    assert.equal(read('il y a 5 minutes', 'fr-FR'), now.getTime() - 5 * 60_000);
    assert.equal(read('Nov 26'), new Date(2026, 10, 26, 0, 0).getTime());
    assert.equal(read('Yesterday 23:58'), new Date(2026, 10, 26, 23, 58).getTime());
    assert.equal(read('Thursday'), undefined, 'a weekday alone says too little');
    assert.equal(read('Dec 31, 2026 10:00'), undefined, 'never in the future');
  });

  test('the code: the number shown on its own, else the first one that is not a year, else pattern', async () => {
    const { extractCode } = await import('../dist/mail.js');
    assert.equal(extractCode('Your code is 4812736. © 2026', ['4812736']), '4812736');
    assert.equal(extractCode('© 2026 Acme. Code: 123 456', ['123 456']), '123456');
    assert.equal(extractCode('In 2026 your code 551234 expires', []), '551234');
    assert.throws(() => extractCode('Codes 1111 or 2222', ['1111', '2222']), /2 different numbers/);
    assert.throws(() => extractCode('Total 49.99 €, year 2026', []), /No code of 4 to 8 digits/);
    assert.equal(extractCode('Your code: AB-12CD', [], 'code: ([A-Z0-9-]+)'), 'AB-12CD');
    assert.throws(() => extractCode('nothing', [], '(\\d{6})'), /no text matching pattern/);
  });

  test('senders, organisations, money sites and token-bearing addresses', async () => {
    const { senderMatches, orgOf, moneySite, parseFrom } = await import('../dist/mail.js');
    const { maskUrl } = await import('../dist/secrets.js');
    assert.ok(senderMatches('noreply@notify.cloudflare.com', 'cloudflare.com'));
    assert.ok(senderMatches('noreply@notify.cloudflare.com', 'noreply@notify.cloudflare.com'));
    assert.ok(!senderMatches('noreply@cloudflare.com.evil.example', 'cloudflare.com'));
    assert.ok(!senderMatches('noreply@notcloudflare.com', 'cloudflare.com'));
    assert.equal(orgOf('noreply@notify.cloudflare.com'), 'cloudflare.com');
    assert.equal(orgOf('dash.cloudflare.com'), 'cloudflare.com');
    assert.throws(() => parseFrom('Cloudflare'), /not "Cloudflare": a display name proves nothing/);
    for (const s of ['paypal.com', 'boursobank.com', 'my-bank.example', 'pay.example', 'coinbase.com']) assert.ok(moneySite(s), s);
    for (const s of ['cloudflare.com', 'github.com', 'cardiff.ac.uk', 'acme.localhost']) assert.equal(moneySite(s), null, s);
    assert.equal(maskUrl(`https://acme.example/verify/${TOKEN}?t=abc&lang=fr#frag`), 'https://acme.example/verify/•••?t=•••&lang=•••#•••');
  });
});

describe('fl_mail_code', () => {
  let mailbox;
  before(async () => {
    setMails(codeMail(), { id: 'm2', from: 'security@other.localhost', name: 'Other', subject: 'Your Other code', at: minutesAgo(1), html: `<p>Code <b>${OTHER_CODE}</b></p>` });
    mailbox = tabOf(await mcp.call('fl_open', { url: at('gmail.localhost', '/mail/u/0/'), text: 0 }));
  });

  test('types the code of the newest e-mail from the sender in Gmail, and never returns it', async () => {
    const tab = tabOf(await mcp.call('fl_open', { url: at('dash.acme.localhost', '/code') }));
    const out = await mcp.call('fl_mail_code', { tab, from: 'notify.acme.localhost', waitSeconds: 0 });
    assert.match(out, /Code from noreply@notify\.acme\.localhost \("Your Acme verification code", received \d\d:\d\d, \d+ min ago\): 7 characters, typed and submitted/);
    assert.ok(!out.includes(CODE), 'the code never reaches the agent');
    assert.match(await mcp.call('fl_act', { tab, actions: [{ do: 'wait', text: 'Verified' }], diff: false }), /Verified/);
    assert.deepEqual(site.codes.splice(0), [CODE]);
    // The mailbox is back on its list, closed to scripts, and the code is masked wherever it shows.
    await assert.rejects(mcp.call('fl_screenshot', { tab: mailbox }), /Blocked: this page holds a password, code or secret/);
    const opened = await mcp.call('fl_act', { tab: mailbox, diff: false, text: 2000, actions: [{ do: 'click', text: 'Your Acme verification code' }, { do: 'wait', ms: 300 }] });
    assert.ok(!opened.includes(CODE), 'masked in the mailbox too');
    await mcp.call('fl_act', { tab: mailbox, actions: [{ do: 'back' }] });
    await mcp.call('fl_close', { tab });
  });

  test('refuses what does not fit: too old, unknown sender, display name, another organisation, money sites, a tab with your JavaScript', async () => {
    const tab = tabOf(await mcp.call('fl_open', { url: at('dash.acme.localhost', '/code') }));
    await assert.rejects(mcp.call('fl_mail_code', { tab, from: 'acme.localhost', maxAgeMinutes: 1, waitSeconds: 0 }),
      /No e-mail from acme\.localhost received in the last 1 min .*the newest one from noreply@notify\.acme\.localhost arrived at \d\d:\d\d, \d+ min ago, older than 1 min/);
    await assert.rejects(mcp.call('fl_mail_code', { tab, from: 'nobody.localhost', waitSeconds: 0 }), /No e-mail from nobody\.localhost/);
    await assert.rejects(mcp.call('fl_mail_code', { tab, from: 'Acme', waitSeconds: 0 }), /from must be the sender's address or domain/);
    await assert.rejects(mcp.call('fl_mail_code', { tab, from: 'other.localhost', waitSeconds: 0 }),
      /the e-mail comes from other\.localhost, the form is on acme\.localhost\. If the user confirmed .* pass site:"acme\.localhost"/);
    await assert.rejects(mcp.call('fl_mail_code', { tab, from: 'other.localhost', site: 'other.localhost', waitSeconds: 0 }), /site must be the registrable domain of the form \(acme\.localhost\)/);
    assert.deepEqual(site.codes, [], 'nothing typed so far');
    // The user said this sender serves that site: allowed, still never shown.
    const crossed = await mcp.call('fl_mail_code', { tab, from: 'other.localhost', site: 'acme.localhost', waitSeconds: 0 });
    assert.match(crossed, /Code from security@other\.localhost .* 7 characters, typed and submitted/);
    assert.ok(!crossed.includes(OTHER_CODE));
    await mcp.call('fl_act', { tab, actions: [{ do: 'wait', text: 'Verified' }] });
    assert.deepEqual(site.codes.splice(0), [OTHER_CODE]);
    await mcp.call('fl_close', { tab });

    const bank = tabOf(await mcp.call('fl_open', { url: at('dash.bank.localhost', '/code') }));
    await assert.rejects(mcp.call('fl_mail_code', { tab: bank, from: 'acme.localhost', waitSeconds: 0 }), /bank\.localhost looks like a payment, bank or crypto service/);
    await mcp.call('fl_close', { tab: bank });

    const used = tabOf(await mcp.call('fl_open', { url: at('dash.acme.localhost', '/code') }));
    await mcp.call('fl_extract', { tab: used, js: 'return 1' });
    await assert.rejects(mcp.call('fl_mail_code', { tab: used, from: 'acme.localhost', waitSeconds: 0 }), /you ran JavaScript in this tab/);
    await mcp.call('fl_close', { tab: used });
  });

  test('an e-mail about a payment is never used', async () => {
    setMails(codeMail({ subject: 'Confirm your payment of 49 EUR' }));
    const tab = tabOf(await mcp.call('fl_open', { url: at('dash.acme.localhost', '/code') }));
    await assert.rejects(mcp.call('fl_mail_code', { tab, from: 'acme.localhost', waitSeconds: 0 }), /this e-mail is about a payment/);
    assert.deepEqual(site.codes, []);
    await mcp.call('fl_close', { tab });
  });

  test('waits for the e-mail to arrive', async () => {
    setMails();
    const tab = tabOf(await mcp.call('fl_open', { url: at('dash.acme.localhost', '/code') }));
    setTimeout(() => setMails(codeMail({ at: Date.now() })), 2500);
    const out = await mcp.call('fl_mail_code', { tab, from: 'acme.localhost', waitSeconds: 20, submit: false });
    assert.match(out, /\d min ago\): 7 characters, typed, not submitted/);
    assert.ok(!out.includes(CODE));
    await mcp.call('fl_close', { tab });
  });

  test('Outlook: rows without addresses are opened newest first, and only the sender in the message header counts', async () => {
    setMails(codeMail({ at: minutesAgo(3) }), { id: 'm2', from: 'news@other.localhost', name: 'Acme', subject: 'Acme news', at: minutesAgo(1), html: '<p>Promo 778899</p>' });
    const outlook = tabOf(await mcp.call('fl_open', { url: at('outlook.localhost', '/mail/'), text: 0 }));
    await mcp.call('fl_close', { tab: mailbox });
    const tab = tabOf(await mcp.call('fl_open', { url: at('dash.acme.localhost', '/code') }));
    const out = await mcp.call('fl_mail_code', { tab, from: 'notify.acme.localhost', waitSeconds: 0 });
    assert.match(out, /Code from noreply@notify\.acme\.localhost \("Your Acme verification code", received \d\d:\d\d, \d+ min ago\): 7 characters, typed and submitted/);
    await mcp.call('fl_act', { tab, actions: [{ do: 'wait', text: 'Verified' }] });
    assert.deepEqual(site.codes.splice(0), [CODE]);
    await mcp.call('fl_close', { tab });
    await mcp.call('fl_close', { tab: outlook });
  });

  test('no webmail open in the browser: the agent is told what to do', async () => {
    const tab = tabOf(await mcp.call('fl_open', { url: at('dash.acme.localhost', '/code') }));
    await assert.rejects(mcp.call('fl_mail_code', { tab, from: 'acme.localhost', waitSeconds: 0 }), /No webmail tab Rocketwright can read is open in agent .*Ask the user to open their mailbox/);
    await mcp.call('fl_close', { tab });
  });
});

describe('fl_mail_link', () => {
  let mailbox;
  before(async () => {
    mailbox = tabOf(await mcp.call('fl_open', { url: at('gmail.localhost', '/mail/u/0/'), text: 0 }));
  });
  after(async () => { await mcp.call('fl_close', { tab: mailbox }); });

  test('opens the verification link to the sender\'s site in a new tab, its token masked', async () => {
    setMails(codeMail({
      subject: 'Verify your e-mail',
      html: `<p>Click below.</p><a href="${at('app.acme.localhost', `/verify?token=${TOKEN}`)}">Verify email</a> <a href="${at('acme.localhost', '/help')}">Help</a> <a href="${at('track.other.localhost', '/unsub')}">Unsubscribe</a>`,
    }));
    const out = await mcp.call('fl_mail_link', { from: 'acme.localhost', waitSeconds: 0 });
    assert.match(out, /Link "Verify email" from noreply@notify\.acme\.localhost \("Verify your e-mail", received .*\) opened in tab t\d+: http:\/\/app\.acme\.localhost:\d+\/verify\?token=••• \(one-time parts of the address masked\)/);
    assert.match(out, /Your e-mail is verified/);
    assert.ok(!out.includes(TOKEN), 'the token never reaches the agent');
    const tab = /opened in tab (t\d+)/.exec(out)[1];
    assert.ok(!(await mcp.call('fl_tabs')).includes(TOKEN));
    await mcp.call('fl_close', { tab });
  });

  test('refuses a link to another organisation, one that leads elsewhere, and an unclear choice', async () => {
    setMails(codeMail({ subject: 'Verify', html: `<a href="${at('evil.localhost', '/verify?x=1')}">Verify email</a>` }));
    await assert.rejects(mcp.call('fl_mail_link', { from: 'acme.localhost', link: 'Verify', waitSeconds: 0 }), /the e-mail comes from acme\.localhost, the link is on evil\.localhost/);
    setMails(codeMail({ subject: 'Verify', html: `<a href="${at('app.acme.localhost', `/bounce?to=${encodeURIComponent(at('evil.localhost', '/landing'))}`)}">Confirm</a>` }));
    await assert.rejects(mcp.call('fl_mail_link', { from: 'acme.localhost', waitSeconds: 0 }), /the link led to evil\.localhost, not acme\.localhost\. The tab was closed/);
    setMails(codeMail({ subject: 'Verify', html: `<a href="${at('app.acme.localhost', '/verify?a=1')}">Verify here</a> <a href="${at('app.acme.localhost', '/verify?a=2')}">Or verify there</a>` }));
    await assert.rejects(mcp.call('fl_mail_link', { from: 'acme.localhost', waitSeconds: 0 }), /2 different links match: "Verify here" -> app\.acme\.localhost; "Or verify there" -> app\.acme\.localhost/);
    const ok = await mcp.call('fl_mail_link', { from: 'acme.localhost', link: 'there', waitSeconds: 0 });
    assert.match(ok, /Link "Or verify there"/);
    await mcp.call('fl_close', { tab: /opened in tab (t\d+)/.exec(ok)[1] });
  });
});

// The field named by the agent is checked: only a one-time code box receives the code.
test('a named field must be a one-time code field', async () => {
  setMails(codeMail());
  const box = tabOf(await mcp.call('fl_open', { url: at('gmail.localhost', '/mail/u/0/'), text: 0 }));
  const snap = await mcp.call('fl_open', { url: at('dash.acme.localhost', '/login?otp=0') });
  const tab = tabOf(snap);
  const email = refOf(snap, /Email/);
  await assert.rejects(mcp.call('fl_mail_code', { tab, from: 'acme.localhost', field: email, waitSeconds: 0 }), /field e\d+ is not a one-time code field/);
  await mcp.call('fl_close', { tab });
  await mcp.call('fl_close', { tab: box });
});
