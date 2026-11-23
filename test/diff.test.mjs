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
const click = (tab, selector, extra = {}) => mcp.call('fl_act', { tab, actions: [{ do: 'click', selector }], ...extra });

test('after an action on the same page, only what changed comes back', async () => {
  const first = await mcp.call('fl_open', { url: site.url + '/board' });
  const tab = tabOf(first);
  const firstRow = refOf(first, /button "Task 1"$/);
  const lastRow = refOf(first, /button "Task 40"$/);

  const renamed = await click(tab, '#rename');
  assert.match(renamed, /Changes since the last snapshot of this tab/);
  assert.match(renamed, new RegExp(`^~ \\[${firstRow}\\] button "Task renamed"$`, 'm'));
  assert.doesNotMatch(renamed, /Task 2"/);
  assert.match(renamed, /43 other elements unchanged, same refs/);
  assert.ok(renamed.length * 5 < first.length, `a one-line change costs ${renamed.length} characters against ${first.length}`);

  const added = await click(tab, '#add');
  assert.match(added, /^\+ \[e\d+\] button "Task new"$/m);
  assert.match(added, /Text, new words in \[brackets\]: Board \[Added\] Task renamed Task….*40 \[Task new\] Rename first/);
  assert.ok(added.length < 400, `two changes cost ${added.length} characters`);
  assert.doesNotMatch(added, /button "Task renamed"/);

  const dropped = await click(tab, '#drop');
  assert.match(dropped, /^- \[e\d+\] button "Task new"$/m);

  // A ref left out of the difference still works.
  const viaOldRef = await mcp.call('fl_act', { tab, actions: [{ do: 'click', ref: lastRow }] });
  assert.match(viaOldRef, /No change since the last snapshot of this tab \(44 elements, same refs\)/);
  await mcp.call('fl_close', { tab });
});

test('the whole page comes back when a difference would not be shorter, on request, or on another page', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/board' }));
  const replaced = await click(tab, '#reset');
  assert.doesNotMatch(replaced, /Changes since/);
  assert.match(replaced, /Title: Board/);
  assert.match(replaced, /button "Other 39"/);

  const asked = await click(tab, '#rename', { diff: false });
  assert.match(asked, /Title: Board/);
  assert.match(asked, /button "Other 39"/);

  // fl_snapshot is the whole page unless asked otherwise.
  assert.match(await mcp.call('fl_snapshot', { tab }), /button "Other 39"/);
  assert.match(await mcp.call('fl_snapshot', { tab, diff: true }), /No change since the last snapshot/);

  // Other options than last time: the lists cannot be compared.
  assert.match(await click(tab, '#drop', { text: 0 }), /Title: Board/);

  const moved = await mcp.call('fl_act', { tab, actions: [{ do: 'goto', url: site.url + '/dialogs' }] });
  assert.match(moved, /Title: Dialogs/);
  assert.doesNotMatch(moved, /Changes since/);
  await mcp.call('fl_close', { tab });
});

test('a truncated list is never told as a difference', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/board', max: 10 }));
  const out = await click(tab, '#rename', { max: 10 });
  assert.match(out, /list truncated/);
  assert.doesNotMatch(out, /Changes since/);
  await mcp.call('fl_close', { tab });
});
