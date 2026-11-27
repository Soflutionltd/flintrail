// Waits, a target closest to a text, and the part of the page a snapshot lists (an open dialog, a row).
import { test, before, after } from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.mjs';
import { connect, refOf, zipEntries } from './helpers.mjs';

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

test('drag and drop moves a card to another column, and the recorded flow replays it', async () => {
  await mcp.call('fl_record_start', { name: 'drag-card' });
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/drag' }));
  const moved = await mcp.call('fl_act', { tab, actions: [{ do: 'drag', text: 'Write tests', toSelector: '#done' }], snapshot: false });
  assert.doesNotMatch(moved, /FAILED/);
  assert.match(await mcp.call('fl_extract', { tab, js: 'return card.parentElement.id' }), /"done"/);
  await mcp.call('fl_record_stop', {});
  assert.match(await mcp.call('fl_act', { tab, actions: [{ do: 'drag', text: 'Write tests' }], snapshot: false }), /FAILED drag: drag needs where to drop/);
  await mcp.call('fl_close', { tab });
  const replay = await mcp.call('fl_run', { name: 'drag-card' });
  assert.doesNotMatch(replay, /FAILED|failed/);
});

test('emulation: a phone with touch, another language, time zone, dark mode and offline, then back', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/env' }));
  const env = async () => JSON.parse(JSON.parse(/-> (.*)$/m.exec(await mcp.call('fl_extract', { tab, js: 'return env()' }))[1]));
  const before = await env();
  const said = await mcp.call('fl_emulate', { tab, device: 'iPhone 15', locale: 'fr-FR', timezone: 'Asia/Tokyo', colorScheme: 'dark', offline: true });
  assert.match(said, /Emulating iPhone 15, 393x\d+ with touch, its user agent, language fr-FR, time zone Asia\/Tokyo, dark color scheme, offline/);
  const now = await env();
  assert.equal(now.width, 393);
  assert.ok(now.touch > 0);
  assert.match(now.ua, /iPhone/);
  assert.equal(now.lang, 'fr-FR');
  assert.equal(now.tz, 'Asia/Tokyo');
  assert.equal(now.dark, true);
  assert.equal(now.online, false);
  await assert.rejects(mcp.call('fl_emulate', { tab, device: 'Nokia 3310' }), /Unknown device "Nokia 3310"/);
  await assert.rejects(mcp.call('fl_emulate', { tab }), /Nothing to emulate/);
  assert.match(await mcp.call('fl_emulate', { tab, reset: true }), /Emulation off/);
  const after = await env();
  assert.deepEqual([after.width, after.ua, after.lang, after.tz, after.dark, after.online], [before.width, before.ua, before.lang, before.tz, before.dark, before.online]);
  await mcp.call('fl_close', { tab });
});

test('a page saved as a PDF file', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/rows' }));
  const out = await mcp.call('fl_pdf', { tab, name: 'tokens-list', landscape: true });
  const file = /PDF saved: (.*\.pdf) \(/.exec(out)[1];
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file).subarray(0, 4).toString(), '%PDF');
  await mcp.call('fl_close', { tab });
});

test('a session saved from the dedicated browser comes back after its cookies are gone, and is never shown', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/rows' }));
  const cookie = 'sid=' + 'k9'.repeat(10);
  await mcp.call('fl_extract', { tab, js: `document.cookie = '${cookie}; path=/'; localStorage.setItem('draft', 'kept'); return 1` });
  const saved = await mcp.call('fl_session', { action: 'save', name: 'fixture-site', site: '127.0.0.1' });
  assert.match(saved, /Saved the session of 127\.0\.0\.1 as "fixture-site" \(1 cookies, 1 storage origins\)/);
  assert.ok(!saved.includes('k9k9'));
  const file = /in (\S+\.json),/.exec(saved)[1];
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await mcp.call('fl_extract', { tab, js: "document.cookie = 'sid=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; localStorage.clear(); return 1" });
  assert.match(await mcp.call('fl_session', { action: 'load', name: 'fixture-site' }), /Loaded the session "fixture-site" of 127\.0\.0\.1 into the dedicated browser \(1 cookies, 1 storage origins\)/);
  await mcp.call('fl_act', { tab, actions: [{ do: 'goto', url: site.url + '/rows' }], snapshot: false });
  const back = await mcp.call('fl_extract', { tab, js: "return [document.cookie.includes('sid='), localStorage.getItem('draft')]" });
  assert.match(back, /\[true,"kept"\]/);
  await assert.rejects(mcp.call('fl_session', { action: 'save', name: '../escape', site: '127.0.0.1' }), /name: letters, digits/);
  // Not replaced without asking, and never a whole public suffix.
  await assert.rejects(mcp.call('fl_session', { action: 'save', name: 'fixture-site', site: '127.0.0.1' }), /already saved: pass replace:true/);
  assert.match(await mcp.call('fl_session', { action: 'save', name: 'fixture-site', site: '127.0.0.1', replace: true }), /Saved the session/);
  await assert.rejects(mcp.call('fl_session', { action: 'save', name: 'suffix', site: 'co.uk' }), /not one site/);
  // A session file is never uploaded to a site.
  await mcp.call('fl_act', { tab, actions: [{ do: 'goto', url: site.url + '/upload' }], snapshot: false });
  assert.match(await mcp.call('fl_act', { tab, actions: [{ do: 'upload', selector: 'input[type=file]', files: [file] }], snapshot: false }), /FAILED upload: Refused: .* is one of Rocketwright's own files/);
  await assert.rejects(mcp.call('fl_session', { action: 'load', name: 'never-saved' }), /No saved session "never-saved"/);
  await mcp.call('fl_close', { tab });
});

