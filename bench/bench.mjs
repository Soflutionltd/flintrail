// Benchmark: the same 5-step task (fill a plate, tick a box, go to the next page, confirm on a
// client-rendered button that calls an API, wait for the ticket) done five ways.
// We measure tool-side wall time and count the tool calls an agent must make: every call is one
// extra model turn, which in real use costs seconds of LLM latency on top of what is measured here.
import { writeFileSync, mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixture } from '../test/fixture.mjs';
import { testEnv, cli } from '../test/helpers.mjs';

const RUNS = Number(process.env.RUNS || 10);
const chrome = process.env.FLINTRAIL_CHROME;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function client(command, args, env) {
  const c = new Client({ name: 'bench', version: '1' });
  await c.connect(new StdioClientTransport({ command, args, env }));
  let calls = 0;
  const call = async (name, a) => {
    calls++;
    const r = await c.callTool({ name, arguments: a });
    const t = r.content.map((x) => x.text ?? '').join('\n');
    if (r.isError || /### Error/.test(t)) throw new Error(`${name}: ${t.slice(0, 300)}`);
    return t;
  };
  return { c, call, calls: () => calls, reset: () => (calls = 0) };
}

async function measure(label, setup, once) {
  const ctx = await setup();
  await once(ctx); // warm-up (browser start, first navigation)
  const times = [];
  let calls = 0;
  for (let i = 0; i < RUNS; i++) {
    ctx.reset();
    const t0 = performance.now();
    await once(ctx, i);
    times.push(performance.now() - t0);
    calls = ctx.calls();
  }
  await ctx.c.close();
  const r = { label, medianMs: Math.round(median(times)), calls };
  console.log(`${label.padEnd(34)} ${String(r.medianMs).padStart(6)} ms   ${calls} tool calls`);
  return r;
}

const site = await startFixture();
const U = site.url;
const results = [];

// 1. Microsoft Playwright MCP, one action per call, the way agents use it today.
results.push(await measure('Playwright MCP (1 action / call)',
  () => client(process.execPath, [new URL('./node_modules/@playwright/mcp/cli.js', import.meta.url).pathname, '--headless', '--isolated', '--no-sandbox', ...(chrome ? ['--executable-path', chrome] : [])]),
  async ({ call }, i = 0) => {
    await call('browser_navigate', { url: U });
    await call('browser_type', { element: 'Plate', target: 'input[name=plate]', text: `PW-${i}` });
    await call('browser_click', { element: 'Disabled badge', target: 'input[type=checkbox]' });
    await call('browser_click', { element: 'Continue', target: 'button[type=submit]' });
    await call('browser_wait_for', { text: 'Confirm 24h' });
    await call('browser_click', { element: 'Confirm', target: '[data-testid=confirm]' });
    await call('browser_wait_for', { text: 'active' });
  }));

const fl = () => client(process.execPath, [cli], testEnv());

// 2. Flintrail driven the same way: one action per call.
results.push(await measure('Flintrail live (1 action / call)', fl, async ({ call }, i = 0) => {
  const tab = /Tab (t\d+)/.exec(await call('fl_open', { url: U }))[1];
  await call('fl_act', { tab, actions: [{ do: 'fill', selector: 'input[name=plate]', value: `FL-${i}` }] });
  await call('fl_act', { tab, actions: [{ do: 'check', selector: 'input[type=checkbox]' }] });
  await call('fl_act', { tab, actions: [{ do: 'click', selector: 'button[type=submit]' }] });
  await call('fl_act', { tab, actions: [{ do: 'click', selector: '[data-testid=confirm]' }] });
  await call('fl_act', { tab, actions: [{ do: 'wait', text: 'active' }] });
  await call('fl_close', { tab });
}));

// 3. Flintrail batched: the whole task in one fl_act.
results.push(await measure('Flintrail live, batched', fl, async ({ call }, i = 0) => {
  const tab = /Tab (t\d+)/.exec(await call('fl_open', { url: U, text: 0 }))[1];
  await call('fl_act', { tab, actions: [
    { do: 'fill', selector: 'input[name=plate]', value: `FB-${i}` },
    { do: 'check', selector: 'input[type=checkbox]' },
    { do: 'click', selector: 'button[type=submit]' },
    { do: 'click', selector: '[data-testid=confirm]' },
    { do: 'wait', text: 'active' },
  ] });
  await call('fl_close', { tab });
}));

// 4. Flintrail replay of a recorded flow (no LLM needed between steps).
results.push(await measure('Flintrail replay (fl_run)', async () => {
  const ctx = await fl();
  await ctx.call('fl_record_start', { name: 'bench' });
  const tab = /Tab (t\d+)/.exec(await ctx.call('fl_open', { url: U, text: 0 }))[1];
  await ctx.call('fl_act', { tab, actions: [
    { do: 'fill', selector: 'input[name=plate]', value: 'X', var: 'plate' },
    { do: 'check', selector: 'input[type=checkbox]' },
    { do: 'click', selector: 'button[type=submit]' },
    { do: 'click', selector: '[data-testid=confirm]' },
    { do: 'wait', text: 'active' },
  ] });
  await ctx.call('fl_record_stop', {});
  await ctx.call('fl_close', { tab });
  return ctx;
}, async ({ call }, i = 0) => {
  const out = await call('fl_run', { name: 'bench', vars: { plate: `FR-${i}` } });
  const tab = /tab (t\d+)\)/.exec(out)[1];
  await call('fl_close', { tab });
}));

// 5. Flintrail API replay: the recorded API call, no UI at all.
results.push(await measure('Flintrail API replay (fl_run)', async () => {
  const ctx = await fl();
  await ctx.call('fl_record_start', { name: 'bench-api' });
  const tab = /Tab (t\d+)/.exec(await ctx.call('fl_open', { url: U, text: 0 }))[1];
  await ctx.call('fl_act', { tab, snapshot: false, actions: [
    { do: 'request', method: 'POST', url: '/api/order', headers: { 'content-type': 'application/json' }, body: '{"plate":"{{plate}}","zone":"7"}' },
  ] });
  await ctx.call('fl_record_stop', {});
  await ctx.call('fl_close', { tab });
  return ctx;
}, async ({ call }, i = 0) => {
  const out = await call('fl_run', { name: 'bench-api', vars: { plate: `FA-${i}` } });
  const tab = /tab (t\d+)\)/.exec(out)[1];
  await call('fl_close', { tab });
}));

site.server.close();
mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify({ runs: RUNS, date: new Date().toISOString(), node: process.version, results }, null, 2));
process.exit(0);
