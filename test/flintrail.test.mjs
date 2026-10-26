import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.mjs';
import { connect, refOf } from './helpers.mjs';

let site, mcp;

before(async () => {
  site = await startFixture();
  mcp = await connect();
});

after(async () => {
  await mcp.client.close();
  site.server.close();
});

test('lists every tool', async () => {
  const { tools } = await mcp.client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['fl_open', 'fl_act', 'fl_snapshot', 'fl_extract', 'fl_network', 'fl_record_start', 'fl_record_stop', 'fl_run', 'fl_run_many', 'fl_flows']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

test('live: batched actions across pages and a client-rendered step', async () => {
  const snap = await mcp.call('fl_open', { url: site.url });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  assert.match(snap, /Parking permit/);
  const out = await mcp.call('fl_act', {
    tab,
    actions: [
      { do: 'fill', ref: refOf(snap, /"AB-123-CD"|Plate/), value: 'GG-777-HH' },
      { do: 'select', ref: refOf(snap, /select/), value: '15' },
      { do: 'check', ref: refOf(snap, /checkbox/) },
      { do: 'click', role: 'button', name: 'Continue' },
      { do: 'click', selector: '[data-testid=confirm]' },
      { do: 'wait', text: 'active' },
    ],
  });
  assert.match(out, /Ticket T\d+ active/);
  await mcp.call('fl_close', { tab });
});

test('record once, replay without an LLM, with variables', async () => {
  await mcp.call('fl_record_start', { name: 'permit', description: 'Buy a 24h permit' });
  const snap = await mcp.call('fl_open', { url: site.url });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  await mcp.call('fl_act', {
    tab,
    actions: [
      { do: 'fill', ref: refOf(snap, /Plate|AB-123/), value: 'AA-111-AA', var: 'plate' },
      { do: 'check', ref: refOf(snap, /checkbox/) },
      { do: 'click', ref: refOf(snap, /"Continue"/) },
      { do: 'click', selector: '[data-testid=confirm]' },
      { do: 'wait', text: 'active' },
    ],
  });
  const saved = await mcp.call('fl_record_stop');
  assert.match(saved, /variables: plate/);
  await mcp.call('fl_close', { tab });

  const before = site.orders.length;
  const run = await mcp.call('fl_run', { name: 'permit', vars: { plate: 'ZZ-999-ZZ' } });
  assert.match(run, /^OK "permit" in \d+ ms/);
  assert.equal(site.orders.length, before + 1);
  assert.equal(site.orders.at(-1).plate, 'ZZ-999-ZZ');
});

test('replay fails cleanly when a variable is missing', async () => {
  await assert.rejects(mcp.call('fl_run', { name: 'permit', vars: {} }), /Missing variables/);
});

test('parallel replay', async () => {
  const before = site.orders.length;
  const out = await mcp.call('fl_run_many', { name: 'permit', runs: [{ plate: 'P1' }, { plate: 'P2' }, { plate: 'P3' }], concurrency: 3 });
  assert.match(out, /^3\/3 succeeded/);
  assert.equal(site.orders.length, before + 3);
});

test('network capture and direct API replay', async () => {
  const calls = await mcp.call('fl_network', { filter: '/api/order' });
  assert.match(calls, /POST 200 .*\/api\/order/);
  const snap = await mcp.call('fl_open', { url: site.url, text: 0 });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  const out = await mcp.call('fl_act', {
    tab, snapshot: false,
    actions: [{ do: 'request', method: 'POST', url: '/api/order', body: '{"plate":"API-1","zone":"7"}', headers: { 'content-type': 'application/json' } }],
  });
  assert.match(out, /"plate":"API-1"/);
  await mcp.call('fl_close', { tab });
});

test('survives an element the site re-creates after typing', async () => {
  const snap = await mcp.call('fl_open', { url: site.url + '/search', text: 0 });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  const ref = refOf(snap, /Search the shop/);
  const out = await mcp.call('fl_act', { tab, actions: [{ do: 'fill', ref, value: 'tickets' }, { do: 'press', ref, key: 'Enter' }] });
  assert.doesNotMatch(out, /FAILED/);
  assert.match(out, /Results for tickets/);
  await mcp.call('fl_close', { tab });
});

test('extract runs JavaScript in the page', async () => {
  const snap = await mcp.call('fl_open', { url: site.url, text: 0 });
  const tab = /Tab (t\d+)/.exec(snap)[1];
  const out = await mcp.call('fl_extract', { tab, js: 'return [...document.querySelectorAll("option")].map(o => o.textContent)' });
  assert.match(out, /\["Paris 7","Paris 15"\]/);
  await mcp.call('fl_close', { tab });
});
