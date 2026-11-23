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

const tabOf = (snap) => /Tab (t\d+)/.exec(snap)[1];

/** Records the permit purchase through the UI. `plate` is { value, var? }, `extra` are actions added at the end. */
async function recordPermit(name, plate, extra = []) {
  await mcp.call('fl_record_start', { name });
  const snap = await mcp.call('fl_open', { url: site.url });
  const tab = tabOf(snap);
  await mcp.call('fl_act', {
    tab,
    actions: [
      { do: 'fill', ref: refOf(snap, /Plate|AB-123/), ...plate },
      { do: 'click', ref: refOf(snap, /"Continue"/) },
      { do: 'click', selector: '[data-testid=confirm]' },
      { do: 'wait', text: 'active' },
      ...extra,
    ],
  });
  const saved = await mcp.call('fl_record_stop');
  await mcp.call('fl_close', { tab });
  return saved;
}

test('a flow that ends on one write request is replayed by sending that request alone', async () => {
  const saved = await recordPermit('direct', { value: 'AA-111-AA', var: 'plate' });
  assert.match(saved, /Direct API call detected: POST \/api\/order\./);
  assert.match(await mcp.call('fl_flows'), /direct: 4 steps.*direct API call POST \/api\/order/);

  const before = site.orders.length;
  // A value with quotes and a backslash: it must land in the JSON body escaped, not break it.
  const plate = 'Z"Z\\9';
  const run = await mcp.call('fl_run', { name: 'direct', vars: { plate }, direct: true });
  assert.match(run, /^OK "direct" in \d+ ms \(direct POST \/api\/order -> 200, UI steps skipped/);
  assert.equal(site.orders.length, before + 1);
  assert.deepEqual({ plate: site.orders.at(-1).plate, zone: site.orders.at(-1).zone }, { plate, zone: '7' });

  // Without direct the same flow still goes through the UI.
  const ui = await mcp.call('fl_run', { name: 'direct', vars: { plate: 'UI-1' } });
  assert.match(ui, /^OK "direct" in \d+ ms \(4 steps/);
  assert.equal(site.orders.at(-1).plate, 'UI-1');

  const many = await mcp.call('fl_run_many', { name: 'direct', runs: [{ plate: 'M1' }, { plate: 'M2' }], direct: true });
  assert.match(many, /^2\/2 succeeded/);
  assert.deepEqual(site.orders.slice(-2).map((o) => o.plate).sort(), ['M1', 'M2']);
});

test('a server error on the direct request stops the run: nothing is replayed through the UI', async () => {
  const before = site.orders.length;
  const run = await mcp.call('fl_run', { name: 'direct', vars: { plate: 'BOOM' }, direct: true });
  assert.match(run, /^FAILED direct POST \/api\/order after \d+ ms: HTTP 500/);
  assert.match(run, /NOT replayed through the UI/);
  assert.equal(site.orders.length, before);
});

test('a direct request answered by a redirect to the sign-in page is not reported as a success', async () => {
  const before = site.orders.length;
  const run = await mcp.call('fl_run', { name: 'direct', vars: { plate: 'EXPIRED' }, direct: true });
  assert.match(run, /^FAILED direct POST \/api\/order after \d+ ms: the site redirected it to .*\/login/);
  assert.equal(site.orders.length, before);
});

/** Records a few actions on one page of the fixture and returns what fl_record_stop said. */
async function record(name, path, actions) {
  await mcp.call('fl_record_start', { name });
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + path, text: 0 }));
  const out = await mcp.call('fl_act', { tab, actions });
  assert.doesNotMatch(out, /FAILED/);
  const saved = await mcp.call('fl_record_stop');
  await mcp.call('fl_close', { tab });
  return saved;
}

