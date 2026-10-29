import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { act, adoptTab, closeTab, consoleLog, domQuiet, elementByRef, getTab, listTabs, openTab, snapshot, type Action, type Step } from './engine.js';
import { runFlow, runMany } from './flows.js';
import { redact, signIn } from './login.js';
import { recorder } from './recorder.js';
import { config } from './config.js';
import { getRelay } from './relay.js';
import { listFlows, loadFlow, saveFlow } from './store.js';

export const VERSION = '1.2.0';

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const guard = <A>(fn: (a: A) => Promise<string>) => async (a: A): Promise<ToolResult> => {
  try {
    return text(redact(await fn(a)));
  } catch (e) {
    return { ...text(redact(`Error: ${(e as Error).message.split('\n')[0]}`)), isError: true };
  }
};

const actionSchema = z.object({
  do: z.enum(['click', 'dblclick', 'hover', 'fill', 'type', 'select', 'check', 'uncheck', 'press', 'download', 'upload', 'goto', 'back', 'wait', 'scroll', 'eval', 'request', 'mouse', 'dialog', 'resize'])
    .describe('upload: files into a file input, or a button / drop zone that opens the file chooser. mouse: click at x,y (escape hatch for canvas, shadow DOM, extension overlays). dialog: how to answer the NEXT alert/confirm/prompt (default dismiss). resize: viewport width x height.'),
  ref: z.string().optional().describe('Element ref from the latest snapshot, e.g. e12 or f1:e3. Fastest way to target.'),
  selector: z.string().optional().describe('CSS or Playwright selector.'),
  role: z.string().optional(), name: z.string().optional(),
  text: z.string().optional(), label: z.string().optional(), placeholder: z.string().optional(), exact: z.boolean().optional(),
  value: z.string().optional().describe('Value for fill / type / select.'),
  var: z.string().optional().describe('While recording: store this value as variable {{var}} instead of the literal.'),
  key: z.string().optional().describe('Key for press, e.g. Enter, Tab, Escape.'),
  url: z.string().optional().describe('URL for goto / request, or a regex for wait.'),
  ms: z.number().optional(),
  x: z.number().optional().describe('mouse: x in CSS pixels of the viewport, same scale as fl_screenshot.'),
  y: z.number().optional().describe('mouse: y in CSS pixels. scroll: pixels to scroll (default 800).'),
  count: z.number().int().optional().describe('mouse: 2 for a double click.'),
  width: z.number().int().optional(), height: z.number().int().optional(),
  accept: z.boolean().optional().describe('dialog: true to accept (OK), false to dismiss. value is the prompt answer.'),
  files: z.array(z.string()).optional().describe('upload: absolute file paths. With var, a single file becomes {{var}}.'),
  js: z.string().optional().describe('Function body for eval, must return a value.'),
  method: z.string().optional(), body: z.string().optional(), headers: z.record(z.string(), z.string()).optional(),
});

const snapOpts = {
  text: z.number().optional().describe('Characters of page text to include (default 600, 0 for none).'),
  max: z.number().optional().describe('Max interactive elements listed (default 150).'),
};

