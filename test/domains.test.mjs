import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.mjs';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { cli, connect, testEnv } from './helpers.mjs';

// The fixture answers on 127.0.0.1 (allowed here) and on localhost (the "other site").
let site, other, mcp;
before(async () => {
  site = await startFixture();
  other = site.url.replace('127.0.0.1', 'localhost');
  mcp = await connect(testEnv({ FLINTRAIL_ALLOWED_DOMAINS: '127.0.0.1' }));
});
after(async () => {
  await mcp.client.close();
  site.server.close();
});

const tabOf = (snap) => /Tab (t\d+)/.exec(snap)[1];

test('rules: exact host, wildcard with its bare domain, pasted URLs and ports', async () => {
  const { parseDomains } = await import('../dist/config.js');
  const { hostAllowed, domainProblem } = await import('../dist/domains.js');
  assert.throws(() => parseDomains('example.com, [::1]'), /cannot read "\[::1\]"/);
  const rules = parseDomains(' Example.com , *.example.org, https://shop.test:8443/path ,, ');
  assert.deepEqual(rules, ['example.com', '*.example.org', 'shop.test']);
  assert.equal(hostAllowed('example.com', rules), true);
  assert.equal(hostAllowed('www.example.com', rules), false);
  assert.equal(hostAllowed('example.org', rules), true);
  assert.equal(hostAllowed('a.b.example.org', rules), true);
  assert.equal(hostAllowed('badexample.org', rules), false);
  assert.equal(hostAllowed('example.org.evil.test', rules), false);
  assert.equal(domainProblem('https://shop.test/x', rules), null);
  assert.equal(domainProblem('about:blank', rules), null);
  assert.match(domainProblem('https://example.com@evil.test/', rules), /evil\.test is outside/);
  assert.match(domainProblem('file:///etc/hosts', rules), /outside/);
  assert.match(domainProblem('javascript:alert(1)', rules), /outside/);
  assert.equal(domainProblem('https://anything.test/', []), null);
});

test('an allowed site opens, another one is refused before anything is sent', async () => {
  const snap = await mcp.call('fl_open', { url: site.url });
  assert.match(snap, /Parking permit/);
  await mcp.call('fl_close', { tab: tabOf(snap) });
  await assert.rejects(mcp.call('fl_open', { url: other + '/secret' }), /Blocked: localhost is outside the sites the user allowed/);
});

test('an allowed address that redirects elsewhere is not read', async () => {
  await assert.rejects(
    mcp.call('fl_open', { url: `${site.url}/bounce?to=${encodeURIComponent(other + '/secret')}` }),
    (e) => /Blocked: .* redirected to another site/.test(e.message) && !/Other site secret/.test(e.message),
  );
});

test('a click that leaves the allowed sites stops the batch and reads nothing', async () => {
  const snap = await mcp.call('fl_open', { url: `${site.url}/away?to=${encodeURIComponent(other + '/secret')}` });
  const tab = tabOf(snap);
  const out = await mcp.call('fl_act', { tab, actions: [{ do: 'click', selector: '#out' }, { do: 'eval', js: 'return document.title' }] });
  assert.match(out, /Blocked/);
  assert.doesNotMatch(out, /Other site secret|"Secret"/);
  // The tab stays off limits for every tool until it is closed.
  await assert.rejects(mcp.call('fl_snapshot', { tab }), /Blocked: tab t\d+ went to a site/);
  await assert.rejects(mcp.call('fl_extract', { tab, js: 'return document.title' }), /Blocked/);
  await assert.rejects(mcp.client.callTool({ name: 'fl_screenshot', arguments: { tab } }).then((r) => { if (r.isError) throw new Error(r.content[0].text); }), /Blocked/);
  await mcp.call('fl_close', { tab });
});

test('goto and request to another site are refused, a request redirected away returns nothing', async () => {
  const snap = await mcp.call('fl_open', { url: site.url, text: 0 });
  const tab = tabOf(snap);
  const before = site.orders.length;
  const gone = await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'goto', url: other + '/secret' }] });
  assert.match(gone, /FAILED goto: Blocked: localhost is outside/);
  const sent = await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'request', method: 'POST', url: other + '/api/order', body: '{"plate":"X"}', headers: { 'content-type': 'application/json' } }] });
  assert.match(sent, /FAILED request: Blocked: localhost is outside/);
  assert.equal(site.orders.length, before);
  const bounced = await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'request', url: `/bounce?to=${encodeURIComponent(other + '/secret')}` }] });
  assert.doesNotMatch(bounced, /Other site secret/);
  // A relative request on the allowed site still works.
  const ok = await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'request', method: 'POST', url: '/api/order', body: '{"plate":"IN-1"}', headers: { 'content-type': 'application/json' } }] });
  assert.match(ok, /"plate":"IN-1"/);
  await mcp.call('fl_close', { tab });
});

