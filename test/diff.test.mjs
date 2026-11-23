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
  assert.match(viaOldRef, /No change since the last snapshot of this tab in the elements, headings and text it shows \(44 elements, same refs\)/);
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

test('a change a list of differences cannot tell is never reported as no change', async () => {
  const first = await mcp.call('fl_open', { url: site.url + '/sorted', text: 0 });
  const tab = tabOf(first);
  // Same elements, other order: the whole page, in its new order.
  const sorted = await click(tab, '#sort', { text: 0 });
  assert.doesNotMatch(sorted, /No change|Changes since/);
  assert.ok(sorted.indexOf('"Cherry"') < sorted.indexOf('"Apple"'), 'the new order is shown');

  // A heading that goes away is told, with or without the page text.
  const dismissed = await click(tab, '#dismiss', { text: 0 });
  assert.doesNotMatch(dismissed, /No change/);
  assert.ok(/^- # Error: card declined$/m.test(dismissed) || !/Error: card declined/.test(dismissed), 'gone, or the whole page without it');
  await mcp.call('fl_close', { tab });

  // Text that goes away is named.
  const tab2 = tabOf(await mcp.call('fl_open', { url: site.url + '/sorted' }));
  const cleared = await click(tab2, '#clear');
  assert.doesNotMatch(cleared, /No change/);
  assert.ok(/Text, words gone: Payment refused by the bank/.test(cleared) || (/Title: Sorted/.test(cleared) && !/Payment refused/.test(cleared)));
  await mcp.call('fl_close', { tab: tab2 });
});

test('a very long page text is compared without stalling', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/board', text: 200000 }));
  await mcp.call('fl_act', { tab, snapshot: false, actions: [{ do: 'eval', js: 'const p = document.createElement("p"); p.id = "long"; p.textContent = Array.from({ length: 30000 }, (_, i) => "w" + (i % 977)).join(" "); document.body.appendChild(p); return 1' }] });
  await mcp.call('fl_snapshot', { tab, text: 200000 });
  const t0 = Date.now();
  await mcp.call('fl_act', { tab, text: 200000, actions: [{ do: 'eval', js: 'const p = document.getElementById("long"); p.textContent = p.textContent.split(" ").reverse().join(" "); return 1' }] });
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  await mcp.call('fl_close', { tab });
});
