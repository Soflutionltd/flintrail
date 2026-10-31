import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { act, adoptTab, closeTab, consoleLog, domQuiet, elementByRef, getTab, listTabs, openTab, snapshot, type Action, type Step } from './engine.js';
import { runFlow, runMany } from './flows.js';
import { actDesktop, listApps, snapshotApp, type DesktopAction } from './desktop.js';
import { redact, signIn } from './login.js';
import { recorder } from './recorder.js';
import { config } from './config.js';
import { getRelay } from './relay.js';
import { listFlows, loadFlow, saveFlow } from './store.js';

export const VERSION = '1.3.0';

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

const desktopActionSchema = z.object({
  do: z.enum(['click', 'dblclick', 'rightclick', 'fill', 'type', 'clear', 'press', 'select', 'check', 'uncheck', 'toggle', 'expand', 'collapse', 'focus', 'scroll', 'get', 'wait', 'launch', 'quit'])
    .describe('fill: set the whole value of a field. type: insert text. press: key combo like return, escape, cmd+s (to the app\'s window, focused on ref if given). get: read the text of ref (text "value" reads its value). wait: ms, or until text appears. launch / quit: the app.'),
  ref: z.string().optional().describe('Element ref from the latest fl_desktop snapshot of this app, e.g. d12.'),
  role: z.string().optional().describe('Instead of ref: accessibility role (button, textfield, checkbox, menuitem ...).'),
  name: z.string().optional().describe('Instead of ref: exact accessible name, with role.'),
  nativeId: z.string().optional().describe('Instead of ref: native automation id.'),
  app: z.string().optional().describe('Switch to another app from this action on.'),
  value: z.string().optional().describe('Value for fill / type / select.'),
  var: z.string().optional().describe('While recording: store this value as variable {{var}} instead of the literal.'),
  key: z.string().optional().describe('Key combo for press: return, tab, escape, cmd+s, shift+tab ...'),
  text: z.string().optional().describe('wait: text to wait for. get: "value" to read the value instead of the text.'),
  ms: z.number().optional().describe('wait: milliseconds (or timeout when waiting for text).'),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().optional().describe('scroll: units (default 3).'),
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

  if (config.passwordSources.length) s.registerTool('fl_login', {
    description: 'Sign in on the open sign-in form with the user\'s saved password: from the browser\'s own password manager, or from a password manager CLI the user configured (1Password, Bitwarden, custom command). Flintrail fills username, password and one-time code itself; the secrets never reach you. A CLI login is only filled when the page domain matches its website. On a multi-step sign-in (e-mail page, then password page), call it on each step. While recording, the flow stores the source and login ID, never a secret.',
    inputSchema: {
      tab: z.string(),
      item: z.string().optional().describe('Login ID, title or username in a password manager CLI, when several match the site.'),
      source: z.string().optional().describe('Only this source: browser, 1password, bitwarden or command.'),
      submit: z.boolean().optional().describe('Press Enter after filling (default true).'),
      ...snapOpts,
    },
  }, guard(async ({ tab, item, source, submit, text: t, max }) => {
    const page = getTab(tab);
    const r = await signIn(page, { item, source, submit });
    recorder.addStep(page, { do: 'login', source: r.source, ...(r.item ? { item: r.item } : {}), ...(submit === false ? { submit } : {}) } as Step);
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

  s.registerTool('fl_desktop', {
    description: 'Snapshot a native desktop app (Finder, Mail, Preview, Notes, any app) through the OS accessibility tree: its elements with [dN] refs for fl_desktop_act. No pixels, no pointer move, no window raised. Without app, lists the running apps. The app name can be localized ("Calculatrice"), English ("Calculator") or a bundle id.',
    inputSchema: {
      app: z.string().optional(),
      window: z.string().optional().describe('Window id when the app has several windows (the error lists them).'),
      all: z.boolean().optional().describe('Include static text, not only interactive elements (default false).'),
      root: z.string().optional().describe('Snapshot only the subtree of this ref, for dense apps.'),
      skeleton: z.boolean().optional().describe('Shallow overview of a dense app, then drill down with root.'),
      surface: z.string().optional().describe('menubar, menu, sheet, popover, alert, dock ... instead of the window.'),
      max: z.number().optional().describe('Max elements listed (default 150).'),
    },
  }, guard(async ({ app, window, all, root, skeleton, surface, max }) =>
    app ? snapshotApp(app, { window, interactive: !all, root, skeleton, surface, max }) : listApps()));

  s.registerTool('fl_desktop_act', {
    description: 'Run SEVERAL actions on a native desktop app in one call, then get a fresh snapshot of it. Target elements by ref from fl_desktop, or by role + name. Headless: the user keeps working in the foreground. Recorded by fl_record_start like browser actions, so a flow can mix web and desktop steps and replay them without an LLM.',
    inputSchema: {
      app: z.string(),
      actions: z.array(desktopActionSchema).min(1),
      snapshot: z.boolean().optional(),
      all: z.boolean().optional().describe('Snapshot with static text too.'),
      max: z.number().optional(),
    },
  }, guard(async ({ app, actions, snapshot: snap, all, max }) =>
    actDesktop(app, actions as DesktopAction[], { snapshot: snap, interactive: !all, max, record: (st) => recorder.addDesktopStep(st) })));

  s.registerTool('fl_record_start', {
    description: 'Start recording a flow. Every fl_open / fl_act / fl_desktop_act after this is captured with robust element fingerprints so fl_run can replay it without an LLM. repairFrom keeps steps before that index and replaces the rest.',
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
    if (st.do === 'desktop' && st.desktop) {
      if (st.desktop.value === undefined) throw new Error(`Step ${step} (desktop ${st.desktop.do}) has no value to parametrize.`);
      const was = st.desktop.value;
      st.desktop.value = `{{${v}}}`;
      f.vars = [...new Set([...f.vars, v])];
      f.updatedAt = new Date().toISOString();
      saveFlow(f);
      return `Step ${step} of "${name}" now uses {{${v}}} (recorded value was "${was}").`;
    }
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