export function buildServer(): McpServer {
  const s = new McpServer({ name: 'flintrail', version: VERSION });

  s.registerTool('fl_open', {
    description: 'Open a URL in a background tab of the dedicated browser (logged-in sessions kept). Returns a compact snapshot whose [eN] refs can be used directly in fl_act.',
    inputSchema: { url: z.string(), ...snapOpts },
  }, guard(async ({ url, text: t, max }) => {
    const id = await openTab(url);
    return `Tab ${id}\n` + (await snapshot(getTab(id), { text: t, max }));
  }));

  s.registerTool('fl_adopt', {
    description: 'Take control of a tab the user already has open in the browser (first match on a URL substring), e.g. a site they just signed in to by hand. Returns its snapshot.',
    inputSchema: { url: z.string().describe('Substring of the tab URL'), ...snapOpts },
  }, guard(async ({ url, text: t, max }) => {
    const id = await adoptTab(url);
    return `Tab ${id}\n` + (await snapshot(getTab(id), { text: t, max }));
  }));

  s.registerTool('fl_act', {
    description: 'Run SEVERAL actions in one call (fill a whole form, click, submit, wait, extract) and get one fresh snapshot back. Always batch as many actions as possible: one call beats ten.',
    inputSchema: { tab: z.string(), actions: z.array(actionSchema).min(1), snapshot: z.boolean().optional(), ...snapOpts },
  }, guard(async ({ tab, actions, snapshot: snap, text: t, max }) => act(getTab(tab), actions as Action[], { snapshot: snap, text: t, max })));

  if (config.opClis.length) s.registerTool('fl_login', {
    description: 'Sign in on the open sign-in form with a 1Password item: Flintrail fills username, password and one-time code itself, the secrets never reach you. Refuses when the page domain does not match the item website. On a multi-step sign-in (e-mail page, then password page), call it on each step. Without item, uses the only Login whose website matches the tab. While recording, the flow stores the item ID, never the secret.',
    inputSchema: {
      tab: z.string(),
      item: z.string().optional().describe('1Password item ID or exact title, when several items match the site.'),
      submit: z.boolean().optional().describe('Press Enter after filling (default true).'),
      ...snapOpts,
    },
  }, guard(async ({ tab, item, submit, text: t, max }) => {
    const page = getTab(tab);
    const r = await signIn(page, { item, submit });
    recorder.addStep(page, { do: 'login', item: r.item, ...(submit === false ? { submit } : {}) } as Step);
    await domQuiet(page);
    return `${r.text}\n\n${await snapshot(page, { text: t, max })}`;
  }));

  s.registerTool('fl_snapshot', {
    description: 'Re-read a tab: interactive elements with refs, headings and the start of the text.',
    inputSchema: { tab: z.string(), ...snapOpts },
  }, guard(async ({ tab, text: t, max }) => snapshot(getTab(tab), { text: t, max })));

  s.registerTool('fl_extract', {
    description: 'Run JavaScript in the page and return the result. Fastest way to pull tables, lists or links.',
    inputSchema: { tab: z.string(), js: z.string().describe('Function body with return, e.g. return [...document.querySelectorAll("tr")].map(r => r.innerText)') },
  }, guard(async ({ tab, js }) => act(getTab(tab), [{ do: 'eval', js }], { snapshot: false })));

  s.registerTool('fl_network', {
    description: 'List the API calls (fetch/XHR) the site made, with method, status, timing, body and a JSON sample. Use it to replace UI clicks with a direct {do:"request"} step: the fastest possible replay.',
    inputSchema: { filter: z.string().optional().describe('Substring the URL must contain.'), limit: z.number().optional() },
  }, guard(async ({ filter, limit }) => recorder.apiCalls(filter, limit)));

  s.registerTool('fl_console', {
    description: 'Console errors and uncaught exceptions of a tab (level "all" adds warnings and logs). fl_act and fl_snapshot already say when new errors appeared.',
    inputSchema: { tab: z.string(), level: z.enum(['errors', 'all']).optional(), clear: z.boolean().optional() },
  }, guard(async ({ tab, level, clear }) => consoleLog(getTab(tab), level, !!clear)));

  s.registerTool('fl_screenshot', {
    description: 'Screenshot of a tab, or of one element with ref / selector. Only when the visual layout matters: snapshots are much cheaper. Pixels are CSS pixels, usable as x / y for {do:"mouse"}.',
    inputSchema: { tab: z.string(), full: z.boolean().optional(), ref: z.string().optional(), selector: z.string().optional() },
  }, async ({ tab, full, ref, selector }): Promise<ToolResult> => {
    try {
      const page = getTab(tab);
      const opts = { type: 'jpeg' as const, quality: 55, scale: 'css' as const };
      const target = ref ? elementByRef(page, ref) : selector ? page.locator(selector).first() : null;
      const buf = target ? await target.screenshot({ ...opts, timeout: 8000 }) : await page.screenshot({ ...opts, fullPage: !!full });
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }] };
    } catch (e) {
      return { ...text(redact(`Error: ${(e as Error).message}`)), isError: true };
    }
  });

  s.registerTool('fl_tabs', { description: 'List tabs opened by Flintrail.', inputSchema: {} },
    guard(async () => listTabs().join('\n') || 'No tabs.'));

  s.registerTool('fl_close', { description: 'Close a Flintrail tab.', inputSchema: { tab: z.string() } },
    guard(async ({ tab }) => { await closeTab(tab); return `Tab ${tab} closed.`; }));

  s.registerTool('fl_record_start', {
    description: 'Start recording a flow. Every fl_open / fl_act after this is captured with robust element fingerprints so fl_run can replay it without an LLM. repairFrom keeps steps before that index and replaces the rest.',
    inputSchema: { name: z.string(), description: z.string().optional(), startUrl: z.string().optional(), repairFrom: z.number().optional() },
  }, guard(async ({ name, description, startUrl, repairFrom }) => recorder.start(name, description, startUrl, repairFrom)));

  s.registerTool('fl_record_stop', {
    description: 'Stop recording and save the flow (save=false to discard).',
    inputSchema: { save: z.boolean().optional() },
  }, guard(async ({ save }) => recorder.stop(save !== false)));

  s.registerTool('fl_run', {
    description: 'Replay a recorded flow at browser speed, no LLM. On failure (site changed) it stops at the failing step and returns the page so the flow can be repaired.',
    inputSchema: { name: z.string(), vars: z.record(z.string(), z.string()).optional(), tab: z.string().optional() },
  }, guard(async ({ name, vars, tab }) => (await runFlow(name, vars || {}, tab)).text));

  s.registerTool('fl_run_many', {
    description: 'Replay the same flow for many variable sets in parallel, each in its own background tab.',
    inputSchema: { name: z.string(), runs: z.array(z.record(z.string(), z.string())).min(1), concurrency: z.number().optional(), keepTabs: z.boolean().optional() },
  }, guard(async ({ name, runs, concurrency, keepTabs }) => runMany(name, runs, concurrency ?? 4, !!keepTabs)));

  s.registerTool('fl_flows', { description: 'List recorded flows with their variables and last timing.', inputSchema: {} },
    guard(async () => listFlows()
      .map((f) => `${f.name}: ${f.steps.length} steps, vars [${f.vars.join(', ')}], ${f.runs} runs${f.lastMs ? `, last ${f.lastMs} ms` : ''}. ${f.description}`)
      .join('\n') || 'No flows yet.'));

  s.registerTool('fl_flow', { description: 'Show a flow with all its steps and element fingerprints.', inputSchema: { name: z.string() } },
    guard(async ({ name }) => JSON.stringify(loadFlow(name), null, 1)));

  s.registerTool('fl_flow_set_var', {
    description: 'Turn the literal value of one step into a variable {{var}}, e.g. after recording by demonstration.',
    inputSchema: { name: z.string(), step: z.number().describe('Step index, as shown by fl_flow (0-based).'), var: z.string().regex(/^\w+$/) },
  }, guard(async ({ name, step, var: v }) => {
    const f = loadFlow(name);
    const st = f.steps[step];
    if (!st) throw new Error(`Flow "${name}" has no step ${step}.`);
    if (st.files) {
      if (st.files.length !== 1) throw new Error(`Step ${step} uploads ${st.files.length} files, a file variable needs exactly one.`);
    } else if (st.value === undefined && st.url === undefined) throw new Error(`Step ${step} (${st.do}) has no value to parametrize.`);
    const was = st.files?.[0] ?? st.value ?? st.url;
    if (st.files) st.files = [`{{${v}}}`];
    else if (st.value !== undefined) st.value = `{{${v}}}`; else st.url = `{{${v}}}`;
    f.vars = [...new Set([...f.vars, v])];
    f.updatedAt = new Date().toISOString();
    saveFlow(f);
    return `Step ${step} of "${name}" now uses {{${v}}} (recorded value was "${was}").`;
  }));

  s.registerTool('fl_extension', { description: 'Status of the Flintrail browser extension (extension mode).', inputSchema: {} },
    guard(async () => {
      if (config.mode !== 'extension') return `Mode is "${config.mode}". Set FLINTRAIL_MODE=extension to drive the browser through the extension.`;
      const r = getRelay();
      if (!r) return `Relay not running (port ${config.relayPort} owned by another Flintrail process?).`;
      return r.connected
        ? `Extension connected: ${r.info.browser || 'browser'} ${r.info.version || ''}. Recording: ${recorder.status() || 'none'}.`
        : `Relay listening on 127.0.0.1:${config.relayPort}, extension not connected. Token: ${config.home}/token.`;
    }));

  return s;
}