test('variables in the path and a number in the body are each sent in their own form', async () => {
  const saved = await record('stock', '/items', [
    { do: 'fill', selector: 'input[name=item]', value: 'bolt m8', var: 'item' },
    { do: 'fill', selector: 'input[name=qty]', value: '12', var: 'qty' },
    { do: 'click', selector: '#save' },
    { do: 'wait', text: 'Stock saved' },
  ]);
  assert.match(saved, /Direct API call detected: PUT \/api\/items\/\{\{item\}\}\?mode=fast/);
  await mcp.call('fl_run', { name: 'stock', vars: { item: 'nut/m10 & co', qty: '40' }, direct: true });
  assert.deepEqual(site.orders.at(-1), { item: 'nut/m10 & co', mode: 'fast', qty: 40, unit: 'box' });
  // The site sent a number: text in its place is refused before anything is sent.
  const before = site.orders.length;
  await assert.rejects(mcp.call('fl_run', { name: 'stock', vars: { item: 'x', qty: 'many' }, direct: true }), /must be a number/);
  assert.equal(site.orders.length, before);
});

test('a form posted by page navigation before the request rules the direct call out', async () => {
  const saved = await record('native', '/native', [
    { do: 'click', role: 'button', name: 'Add to basket' },
    { do: 'click', selector: '#pay' },
    { do: 'wait', text: 'Paid' },
  ]);
  assert.match(saved, /No direct API call kept: the flow also submits a form by page navigation/);
});

test('a request that carries a session token is not stored in the flow', async () => {
  const saved = await record('tokened', '/tokened', [{ do: 'click', selector: '#send' }, { do: 'wait', text: 'Sent' }]);
  assert.match(saved, /No direct API call kept: its request carries a credential or session token \(csrf\)/);
  assert.doesNotMatch(await mcp.call('fl_flow', { name: 'tokened' }), /abc123|"api"/);
});

test('a direct request the site refuses falls back to the UI steps, once', async () => {
  await mcp.call('fl_record_start', { name: 'guarded' });
  const snap = await mcp.call('fl_open', { url: `${site.url}/guarded` });
  const tab = tabOf(snap);
  await mcp.call('fl_act', {
    tab,
    actions: [
      { do: 'fill', selector: 'input[name=plate]', value: 'GU-1', var: 'plate' },
      { do: 'click', selector: '#go' },
      { do: 'wait', text: 'Guarded order done' },
    ],
  });
  assert.match(await mcp.call('fl_record_stop'), /Direct API call detected: POST \/api\/guarded/);
  await mcp.call('fl_close', { tab });

  const before = site.orders.length;
  const run = await mcp.call('fl_run', { name: 'guarded', vars: { plate: 'GU-2' }, direct: true });
  assert.match(run, /^OK "guarded"/);
  assert.match(run, /Direct POST \/api\/guarded refused \(HTTP 403\): replayed through the UI instead\./);
  assert.equal(site.orders.length, before + 1);
  assert.deepEqual(site.orders.at(-1), { plate: 'GU-2', guarded: true });
});

test('no direct call is kept when an action follows the request, and direct is then refused', async () => {
  const saved = await recordPermit('followed', { value: 'FO-1', var: 'plate' }, [{ do: 'click', selector: '#done' }]);
  assert.match(saved, /No direct API call kept: other actions follow the request in the flow\./);
  await assert.rejects(mcp.call('fl_run', { name: 'followed', vars: { plate: 'FO-2' }, direct: true }), /has no direct API call/);
});

test('a value turned into a variable afterwards reaches the direct request too', async () => {
  const saved = await recordPermit('late-var', { value: 'LIT-1' });
  assert.match(saved, /variables: none\.\nDirect API call detected/);
  assert.match(await mcp.call('fl_flow_set_var', { name: 'late-var', step: 0, var: 'plate' }), /The direct API call uses it too\./);
  await mcp.call('fl_run', { name: 'late-var', vars: { plate: 'LATE-2' }, direct: true });
  assert.equal(site.orders.at(-1).plate, 'LATE-2');

  // The recorded value appears twice in the request (plate "7", zone "7"): binding one of them would be
  // a guess, so the direct call is dropped rather than left sending the old value.
  assert.match(await recordPermit('ambiguous', { value: '7' }), /Direct API call detected/);
  assert.match(await mcp.call('fl_flow_set_var', { name: 'ambiguous', step: 0, var: 'plate' }), /The direct API call was removed/);
  assert.equal(JSON.parse(await mcp.call('fl_flow', { name: 'ambiguous' })).api, undefined);
  await assert.rejects(mcp.call('fl_run', { name: 'ambiguous', vars: { plate: 'AM-2' }, direct: true }), /has no direct API call/);
});