test('a recorded flow whose start URL is another site does not run', async () => {
  await mcp.call('fl_record_start', { name: 'offsite', startUrl: other + '/secret' });
  await mcp.call('fl_record_stop');
  await assert.rejects(mcp.call('fl_run', { name: 'offsite' }), /Blocked: localhost is outside/);
});

const enc = encodeURIComponent;

test('an embedded frame of another site is never read, and refs keep pointing at the right frame', async () => {
  // Right after the page opens, the foreign frame may still be loading: it must not slip in.
  const snap = await mcp.call('fl_open', { url: `${site.url}/embed?to=${enc(other + '/secret')}` });
  const tab = tabOf(snap);
  const later = await mcp.call('fl_act', { tab, actions: [{ do: 'wait', ms: 800 }] });
  for (const out of [snap, later]) assert.doesNotMatch(out, /Private link one|Other button|Other site secret/);
  const ref = /\[(f\d+:e\d+)\] button "Inner button"/.exec(later)?.[1];
  assert.ok(ref, 'the frame of the allowed site is still readable');
  const before = site.hits.length;
  await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'click', ref }, { do: 'wait', ms: 200 }] });
  assert.deepEqual(site.hits.slice(before), ['127.0.0.1 /inner-clicked']);

  // Neither a ref nor a selector reaches into the foreign frame.
  const viaRef = await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'click', ref: 'f1:e1' }] });
  assert.match(viaRef, /FAILED click: Blocked: ref f1:e1 is in a frame of another site/);
  const viaSelector = await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'click', selector: '#foreign >> internal:control=enter-frame >> #ob' }] });
  assert.match(viaSelector, /FAILED click: Blocked: .* a selector cannot enter a frame/);
  const shot = await mcp.client.callTool({ name: 'fl_screenshot', arguments: { tab, selector: '#foreign >> internal:control=enter-frame >> #ob' } });
  assert.equal(shot.isError, true);
  assert.deepEqual(site.hits.slice(before), ['127.0.0.1 /inner-clicked']);

  // A screenshot hides the foreign frame while it is taken, then puts the page back as it was.
  const full = await mcp.client.callTool({ name: 'fl_screenshot', arguments: { tab } });
  assert.equal(full.content[0].type, 'image');
  const hiddenShot = Buffer.from(full.content[0].data, 'base64').length;
  const state = await mcp.call('fl_extract', { tab, js: 'return [...document.querySelectorAll("iframe")].map((f) => getComputedStyle(f).visibility)' });
  assert.match(state, /\["visible","visible"\]/);
  await mcp.call('fl_close', { tab });
  // The same page embedding an allowed frame shows it: the picture carries more.
  const snap2 = await mcp.call('fl_open', { url: `${site.url}/embed?to=${enc(site.url + '/secret')}` });
  const tab2 = tabOf(snap2);
  await mcp.call('fl_act', { tab: tab2, snapshot: false, actions: [{ do: 'wait', ms: 500 }] });
  const shown = await mcp.client.callTool({ name: 'fl_screenshot', arguments: { tab: tab2 } });
  assert.ok(Buffer.from(shown.content[0].data, 'base64').length > hiddenShot + 500, 'the foreign frame was drawn');
  await mcp.call('fl_close', { tab: tab2 });
});

test('a replayed flow stops as soon as a step leads to another site', async () => {
  site.state.away = '';
  await mcp.call('fl_record_start', { name: 'hop' });
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/hop' }));
  const rec = await mcp.call('fl_act', { tab, actions: [{ do: 'click', selector: '#next' }, { do: 'eval', js: 'return document.body.innerText' }] });
  assert.match(rec, /Landed here/);
  await mcp.call('fl_record_stop');
  await mcp.call('fl_close', { tab });

  site.state.away = other + '/secret';
  const run = await mcp.call('fl_run', { name: 'hop' }).catch((e) => e.message);
  site.state.away = '';
  assert.match(run, /FAILED at step 1.*Blocked: localhost is outside/s);
  assert.doesNotMatch(run, /Other site secret|Private link one/);
});

test('the network log shows nothing of another site', async () => {
  await assert.rejects(mcp.call('fl_open', { url: `${site.url}/bounce?to=${enc(other + '/secret')}` }), /Blocked/);
  const net = await mcp.call('fl_network', {});
  assert.doesNotMatch(net, / http:\/\/localhost/);
});

