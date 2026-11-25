// Benchmark of four everyday agent tasks on local copies of the pages (bench/task-site.mjs and the test fixture's
// sign-in): sign in with a password manager and a one-time code, create a GitHub-style fine-grained token, create a
// Cloudflare-style token with three permission rows, and fill a 30-field form.
// Each tool does each task the way that suits it best, scripted the way an agent that already knows the page would
// call it: CSS selectors and one batched form fill for Playwright MCP, one snapshot then one fill_form for Chrome
// DevTools MCP, one batch of actions for Flintrail. We measure tool-side wall time, tool calls (each one is a model
// turn in real use) and whether the page accepted the result. Claude in Chrome cannot be scripted: it is left out.
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixture } from '../test/fixture.mjs';
import { testEnv, cli } from '../test/helpers.mjs';
import { startTaskSite, GH, CF, FORM } from './task-site.mjs';

const RUNS = Number(process.env.RUNS || 5);
const chrome = process.env.FLINTRAIL_CHROME;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fakeOp = new URL('../test/fake-op.mjs', import.meta.url).pathname;
// The password the competitors are given: with them the agent has to know it. Flintrail fills it from the manager.
const PASSWORD = 'S3cret pass&"42';

async function client(command, args, env, kind = '') {
  const c = new Client({ name: 'bench', version: '1' });
  await c.connect(new StdioClientTransport({ command, args, env, stderr: 'ignore' }));
  let calls = 0;
  // Chrome DevTools MCP names the page in every call: its first page.
  const extra = kind === 'devtools' ? { pageId: 1 } : {};
  const call = async (name, a = {}) => {
    calls++;
    const r = await c.callTool({ name, arguments: name === 'list_pages' || name === 'new_page' ? a : { ...extra, ...a } });
    const t = r.content.map((x) => x.text ?? '').join('\n');
    if (r.isError || /### Error/.test(t)) throw new Error(`${name}: ${t.slice(0, 300)}`);
    return t;
  };
  return { c, call, calls: () => calls, reset: () => (calls = 0) };
}

const site = await startFixture();
const tasks = await startTaskSite();
const U = { login: `${site.url}/login`, gh: `${tasks.url}/github-token`, cf: `${tasks.url}/cloudflare-token`, form: `${tasks.url}/form` };

// The fields of each task, with what each tool needs to find them.
const ghFields = [
  { sel: 'input[name=name]', label: 'Token name', role: 'textbox', value: GH.name },
  { sel: 'select[name=expiration]', label: 'Expiration', role: 'combobox', value: GH.expiration, text: '30 days' },
  { sel: 'textarea[name=description]', label: 'Description', role: 'textbox', value: GH.description },
  { sel: 'input[name=access][value=all]', label: 'All repositories', role: 'radio', value: 'true' },
  { sel: 'select[name=perm-contents]', label: 'Contents', role: 'combobox', value: 'read', text: 'Read-only' },
  { sel: 'select[name=perm-metadata]', label: 'Metadata', role: 'combobox', value: 'read', text: 'Read-only' },
  { sel: 'select[name=perm-pulls]', label: 'Pull requests', role: 'combobox', value: 'write', text: 'Read and write' },
];
const cfNames = { workers: 'Workers Scripts', dns: 'DNS', settings: 'Account Settings', account: 'Account', zone: 'Zone', edit: 'Edit', read: 'Read' };
const cfRowFields = CF.rows.flatMap((row, i) => ['scope', 'item', 'level'].map((part, j) => ({
  sel: `select[aria-label="Permission ${i + 1} ${part}"]`, label: `Permission ${i + 1} ${part}`, role: 'combobox', value: row[j], text: cfNames[row[j]],
})));
const cfFields = [
  { sel: '#name', label: 'Token name', role: 'textbox', value: CF.name },
  ...cfRowFields,
  { sel: '#zone', label: 'Zone resources', role: 'combobox', value: CF.zone, text: 'Specific zone: example.com' },
  { sel: '#start', label: 'Start date', role: 'textbox', value: CF.start },
  { sel: '#end', label: 'End date', role: 'textbox', value: CF.end },
];
const formLabels = {
  first: 'First name', last: 'Last name', email: 'Email', phone: 'Phone', birth: 'Date of birth', company: 'Company', title: 'Job title',
  website: 'Website', street: 'Street', street2: 'Address line 2', city: 'City', region: 'State or region', postal: 'Postal code',
  country: 'Country', language: 'Language', timezone: 'Time zone', industry: 'Industry', budget: 'Budget', start: 'Desired start date',
  referral: 'How did you hear about us?', hours: 'Best time to call', linkedin: 'LinkedIn profile', github: 'GitHub username',
  vat: 'VAT number', message: 'Message', notes: 'Notes',
};
const selectText = { country: 'France', language: 'French', timezone: 'Paris', industry: 'Software', budget: '10k to 50k', referral: 'A friend', hours: 'Morning' };
const formFields = [
  ...Object.entries(formLabels).map(([k, label]) => (selectText[k]
    ? { sel: `select[name=${k}]`, label, role: 'combobox', value: FORM[k], text: selectText[k] }
    : { sel: `[name=${k}]`, label, role: 'textbox', value: FORM[k] })),
  { sel: 'input[name=size][value="11-50"]', label: '11 to 50', role: 'radio', value: 'true' },
  { sel: 'input[name=contact][value=email]', label: 'Email', role: 'radio', value: 'true' },
  { sel: 'input[name=newsletter]', label: 'Send me the newsletter', role: 'checkbox', value: 'true' },
  { sel: 'input[name=terms]', label: 'I accept the terms', role: 'checkbox', value: 'true' },
];

// ---- Playwright MCP: CSS selectors, one browser_fill_form per form.
const pwFill = (call, fields) => call('browser_fill_form', { fields: fields.map((f) => ({ name: f.label, element: f.label, target: f.sel, type: f.role, value: f.text ?? f.value })) });
const playwright = {
  label: 'Playwright MCP 0.0.86',
  start: () => client(process.execPath, [new URL('./node_modules/@playwright/mcp/cli.js', import.meta.url).pathname, '--headless', '--isolated', '--no-sandbox', ...(chrome ? ['--executable-path', chrome] : [])]),
  login: async ({ call }) => {
    await call('browser_navigate', { url: U.login });
    await pwFill(call, [
      { label: 'Email', sel: 'input[name=email]', role: 'textbox', value: 'ann@example.com' },
      { label: 'Password', sel: 'input[name=password]', role: 'textbox', value: PASSWORD },
      { label: 'Code', sel: 'input[name=otp]', role: 'textbox', value: '123456' },
    ]);
    await call('browser_click', { element: 'Sign in', target: 'button' });
    return call('browser_wait_for', { text: 'Welcome' });
  },
  gh: async ({ call }) => {
    await call('browser_navigate', { url: U.gh });
    await pwFill(call, ghFields);
    await call('browser_click', { element: 'Generate token', target: '#generate-token' });
    await call('browser_click', { element: 'Generate token (dialog)', target: '#confirm-token' });
    return call('browser_wait_for', { text: 'Token created' });
  },
  cf: async ({ call }) => {
    await call('browser_navigate', { url: U.cf });
    await call('browser_click', { element: '+ Add more', target: '#add' });
    await call('browser_click', { element: '+ Add more', target: '#add' });
    await pwFill(call, cfFields);
    await call('browser_click', { element: 'Continue to summary', target: '#summary' });
    await call('browser_click', { element: 'Create Token', target: '#create' });
    return call('browser_wait_for', { text: 'Token created' });
  },
  form: async ({ call }) => {
    await call('browser_navigate', { url: U.form });
    await pwFill(call, formFields);
    await call('browser_click', { element: 'Send request', target: 'button' });
    return call('browser_wait_for', { text: 'request received' });
  },
};

// ---- Chrome DevTools MCP: one snapshot to get the uids, then fill_form and clicks by uid.
const uidOf = (snap, role, name, last = false) => {
  const re = new RegExp(`uid=(\\S+) ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
  const all = [...snap.matchAll(re)].map((m) => m[1]);
  if (!all.length) throw new Error(`no ${role} "${name}" in the snapshot`);
  return last ? all.at(-1) : all[0];
};
// Date fields show as "Date" in its snapshot, not "textbox".
const dtRole = (f) => (/^\d{4}-\d{2}-\d{2}$/.test(String(f.value)) ? 'Date' : f.role);
const dtFill = (call, snap, fields) => call('fill_form', { elements: fields.map((f) => ({ uid: uidOf(snap, dtRole(f), f.label), value: f.text ?? f.value })) });
const dtDone = async (call, text) => {
  for (let i = 0; i < 10; i++) {
    const s = await call('take_snapshot');
    if (s.includes(text)) return s;
  }
  throw new Error(`"${text}" never showed`);
};
const devtools = {
  label: 'Chrome DevTools MCP 1.14.0',
  start: () => client(process.execPath, [new URL('./node_modules/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js', import.meta.url).pathname,
    '--headless', '--isolated', '--no-usage-statistics', '--no-performance-crux', ...(chrome ? ['--executable-path', chrome] : [])], undefined, 'devtools'),
  login: async ({ call }) => {
    await call('navigate_page', { type: 'url', url: U.login });
    const s = await call('take_snapshot');
    await dtFill(call, s, [
      { label: 'Email', role: 'textbox', value: 'ann@example.com' },
      { label: 'Password', role: 'textbox', value: PASSWORD },
      { label: 'Code', role: 'textbox', value: '123456' },
    ]);
    await call('click', { uid: uidOf(s, 'button', 'Sign in') });
    return dtDone(call, 'Welcome');
  },
  gh: async ({ call }) => {
    await call('navigate_page', { type: 'url', url: U.gh });
    const s = await call('take_snapshot');
    await dtFill(call, s, ghFields);
    await call('click', { uid: uidOf(s, 'button', 'Generate token') });
    const d = await call('take_snapshot');
    await call('click', { uid: uidOf(d, 'button', 'Generate token', true) });
    return dtDone(call, 'Token created');
  },
  cf: async ({ call }) => {
    await call('navigate_page', { type: 'url', url: U.cf });
    const first = await call('take_snapshot');
    await call('click', { uid: uidOf(first, 'button', '+ Add more') });
    await call('click', { uid: uidOf(first, 'button', '+ Add more') });
    const s = await call('take_snapshot');
    // Choosing "Zone" changes the list next to it: a new snapshot once the scopes are set.
    const scopes = cfFields.filter((f) => / scope$/.test(f.label));
    await dtFill(call, s, scopes);
    const s2 = await call('take_snapshot');
    await dtFill(call, s2, cfFields.filter((f) => !scopes.includes(f)));
    await call('click', { uid: uidOf(s2, 'button', 'Continue to summary') });
    const r = await call('take_snapshot');
    await call('click', { uid: uidOf(r, 'button', 'Create Token') });
    return dtDone(call, 'Token created');
  },
  form: async ({ call }) => {
    await call('navigate_page', { type: 'url', url: U.form });
    const s = await call('take_snapshot');
    await dtFill(call, s, formFields);
    await call('click', { uid: uidOf(s, 'button', 'Send request') });
    return dtDone(call, 'request received');
  },
};

// ---- Flintrail: one batch of actions per task, the password and code filled from the password manager.
const flSteps = (fields) => fields.map((f) => (f.role === 'combobox' ? { do: 'select', selector: f.sel, value: f.value }
  : f.role === 'radio' || f.role === 'checkbox' ? { do: 'check', selector: f.sel } : { do: 'fill', selector: f.sel, value: f.value }));
const flRun = async (call, url, actions) => {
  const tab = /Tab (t\d+)/.exec(await call('fl_open', { url, text: 0 }))[1];
  const out = await call('fl_act', { tab, actions, snapshot: false });
  await call('fl_close', { tab });
  if (/FAILED/.test(out)) throw new Error(out.slice(0, 300));
  return out;
};
const flintrail = {
  label: 'Flintrail',
  start: () => client(process.execPath, [cli], testEnv({ FLINTRAIL_PASSWORDS: `1password:${fakeOp}` })),
  login: async ({ call }) => {
    const tab = /Tab (t\d+)/.exec(await call('fl_open', { url: U.login, text: 0 }))[1];
    await call('fl_login', { tab });
    const out = await call('fl_act', { tab, actions: [{ do: 'wait', text: 'Welcome' }], snapshot: false });
    await call('fl_close', { tab });
    if (/FAILED/.test(out)) throw new Error(out.slice(0, 300));
    return 'Welcome';
  },
  gh: async ({ call }) => flRun(call, U.gh, [...flSteps(ghFields), { do: 'click', selector: '#generate-token' }, { do: 'click', selector: '#confirm-token' }, { do: 'wait', text: 'Token created' }]),
  cf: async ({ call }) => flRun(call, U.cf, [{ do: 'click', selector: '#add' }, { do: 'click', selector: '#add' }, ...flSteps(cfFields),
    { do: 'click', selector: '#summary' }, { do: 'click', selector: '#create' }, { do: 'wait', text: 'Token created' }]),
  form: async ({ call }) => flRun(call, U.form, [...flSteps(formFields), { do: 'click', selector: 'button' }, { do: 'wait', text: 'request received' }]),
};

const TASKS = [['login', 'Sign in (password manager + code)'], ['gh', 'GitHub-style token'], ['cf', 'Cloudflare-style token'], ['form', '30-field form']];
const results = [];
for (const tool of [playwright, devtools, flintrail]) {
  const ctx = await tool.start();
  for (const [key, name] of TASKS) {
    try { await tool[key](ctx); } catch { /* warm-up: browser start, first page */ }
    const times = [];
    let ok = 0;
    let calls = 0;
    let error = '';
    for (let i = 0; i < RUNS; i++) {
      ctx.reset();
      const t0 = performance.now();
      try {
        await tool[key](ctx);
        ok++;
        times.push(performance.now() - t0);
      } catch (e) {
        error = e.message.slice(0, 200);
      }
      calls = Math.max(calls, ctx.calls());
    }
    const r = { tool: tool.label, task: name, medianMs: times.length ? Math.round(median(times)) : null, calls, success: `${ok}/${RUNS}`, ...(error ? { error } : {}) };
    console.log(`${tool.label.padEnd(28)} ${name.padEnd(34)} ${String(r.medianMs ?? '-').padStart(6)} ms  ${String(calls).padStart(2)} calls  ${r.success}${error ? `  (${error})` : ''}`);
    results.push(r);
  }
  await ctx.c.close();
}

site.server.close();
tasks.server.close();
writeFileSync(new URL('./tasks-results.json', import.meta.url), JSON.stringify({ runs: RUNS, date: new Date().toISOString(), node: process.version, results }, null, 2));
process.exit(0);