test('network rules: an API answered, failed, delayed or blocked, counted, and gone after clear', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/stock' }));
  const load = async () => {
    await mcp.call('fl_act', { tab, actions: [{ do: 'click', selector: '#load' }, { do: 'wait', network: true, ms: 8000 }], snapshot: false });
    return text(tab);
  };
  assert.match(await load(), /-> "200 \{\\"left\\":12\}/);
  assert.match(await mcp.call('fl_mock', { tab, action: 'respond', url: '/api/stock', status: 503, body: '{"error":"down"}', times: 1 }),
    /Rule #\d+ \/api\/stock -> answer 503 \(16 bytes\), caught 0, 1 use\(s\) left/);
  assert.match(await load(), /-> "503 \{\\"error\\":\\"down\\"\}/);
  // Used once: the real API answers again.
  assert.match(await load(), /-> "200 \{\\"left\\":12\}/);
  await mcp.call('fl_mock', { tab, action: 'fail', url: '\\/api\\/st.ck$', regex: true, method: 'GET' });
  assert.match(await load(), /network error/);
  assert.match(await mcp.call('fl_mock', { tab, action: 'list' }), /GET \/\\\/api\\\/st\.ck\$\/ -> fail \(network error\), caught 1/);
  assert.match(await mcp.call('fl_mock', { tab, action: 'clear' }), /2 network rule\(s\) removed/);
  await mcp.call('fl_mock', { tab, action: 'delay', url: '/api/stock', ms: 1200 });
  const slow = /in (\d+) ms/.exec(await load());
  assert.ok(slow && Number(slow[1]) >= 1100, `delayed: ${slow?.[1]}`);
  await mcp.call('fl_mock', { tab, action: 'clear' });
  await mcp.call('fl_mock', { tab, action: 'block', url: '/api/stock' });
  assert.match(await load(), /network error/);
  await assert.rejects(mcp.call('fl_mock', { tab, action: 'respond', url: '/x', headers: { 'Set-Cookie': 'a=b' } }), /Set-Cookie is refused/);
  await assert.rejects(mcp.call('fl_mock', { tab, action: 'respond', url: '/x', headers: { 'Clear-Site-Data': '"cookies"' } }), /Clear-Site-Data is refused/);
  await assert.rejects(mcp.call('fl_mock', { tab, action: 'block', url: 'a'.repeat(201), regex: true }), /200 characters at most/);
  await assert.rejects(mcp.call('fl_mock', { tab, action: 'delay', url: '/x' }), /delay needs ms/);
  await assert.rejects(mcp.call('fl_mock', { tab, action: 'block' }), /url is needed/);
  // Closing the tab takes its rules with it: a new tab gets the real API.
  await mcp.call('fl_close', { tab });
  const fresh = tabOf(await mcp.call('fl_open', { url: site.url + '/stock' }));
  await mcp.call('fl_act', { tab: fresh, actions: [{ do: 'click', selector: '#load' }, { do: 'wait', network: true, ms: 8000 }], snapshot: false });
  assert.match(await text(fresh), /-> "200/);
  await mcp.call('fl_close', { tab: fresh });
});

test('any network rule counts as the agent\'s own script: no sign-in is filled in that tab afterwards', async () => {
  // A blocked script changes what a sign-in form does just as a fake answer does.
  for (const rule of [{ action: 'respond', url: '/api/stock', body: '<script>1</script>', contentType: 'text/html' }, { action: 'block', url: '.js' }]) {
    const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/stock' }));
    await mcp.call('fl_mock', { tab, ...rule });
    await assert.rejects(mcp.call('fl_login', { tab, reopen: false }), /Refused: you ran JavaScript in this tab/);
    await mcp.call('fl_close', { tab });
  }
});

test('a trace of the dedicated browser and a video of a tab are saved where the user finds them', async () => {
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/rows' }));
  assert.match(await mcp.call('fl_trace', { tab, action: 'start', name: 'tokens' }), /Trace started for every tab Rocketwright drives in this browser: every action with a picture before and after \(no page copy or network log/);
  // The cookies fl_session reads would be in the trace.
  await assert.rejects(mcp.call('fl_session', { action: 'save', name: 'during-trace', site: '127.0.0.1' }), /Refused while a trace records the dedicated browser/);
  await assert.rejects(mcp.call('fl_trace', { tab, action: 'start' }), /A trace is already running/);
  assert.match(await mcp.call('fl_video', { tab, action: 'start', name: 'tokens' }), /Filming tab: \d+x\d+, each action pointed out on screen/);
  await mcp.call('fl_act', { tab, actions: [{ do: 'click', role: 'button', name: 'Delete', within: 'beta-token' }, { do: 'wait', ms: 600 }], snapshot: false });
  const traced = await mcp.call('fl_trace', { tab, action: 'stop' });
  const zip = /Trace saved: (.*\.zip) \(/.exec(traced)[1];
  assert.match(traced, /npx playwright show-trace/);
  // Actions and pictures, never a copy of the page or its network.
  const files = zipEntries(zip);
  assert.ok(files.get('trace.trace').includes('"type":"before"'));
  assert.ok(!files.get('trace.trace').includes('frame-snapshot'));
  assert.equal(files.get('trace.network').length, 0);
  const filmed = await mcp.call('fl_video', { tab, action: 'stop' });
  const webm = /Video saved: (.*\.webm) \(/.exec(filmed)[1];
  assert.ok(statSync(webm).size > 1000);
  // WebM starts with the EBML magic number.
  assert.equal(readFileSync(webm).subarray(0, 4).toString('hex'), '1a45dfa3');
  await assert.rejects(mcp.call('fl_video', { tab, action: 'stop' }), /No video is being recorded/);
  // A video still running when the tab closes is saved then, and so is a trace when its last tab closes: the tabs
  // earlier tests left open are closed first.
  for (const line of (await mcp.call('fl_tabs', {})).split('\n')) {
    const other = /^(t\d+)/.exec(line)?.[1];
    if (other && other !== tab) await mcp.call('fl_close', { tab: other });
  }
  await mcp.call('fl_video', { tab, action: 'start' });
  await mcp.call('fl_trace', { tab, action: 'start', name: 'until-close' });
  assert.match(await mcp.call('fl_close', { tab }), /Tab t\d+ closed\. Video saved: .*\.webm.* Trace saved: .*until-close.*\.zip/);
});

test('a recorded flow exported as a Playwright Test file, variables from the environment', async () => {
  await mcp.call('fl_record_start', { name: 'export-me', description: 'Delete a token' });
  const tab = tabOf(await mcp.call('fl_open', { url: site.url + '/rows' }));
  await mcp.call('fl_act', { tab, actions: [
    { do: 'click', role: 'button', name: 'Delete', within: 'beta-token' },
    { do: 'goto', url: site.url + '/search' },
  ], snapshot: false });
  const typed = await mcp.call('fl_act', { tab, actions: [{ do: 'fill', selector: 'input[name=q]', value: 'parking', var: 'query' }, { do: 'press', key: 'Enter' }], snapshot: false });
  assert.doesNotMatch(typed, /FAILED/);
  await mcp.call('fl_record_stop', {});
  await mcp.call('fl_close', { tab });
  const spec = await mcp.call('fl_flow_export', { name: 'export-me' });
  assert.match(spec, /^\/\/ Flow "export-me" recorded with Rocketwright/);
  assert.match(spec, /import \{ test \} from '@playwright\/test';/);
  assert.match(spec, /FLOW_QUERY \(\{\{query\}\}\)/);
  assert.match(spec, /await page\.goto\("http:\/\/127\.0\.0\.1:\d+\/rows"\);/);
  assert.match(spec, /\.fill\(v\("\{\{query\}\}"\)\);/);
  assert.match(spec, /function v\(s: string\): string/);
  assert.ok(!spec.includes('parking'), 'the recorded value of a variable stays out of the file');
  await assert.rejects(mcp.call('fl_flow_export', { name: 'no-such-flow' }), /does not exist/);
});