test('a file served by another site is not downloaded', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/dl?to=${enc(other + '/file')}`, text: 0 }));
  const out = await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'download', selector: '#get' }] });
  assert.match(out, /FAILED download: Blocked: the file comes from another site/);
  await mcp.call('fl_close', { tab });
  const tab2 = tabOf(await mcp.call('fl_open', { url: `${site.url}/dl?to=${enc(site.url + '/file')}`, text: 0 }));
  assert.match(await mcp.call('fl_act', { tab: tab2, snapshot: false, actions: [{ do: 'download', selector: '#get' }] }), /downloaded -> .*report\.bin/);
  await mcp.call('fl_close', { tab: tab2 });
});

test('a request is not carried to another site by a redirect', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url, text: 0 }));
  const before = site.hits.length;
  const out = await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'request', method: 'POST', url: `/redir307?to=${enc(other + '/sink')}`, body: 'x=1' }] });
  assert.match(out, /FAILED request: Blocked: the site answered with a redirect/);
  assert.deepEqual(site.hits.slice(before), []);
  await mcp.call('fl_close', { tab });
});

test('fl_login never fills a sign-in form embedded from another site', async () => {
  // Roles swapped: only localhost is allowed, the saved login belongs to 127.0.0.1.
  const bin = new URL('./fake-op.mjs', import.meta.url).pathname;
  chmodSync(bin, 0o755);
  const strict = await connect(testEnv({ FLINTRAIL_ALLOWED_DOMAINS: 'localhost', FLINTRAIL_PASSWORDS: `1password:${bin}` }));
  try {
    const tab = tabOf(await strict.call('fl_open', { url: `${other}/embed?to=${enc(site.url + '/login?otp=0')}` }));
    await strict.call('fl_act', { tab, snapshot: false, actions: [{ do: 'wait', ms: 800 }] });
    const before = site.hits.length;
    const out = await strict.call('fl_login', { tab }).catch((e) => e.message);
    assert.doesNotMatch(out, /filled/);
    await strict.call('fl_act', { tab, snapshot: false, actions: [{ do: 'wait', ms: 300 }] });
    assert.deepEqual(site.hits.slice(before), []);
  } finally { await strict.client.close(); }
});

test('a list that cannot be read stops Flintrail instead of opening every site', () => {
  for (const list of ['::1', 'https://', ' , ', 'exemple', '*', 'example.com, *.']) {
    const r = spawnSync(process.execPath, [cli], { env: testEnv({ FLINTRAIL_ALLOWED_DOMAINS: list }), input: '', encoding: 'utf8', timeout: 20000 });
    assert.notEqual(r.status, 0, `"${list}" must not start`);
    assert.match(r.stderr, /FLINTRAIL_ALLOWED_DOMAINS/);
  }
});

test('a flow recorded without the list cannot act in a frame the list now excludes', async () => {
  const env = testEnv();
  const free = await connect(env);
  const page = `${site.url}/embed?to=${enc(other + '/secret')}`;
  try {
    await free.call('fl_record_start', { name: 'inframe' });
    const tab = tabOf(await free.call('fl_open', { url: page }));
    const snap = await free.call('fl_act', { tab, actions: [{ do: 'wait', ms: 800 }] });
    const ref = /\[(f\d+:e\d+)\] button "Other button"/.exec(snap)?.[1];
    assert.ok(ref, 'without a list the embedded frame is readable');
    await free.call('fl_act', { tab, snapshot: false, actions: [{ do: 'click', ref }] });
    await free.call('fl_record_stop');
  } finally { await free.client.close(); }

  const strict = await connect({ ...env, FLINTRAIL_ALLOWED_DOMAINS: '127.0.0.1' });
  try {
    const before = site.hits.length;
    const run = await strict.call('fl_run', { name: 'inframe' }).catch((e) => e.message);
    assert.match(run, /FAILED at step 1.*Blocked: this step targets a frame of another site/s);
    assert.deepEqual(site.hits.slice(before), []);
  } finally { await strict.client.close(); }
});

test('a <base> tag cannot point a relative request at another site', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/based?to=${enc(other + '/')}`, text: 0 }));
  const before = site.hits.length;
  await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'request', url: '/sink' }, { do: 'request', url: 'sink' }] });
  assert.deepEqual(site.hits.slice(before), ['127.0.0.1 /sink', '127.0.0.1 /sink']);
  await mcp.call('fl_close', { tab });
});
