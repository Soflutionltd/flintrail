// Waits, a target closest to a text, and the part of the page a snapshot lists (an open dialog, a row).
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
const text = (tab) => mcp.call('fl_extract', { tab, js: 'return document.getElementById("out").textContent' });

test('within picks the match closest to a text: the Delete button of that row, not the one below', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/rows' }));
  await mcp.call('fl_act', { tab, actions: [{ do: 'click', role: 'button', name: 'Delete', within: 'beta-token' }], snapshot: false });
  assert.match(await text(tab), /deleted beta-token/);
  assert.doesNotMatch(await mcp.call('fl_act', { tab, actions: [{ do: 'click', text: 'Delete', exact: true, within: 'alpha' }], snapshot: false }), /FAILED/);
  assert.match(await text(tab), /deleted alpha-token/);
  // A text both rows share: refused rather than a guess.
  assert.match(await mcp.call('fl_act', { tab, actions: [{ do: 'click', role: 'button', name: 'Delete', within: 'Created' }], snapshot: false }), /FAILED click: 2 matches are as close to "Created"/);
  assert.match(await mcp.call('fl_act', { tab, actions: [{ do: 'click', role: 'button', name: 'Delete', within: 'gamma' }], snapshot: false }), /FAILED click: No match near the text "gamma"/);
  assert.match(await mcp.call('fl_act', { tab, actions: [{ do: 'click', ref: 'e1', within: 'alpha' }], snapshot: false }), /a ref is already exact/);
  await mcp.call('fl_close', { tab });
});

test('an open modal dialog is listed by itself, its buttons are clicked without a script, and waits follow the page', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/rows' }));
  const opened = await mcp.call('fl_act', { tab, actions: [{ do: 'click', selector: '#removeAll' }], diff: false });
  assert.match(opened, /Dialog open "Remove all tokens\?": only its elements are listed \(within: "page" lists the whole page\)/);
  assert.match(opened, /button "Cancel"/);
  assert.doesNotMatch(opened, /Remove all"/, 'the page behind the dialog is not listed');
  assert.match(opened, /Text: This cannot be undone/);
  const whole = await mcp.call('fl_snapshot', { tab, within: 'page' });
  assert.match(whole, /button "Remove all"/);
  // Delete inside the dialog, not in the table; then wait for the work to end, not a fixed pause.
  const started = Date.now();
  const done = await mcp.call('fl_act', { tab, actions: [
    { do: 'click', role: 'button', name: 'Delete', within: 'dialog' },
    { do: 'wait', text: 'Working…', state: 'hidden', ms: 5000 },
  ], snapshot: false });
  assert.doesNotMatch(done, /FAILED/);
  assert.match(await text(tab), /all deleted/);
  assert.ok(Date.now() - started < 4000);
  // An element that never goes away: the wait says so.
  assert.match(await mcp.call('fl_act', { tab, actions: [{ do: 'wait', selector: '#removeAll', state: 'hidden', ms: 500 }], snapshot: false }), /FAILED wait/);
  assert.doesNotMatch(await mcp.call('fl_act', { tab, actions: [{ do: 'wait', network: true, ms: 5000 }], snapshot: false }), /FAILED/);
  await mcp.call('fl_close', { tab });
});

test('a snapshot within a text lists only that part of the page', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/rows' }));
  const row = await mcp.call('fl_snapshot', { tab, within: 'beta-token' });
  assert.match(row, /Only the part of the page around "beta-token" is listed \(1 place\)/);
  assert.equal((row.match(/button "Delete"/g) || []).length, 1);
  assert.doesNotMatch(row, /Remove all/);
  const ref = refOf(row, /button "Delete"$/);
  await mcp.call('fl_act', { tab, actions: [{ do: 'click', ref }], snapshot: false });
  assert.match(await text(tab), /deleted beta-token/);
  assert.match(await mcp.call('fl_snapshot', { tab, within: 'nowhere-here' }), /"nowhere-here" is not on the page: nothing listed/);
  await mcp.call('fl_close', { tab });
});
