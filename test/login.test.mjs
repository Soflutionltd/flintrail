import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { startFixture } from './fixture.mjs';
import { connect, testEnv } from './helpers.mjs';

const fakeOp = new URL('./fake-op.mjs', import.meta.url).pathname;
const SECRET = 'S3cret pass&"42';
const leaks = (out) => [SECRET, JSON.stringify(SECRET).slice(1, -1), encodeURIComponent(SECRET), '123456'].some((s) => out.includes(s));

let site, mcp;

before(async () => {
  chmodSync(fakeOp, 0o755);
  site = await startFixture();
  mcp = await connect(testEnv({ FLINTRAIL_OP: fakeOp }));
});

after(async () => {
  await mcp.client.close();
  site.server.close();
});

test('fl_login is listed when FLINTRAIL_OP is set', async () => {
  const { tools } = await mcp.client.listTools();
  assert.ok(tools.some((t) => t.name === 'fl_login'));
});

test('signs in from 1Password and never returns the password', async () => {
  const snap = await mcp.call('fl_open', { url: `${site.url}/login` });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  const out = await mcp.call('fl_login', { tab });
  assert.match(out, /filled username, password, one-time code, submitted/);
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

test('refuses an item whose website does not match the page', async () => {
  const snap = await mcp.call('fl_open', { url: `${site.url}/login` });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  await assert.rejects(mcp.call('fl_login', { tab, item: 'Elsewhere' }), /Refused: .*elsewhere\.example/);
  const read = await mcp.call('fl_extract', { tab, js: 'return document.querySelector("[name=email]").value' });
  assert.doesNotMatch(read, /bob@example/);
  await mcp.call('fl_close', { tab });
});

test('a recorded flow stores the item, not the secret, and replays the sign-in', async () => {
  await mcp.call('fl_record_start', { name: 'signin' });
  const snap = await mcp.call('fl_open', { url: `${site.url}/login` });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  await mcp.call('fl_login', { tab });
  await mcp.call('fl_act', { tab, actions: [{ do: 'wait', text: 'Welcome' }] });
  await mcp.call('fl_record_stop', {});
  await mcp.call('fl_close', { tab });

  const flow = await mcp.call('fl_flow', { name: 'signin' });
  assert.match(flow, /"do": "login"/);
  assert.match(flow, /"item": "fixture1"/);
  assert.ok(!flow.includes('S3cret'));

  const run = await mcp.call('fl_run', { name: 'signin' });
  assert.match(run, /^OK "signin"/);
  assert.match(run, /Welcome ann@example.com/);
});
