import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.mjs';
import { connect, testEnv } from './helpers.mjs';

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