test('a flow that types a password never keeps its request', async () => {
  await mcp.call('fl_record_start', { name: 'signin-by-hand' });
  const tab = tabOf(await mcp.call('fl_open', { url: `${site.url}/login?otp=0` }));
  await mcp.call('fl_act', {
    tab,
    actions: [
      { do: 'fill', selector: 'input[name=email]', value: 'ann@example.com' },
      { do: 'fill', selector: 'input[name=password]', value: 'S3cret pass&"42' },
      { do: 'click', role: 'button', name: 'Sign in' },
      { do: 'wait', text: 'Welcome' },
    ],
  });
  const saved = await mcp.call('fl_record_stop');
  await mcp.call('fl_close', { tab });
  assert.match(saved, /No direct API call kept: the flow handles a password\./);
  assert.doesNotMatch(await mcp.call('fl_flow', { name: 'signin-by-hand' }), /S3cret|"api"/);
});

test('what the start page sends while it loads does not count against the direct call', async () => {
  await mcp.call('fl_record_start', { name: 'measured' });
  const snap = await mcp.call('fl_open', { url: site.url + '/measured' });
  const tab = tabOf(snap);
  await mcp.call('fl_act', {
    tab,
    actions: [
      { do: 'fill', ref: refOf(snap, /Plate/), value: 'ME-1', var: 'plate' },
      { do: 'click', selector: '#go' },
      { do: 'wait', text: 'Measured order done' },
    ],
  });
  assert.match(await mcp.call('fl_record_stop'), /Direct API call detected: POST \/api\/order\./);
  await mcp.call('fl_close', { tab });

  const visits = site.visits.count;
  const run = await mcp.call('fl_run', { name: 'measured', vars: { plate: 'ME-2' }, direct: true });
  assert.match(run, /^OK "measured" in \d+ ms \(direct POST \/api\/order -> 200/);
  assert.equal(site.orders.at(-1).plate, 'ME-2');
  // The direct run opens the start page, so the visit is reported exactly as in a UI run.
  assert.equal(site.visits.count, visits + 1);
});

test('a page-load write counts when the direct run would not open the page that sent it', async () => {
  // The start URL given here is not the page opened next: a direct run opens /items and skips /measured.
  await mcp.call('fl_record_start', { name: 'elsewhere', startUrl: site.url + '/items' });
  const snap = await mcp.call('fl_open', { url: site.url + '/measured' });
  const tab = tabOf(snap);
  await mcp.call('fl_act', { tab, actions: [{ do: 'fill', ref: refOf(snap, /Plate/), value: 'EL-1' }, { do: 'click', selector: '#go' }, { do: 'wait', text: 'Measured order done' }] });
  assert.match(await mcp.call('fl_record_stop'), /No direct API call kept: the flow makes 2 write requests/);
  await mcp.call('fl_close', { tab });
  await assert.rejects(mcp.call('fl_run', { name: 'elsewhere', direct: true }), /has no direct API call/);
});

test('a variable in the start URL rules the direct call out', async () => {
  // The page is open before the recording starts, and the start URL is given with a variable.
  const snap = await mcp.call('fl_open', { url: site.url + '/items?c=1' });
  const tab = tabOf(snap);
  await mcp.call('fl_record_start', { name: 'varstart', startUrl: site.url + '/items?c={{c}}' });
  const [item, qty] = snap.split('\n').filter((l) => /text "(Item|Quantity)"/.test(l)).map((l) => /\[([^\]]+)\]/.exec(l)[1]);
  const out = await mcp.call('fl_act', { tab, actions: [{ do: 'fill', ref: item, value: 'bolt' }, { do: 'fill', ref: qty, value: '3' }, { do: 'click', selector: '#save' }, { do: 'wait', text: 'Stock saved' }] });
  assert.doesNotMatch(out, /FAILED/);
  assert.match(await mcp.call('fl_record_stop'), /No direct API call kept: the start URL holds a variable/);
  await mcp.call('fl_close', { tab });
});
