import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserContext } from 'playwright-core';
import { z } from 'zod';
import { act, adoptTab, assertNoSecret, releaseTab, closeTab, consoleLog, domQuiet, drivenIn, elementByRef, getTab, hideForeignFrames, mainFrameSelector, listTabs, openTab, snapshot, tabBrowser, type Action, type Step } from './engine.js';
import { runFlow, runMany } from './flows.js';
import { actDesktop, listApps, snapshotApp, type DesktopAction } from './desktop.js';
import { captureSecret } from './capture.js';
import { pasteSecret } from './paste.js';
import { loadSession, saveSession } from './session.js';
import { emulate, resetEmulation } from './emulate.js';
import { savePdf } from './pdf.js';
import { clearMocks, mock } from './mock.js';
import { endTraceIfIdle, stopVideo, trace, video } from './evidence.js';
import { exportFlow } from './export.js';
import { redact, signIn } from './login.js';
import { recorder } from './recorder.js';
import { config } from './config.js';
import { domainProblem } from './domains.js';
import { getRelayClient } from './relay-client.js';
import { localProfiles, matchProfiles } from './profiles.js';
import { slug } from './relay-protocol.js';
import { bindVariable, describeShortcut } from './api-shortcut.js';
import { listFlows, loadFlow, saveFlow } from './store.js';

import { VERSION } from './version.js';

export { VERSION };

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
  do: z.enum(['click', 'dblclick', 'hover', 'drag', 'fill', 'type', 'select', 'check', 'uncheck', 'press', 'download', 'upload', 'goto', 'back', 'wait', 'scroll', 'eval', 'request', 'mouse', 'dialog', 'resize'])
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
  toRef: z.string().optional().describe('drag: the element to drop on, by ref (or toSelector / toText).'),
  toSelector: z.string().optional(), toText: z.string().optional(),
  within: z.string().optional().describe('With role / text / label / placeholder / selector: the match closest to this text, e.g. {do:"click", role:"button", name:"Delete", within:"my-token"} clicks Delete in the row of my-token. "dialog": the match inside the open dialog.'),
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe('wait with ref / selector / role / label / placeholder / text: until it is visible (default) or hidden (a spinner gone).'),
  network: z.boolean().optional().describe('wait: until the page made no request for half a second.'),
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

const browserOpt = z.string().optional().describe('Which browser: "agent" (dedicated browser, default) or one of the user\'s browsers through the Flintrail extension: a name from fl_extension ("brave-soflution"), a browser profile name ("Soflution") or a brand ("brave", "chrome", "edge").');

const snapOpts = {
  text: z.number().optional().describe('Characters of page text to include (default 400, 0 for none).'),
  max: z.number().optional().describe('Max interactive elements listed (default 100).'),
  within: z.string().optional().describe('List only the part of the page around this text (a row, a card, a section), or "dialog" for the open dialog. An open modal dialog is listed by itself unless within is "page".'),
};

/**
 * Sent to every MCP client at connection (initialize result): the agent reads it before its first
 * browser task, whatever the client (Claude, Cursor, Codex...), with or without a hub in between.
 */
/** The Flintrail extension in the Chrome Web Store: what the agent hands the user to connect their own browser. */
export const EXTENSION_URL = 'https://chromewebstore.google.com/detail/flintrail/amgonogobcfmneginonbkfjlbbnecchp';

export const SERVER_INSTRUCTIONS = [
  'Flintrail drives a dedicated browser ("agent") or the user\'s own browsers through the Flintrail extension.',
  'Before the first browser task of a conversation, call fl_extension to see which user browsers are connected and which profiles are installed but not open.',
  '- Several user browsers connected: ask the user which one to work in (each is named after its profile or the name set in the extension, e.g. "brave-soflution"), unless they already named it. Remember the answer for the rest of the conversation.',
  '- Exactly one connected: use it, and say which one in one line.',
  '- None connected: right away, tell the user to install the Flintrail extension in the browser and profile they use, and give them its link: ' + EXTENSION_URL + ' (Chrome, Edge, Brave, Arc; or Load unpacked from the release zip in <brand>://extensions with Developer mode on). Then they open its popup, check it shows "Connected to Flintrail" with a green dot (otherwise click Connect), and optionally give the browser a name. Until one is connected, a task that needs their sessions (an account they are signed in to) waits for it; any other task runs in the dedicated "agent" browser.',
  'Never switch to another profile of the user than the one agreed, and never sign in for them by typing a password: use fl_login (their password manager) or let them sign in by hand.',
  'Prefer fl_adopt on a tab the user already opened, then fl_open; batch steps in fl_act; read with fl_snapshot rather than screenshots.',
].join('\n');

export function buildServer(): McpServer {
  const s = new McpServer({ name: 'flintrail', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

  s.registerTool('fl_open', {
    description: 'Open a URL in a new tab (logged-in sessions kept). In a user browser, the tab is the one shown in its window, so the user sees it. By default in the dedicated browser; set browser to drive one of the user\'s own browsers instead: a name from fl_extension ("brave-soflution"), the browser profile\'s name ("Soflution"), or a brand ("brave"). A profile of this computer that is not open is opened first. In a user browser, a tab already showing this address, or any tab of the same site, is taken over and brought to the address instead of opening another one. newTab and newWindow are refused while the site is already open there, unless evenIfSiteOpen is set; window picks one of its windows (ids from fl_extension tabs:true). Returns a compact snapshot whose [eN] refs can be used directly in fl_act.',
    inputSchema: {
      url: z.string(), browser: browserOpt,
      window: z.number().int().optional().describe('User browser only: open the tab in this window (id from fl_extension tabs:true).'),
      newWindow: z.boolean().optional().describe('User browser only: open the tab in a new window. Refused while the site is already open in that browser (see evenIfSiteOpen).'),
      newTab: z.boolean().optional().describe('User browser only: open a new tab instead of taking over one. Refused while the site is already open in that browser (see evenIfSiteOpen).'),
      evenIfSiteOpen: z.boolean().optional().describe('User browser only: allow one more tab of a site already open there. Only when two pages of that site have to stay open together, or when the user asked for another tab.'),
      ...snapOpts,
    },
  }, guard(async ({ url, browser, window, newWindow, newTab, evenIfSiteOpen, text: t, max, within }) => {
    const id = await openTab(url, browser, { window, newWindow, evenIfSiteOpen }, !newTab);
    return `Tab ${id} [${tabBrowser(id)}]\n` + (await snapshot(getTab(id), { text: t, max, within }));
  }));

  s.registerTool('fl_adopt', {
    description: 'Take control of a tab the user already has open in the browser (first match on a URL substring), e.g. a site they just signed in to by hand. Returns its snapshot.',
    inputSchema: { url: z.string().min(3).describe('Substring of the tab URL (at least 3 characters), e.g. "github.com/settings"'), browser: browserOpt, ...snapOpts },
  }, guard(async ({ url, browser, text: t, max, within }) => {
    const id = await adoptTab(url, browser);
    return `Tab ${id} [${tabBrowser(id)}]\n` + (await snapshot(getTab(id), { text: t, max, within }));
  }));

  s.registerTool('fl_act', {
    description: 'Run SEVERAL actions in one call (fill a whole form, click, submit, wait, extract) and get one fresh snapshot back. Always batch as many actions as possible: one call beats ten. When the tab stays on the same page, the snapshot only lists what changed since the last one you received (+ new, ~ changed, - gone): every other element is still there with the same ref. Pass diff=false, or call fl_snapshot, for the whole page.',
    inputSchema: { tab: z.string(), actions: z.array(actionSchema).min(1), snapshot: z.boolean().optional(), diff: z.boolean().optional().describe('false: always the whole page (default: only the changes when the page is the same).'), ...snapOpts },
  }, guard(async ({ tab, actions, snapshot: snap, diff, text: t, max, within }) => act(getTab(tab), actions as Action[], { snapshot: snap, diff, text: t, max, within })));

  if (config.passwordSources.length) s.registerTool('fl_login', {
    description: 'Sign in on the open sign-in form with the user\'s saved password: from the browser\'s own password manager, or from a password manager CLI the user configured (1Password, Bitwarden, Dashlane, LastPass, Proton Pass, KeePassXC, custom command). Flintrail fills username, password and one-time code itself; the secrets never reach you. A CLI login is only filled over HTTPS (or on this computer: localhost, *.localhost, a *.test name pointing here), when the page domain matches its website (on a local address, the address with its port must be saved in the login), never in a payment or bank field, and never from a payment card or bank item. In the user\'s own browsers, the Flintrail extension settings (set by the user only) may turn filling off, limit it to some domains, or ask the user to confirm each fill: a refusal is final, do not try another way. On a multi-step sign-in (e-mail page, then password page), call it on each step. While recording, the flow stores the source and login ID, never a secret.',
    inputSchema: {
      tab: z.string(),
      item: z.string().optional().describe('Login ID, title or username in a password manager CLI, when several match the site.'),
      account: z.string().optional().describe('Username or e-mail of the account the user asked to work on. Set it whenever the user said whose account it is (a client, a colleague, a second account of theirs): a saved login for any other account is then refused instead of used, even when it is the only one for the site.'),
      source: z.string().optional().describe('Only this source: browser, 1password, bitwarden, dashlane, lastpass, protonpass, keepassxc or command.'),
      submit: z.boolean().optional().describe('Press Enter after filling (default true).'),
      field: z.string().optional().describe('Ref (eN) of the one password or one-time code field to fill, e.g. a "Confirm access" password prompt. Any other kind of field is refused.'),
      ...snapOpts,
    },
  }, guard(async ({ tab, item, account, source, submit, field, text: t, max, within }) => {
    const page = getTab(tab);
    const r = await signIn(page, { item, source, submit, account, field });
    recorder.addStep(page, { do: 'login', source: r.source, ...(r.item ? { item: r.item } : {}), ...(account ? { account } : {}), ...(submit === false ? { submit } : {}) } as Step);
    await domQuiet(page);
    return `${r.text}\n\n${await snapshot(page, { text: t, max, within })}`;
  }));

  s.registerTool('fl_snapshot', {
    description: 'Re-read a tab: interactive elements with refs, headings and the start of the text. Always the whole page, unless diff=true (only what changed since the last snapshot you received).',
    inputSchema: { tab: z.string(), diff: z.boolean().optional(), ...snapOpts },
  }, guard(async ({ tab, diff, text: t, max, within }) => snapshot(getTab(tab), { text: t, max, within, diff: !!diff })));

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
      // A "show password" click would put the filled password in the picture, where no masking applies.
      assertNoSecret(page, 'A screenshot');
      const opts = { type: 'jpeg' as const, quality: 55, scale: 'css' as const };
      const target = ref ? elementByRef(page, ref) : selector ? page.locator(mainFrameSelector(selector)).first() : null;
      // Embedded frames of sites outside the user's list are hidden for the picture.
      const hidden = await hideForeignFrames(page);
      let buf: Buffer;
      try {
        buf = target ? await target.screenshot({ ...opts, timeout: 8000 }) : await page.screenshot({ ...opts, fullPage: !!full });
      } finally {
        await hidden.restore();
      }
      // The tab may have moved to another site while the picture was taken.
      getTab(tab);
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }] };
    } catch (e) {
      return { ...text(redact(`Error: ${(e as Error).message}`)), isError: true };
    }
  });

  s.registerTool('fl_tabs', { description: 'List tabs opened by Flintrail.', inputSchema: {} },
    guard(async () => listTabs().join('\n') || 'No tabs.'));

  s.registerTool('fl_close', { description: 'Close a Flintrail tab.', inputSchema: { tab: z.string() } },
    guard(async ({ tab }) => {
      // A tab of the user's browser keeps living if closing fails: its own look comes back first. A tab that left
      // the allowed sites is closed all the same.
      const said: string[] = [];
      let ctx: BrowserContext | null = null;
      try {
        const page = getTab(tab);
        ctx = page.context();
        const saved = await stopVideo(page);
        if (saved) said.push(saved);
        await clearMocks(page);
        await resetEmulation(page);
      } catch { /* closed below anyway */ }
      await closeTab(tab);
      // The last tab driven in that browser: its trace is saved.
      const traced = ctx ? await endTraceIfIdle(ctx, drivenIn(ctx)).catch((e: Error) => `Trace: ${e.message}`) : null;
      if (traced) said.push(traced);
      return `Tab ${tab} closed.${said.map((x) => ` ${x}`).join('')}`;
    }));

  s.registerTool('fl_emulate', {
    description: 'Make a tab look to the site like a phone or tablet (device, e.g. "iPhone 15", or width/height/mobile), with another user agent, position, language, time zone, color scheme, or offline. Per tab; reset:true, fl_release or fl_close puts it back. Reload the page (goto) for sites that read these only at load.',
    inputSchema: {
      tab: z.string(),
      device: z.string().optional().describe('A Playwright device name: "iPhone 15", "Pixel 7", "iPad Pro 11"...'),
      width: z.number().int().min(200).max(4000).optional(), height: z.number().int().min(200).max(4000).optional(),
      mobile: z.boolean().optional().describe('Mobile viewport and touch events.'),
      userAgent: z.string().max(500).optional(),
      latitude: z.number().optional(), longitude: z.number().optional(), accuracy: z.number().optional(),
      locale: z.string().optional().describe('e.g. fr-FR'),
      timezone: z.string().optional().describe('e.g. Europe/Paris'),
      colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
      offline: z.boolean().optional(),
      reset: z.boolean().optional().describe('Back to the tab\'s own values.'),
    },
  }, guard(async ({ tab, ...o }) => emulate(getTab(tab), o)));

  s.registerTool('fl_pdf', {
    description: 'Save the page of a tab as a PDF file (A4 by default, backgrounds printed) and return its path. Works in the dedicated browser and in the user\'s browsers.',
    inputSchema: {
      tab: z.string(),
      name: z.string().optional().describe('File name, without .pdf (default: the page title).'),
      landscape: z.boolean().optional(),
      format: z.enum(['A4', 'Letter', 'A3', 'Legal']).optional(),
    },
  }, guard(async ({ tab, name, landscape, format }) => savePdf(getTab(tab), { name, landscape, format })));

  s.registerTool('fl_mock', {
    description: 'Change what the network answers a tab, to test how the site behaves: block a request, make it fail, delay it, or answer it yourself (status, body). Matches requests whose address contains url (or matches it, with regex). Per tab, applied in order of creation; list shows what each rule caught, clear removes them, fl_release and fl_close too. A tab with any rule counts as one you ran JavaScript in (no password filled or secret pasted there afterwards). Requests made by a service worker are not caught. What the page sends is never shown.',
    inputSchema: {
      tab: z.string(),
      action: z.enum(['block', 'fail', 'delay', 'respond', 'list', 'clear']),
      url: z.string().optional().describe('Part of the request address, e.g. "/api/orders".'),
      regex: z.boolean().optional().describe('url is a regular expression, e.g. "\\/api\\/.*\\.json$".'),
      method: z.string().optional().describe('Only this method (GET, POST...).'),
      status: z.number().int().optional().describe('respond: HTTP status (default 200).'),
      body: z.string().optional().describe('respond: the body (1 MB at most).'),
      contentType: z.string().optional().describe('respond: default application/json when the body looks like JSON, text/plain otherwise.'),
      headers: z.record(z.string(), z.string()).optional().describe('respond: extra headers (no Set-Cookie or Clear-Site-Data).'),
      ms: z.number().int().optional().describe('delay: milliseconds, up to 60000.'),
      times: z.number().int().min(1).optional().describe('Only the first N matching requests.'),
    },
  }, guard(async ({ tab, ...o }) => mock(getTab(tab), o)));

  s.registerTool('fl_trace', {
    description: 'Record a Playwright trace of what you do in a browser (every tab Flintrail drives there): each action with a picture before and after (no page copy or network log, they would hold cookies). stop, or releasing or closing the last tab, saves a .zip the user opens with `npx playwright show-trace`. Stops by itself after 30 minutes. Deleted, not saved, if Flintrail fills a password or secret meanwhile. Refused while FLINTRAIL_ALLOWED_DOMAINS is set.',
    inputSchema: {
      tab: z.string().describe('A tab of the browser to trace.'),
      action: z.enum(['start', 'stop']),
      name: z.string().optional().describe('start: name of the file.'),
    },
  }, guard(async ({ tab, action, name }) => trace(getTab(tab), action, name)));

  s.registerTool('fl_video', {
    description: 'Film one tab (WebM), with each action pointed out on screen unless actions is false, to show a person what was done. stop, fl_release or fl_close saves it. Deleted, not saved, if Flintrail fills a password or secret in the tab meanwhile. Refused while FLINTRAIL_ALLOWED_DOMAINS is set.',
    inputSchema: {
      tab: z.string(),
      action: z.enum(['start', 'stop']),
      name: z.string().optional().describe('start: name of the file (default: the page title).'),
      actions: z.boolean().optional().describe('start: point out each click and fill on screen (default true).'),
    },
  }, guard(async ({ tab, action, name, actions }) => video(getTab(tab), action, { name, actions })));

  s.registerTool('fl_capture_secret', {
    description: 'Store a secret a site shows once (a new GitHub or Cloudflare token, an API key) straight from the user\'s open tab into a vault: the value never reaches you, you only get its kind, length, public prefix and destination. The tab must be on the site that issues that kind. Works even when another extension stopped the tab from being driven. The user confirms a "prefix" kind, a 1Password vault, or replacing a name the McpHub vault already holds, unless they turned these questions off in the extension. Afterwards the pages of that site refuse scripts and screenshots until they change page. To use the secret later, give its vault name to the tool or service that needs it.',
    inputSchema: {
      browser: z.string().describe('The user\'s browser holding the tab (a name from fl_extension).'),
      url: z.string().min(3).describe('Part of the address of the tab showing the secret, e.g. "github.com/settings/personal-access-tokens".'),
      kind: z.enum(['github', 'cloudflare', 'stripe', 'npm', 'openai', 'anthropic', 'resend', 'prefix']).describe('The kind of secret; "prefix" with prefix for any other (the user confirms).'),
      prefix: z.string().optional().describe('With kind "prefix": the literal start of the secret, ending in "_" or "-", e.g. "pk_live_".'),
      to: z.string().describe('"mcphub:NAME", "mcphub:tenant/NAME" or "1password:Vault/Item title".'),
    },
  }, guard(async ({ browser, url, kind, prefix, to }) => captureSecret({ browser, match: url, kind, prefix, to })));

  s.registerTool('fl_paste_secret', {
    description: 'Type a secret from the user\'s vault (a token stored with fl_capture_secret, an API key) into one field of a tab, without the value ever reaching you. The user clicks to allow each paste in the Flintrail extension, which shows the site and the secret\'s name, unless they turned these questions off there: a refusal is final, do not try another way. Only in the user\'s own browsers, over HTTPS, in a visible text or password field of the page itself, and not in a tab where you ran JavaScript. Afterwards the page refuses scripts and screenshots until it loads another page.',
    inputSchema: {
      tab: z.string(),
      ref: z.string().optional().describe('The field, from the snapshot (eN).'),
      selector: z.string().optional(), label: z.string().optional(),
      from: z.string().describe('"mcphub:NAME", "mcphub:tenant/NAME" or "1password:Vault/Item title".'),
      submit: z.boolean().optional().describe('Press Enter in the field afterwards.'),
      ...snapOpts,
    },
  }, guard(async ({ tab, ref, selector, label, from, submit, text: t, max, within }) => {
    const page = getTab(tab);
    const said = await pasteSecret(page, { ref, selector, label, from, submit });
    await domQuiet(page);
    return `${said}\n\n${await snapshot(page, { text: t, max, within })}`;
  }));

  s.registerTool('fl_session', {
    description: 'Save the signed-in state of one site from the dedicated browser (cookies and local storage) to a file readable by the user only, or load it back, e.g. on another machine or after clearing the profile. The content is never shown to you. Dedicated browser only: the user\'s own browsers keep their sessions themselves.',
    inputSchema: {
      action: z.enum(['save', 'load']),
      name: z.string().describe('Name of the saved session, e.g. "github-work".'),
      site: z.string().optional().describe('save: the site whose session to save, e.g. github.com (its subdomains included).'),
      replace: z.boolean().optional().describe('save: replace a session already saved under that name.'),
    },
  }, guard(async ({ action, name, site, replace }) => {
    if (action === 'save') {
      if (!site) throw new Error('save needs site, e.g. github.com.');
      return saveSession({ site, name, replace });
    }
    return loadSession({ name });
  }));

  s.registerTool('fl_release', {
    description: 'Stop driving a tab of the user\'s browser without closing it: the user keeps it, and it can be taken over again later (fl_open or fl_adopt). Use it when done with a tab the user had open; fl_close closes it.',
    inputSchema: { tab: z.string() },
  }, guard(async ({ tab }) => {
    // The user gets the tab back as it was: no phone screen or other language left on it.
    const said: string[] = [];
    let ctx: BrowserContext | null = null;
    try {
      const page = getTab(tab);
      ctx = page.context();
      const saved = await stopVideo(page);
      if (saved) said.push(saved);
      await clearMocks(page);
      await resetEmulation(page);
    } catch { /* released below anyway */ }
    await releaseTab(tab);
    const traced = ctx ? await endTraceIfIdle(ctx, drivenIn(ctx)).catch((e: Error) => `Trace: ${e.message}`) : null;
    if (traced) said.push(traced);
    return `Tab ${tab} released: still open in the browser, no longer driven.${said.map((x) => ` ${x}`).join('')}`;
  }));

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
    inputSchema: { name: z.string(), vars: z.record(z.string(), z.string()).optional(), tab: z.string().optional(), browser: browserOpt, direct: z.boolean().optional().describe('Send the flow\'s recorded API request alone instead of replaying the UI steps (only for flows where fl_record_stop or fl_flows reports a direct API call). It writes on the site without going through its interface: ask the user before the first direct run of a flow. A refusal (HTTP 4xx) falls back to the UI steps; any other failure stops without replaying, to never write twice.') },
  }, guard(async ({ name, vars, tab, browser, direct }) => (await runFlow(name, vars || {}, tab, { browser, direct })).text));

  s.registerTool('fl_run_many', {
    description: 'Replay the same flow for many variable sets in parallel, each in its own background tab.',
    inputSchema: { name: z.string(), runs: z.array(z.record(z.string(), z.string())).min(1), concurrency: z.number().optional(), keepTabs: z.boolean().optional(), browser: browserOpt, direct: z.boolean().optional().describe('Send each run as the flow\'s direct API request, as in fl_run.') },
  }, guard(async ({ name, runs, concurrency, keepTabs, browser, direct }) => runMany(name, runs, concurrency ?? 4, !!keepTabs, browser, !!direct)));

  s.registerTool('fl_flows', { description: 'List recorded flows with their variables and last timing.', inputSchema: {} },
    guard(async () => listFlows()
      .map((f) => `${f.name}: ${f.steps.length} steps, vars [${f.vars.join(', ')}], ${f.runs} runs${f.lastMs ? `, last ${f.lastMs} ms` : ''}${f.api ? `, direct API call ${describeShortcut(f.api)}` : ''}. ${f.description}`)
      .join('\n') || 'No flows yet.'));

  s.registerTool('fl_flow', { description: 'Show a flow with all its steps and element fingerprints.', inputSchema: { name: z.string() } },
    guard(async ({ name }) => JSON.stringify(loadFlow(name), null, 1)));

  s.registerTool('fl_flow_export', {
    description: 'A recorded flow as a Playwright Test file (.spec.ts text) for the project\'s own test suite: runs with `npx playwright test` in Chromium, Firefox or WebKit. Variables come from environment variables FLOW_<NAME>, a sign-in step from LOGIN_USERNAME and LOGIN_PASSWORD. Write the text to a file in the project yourself.',
    inputSchema: { name: z.string() },
  }, guard(async ({ name }) => exportFlow(name)));

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
    // The direct API call must carry the new variable too, or it would keep sending the recorded value.
    let direct = '';
    if (f.api) {
      const bound = st.value !== undefined && was !== undefined ? bindVariable(f.api, was, v) : null;
      if (bound) {
        f.api = bound;
        direct = ' The direct API call uses it too.';
      } else {
        delete f.api;
        direct = ' The direct API call was removed: the recorded value is not found exactly once in its request.';
      }
    }
    saveFlow(f);
    return `Step ${step} of "${name}" now uses {{${v}}} (recorded value was "${was}").${direct}`;
  }));

  s.registerTool('fl_extension', {
    description: 'Browsers Flintrail can drive: the dedicated one ("agent") and every user browser where the Flintrail extension is connected ("brave-soflution", "chrome"...), named after the browser profile or the label the user gave it in the extension, plus the profiles of this computer that are not open (fl_open opens them). Several conversations can drive them at once, each sees only its own tabs. Pass the name as browser to fl_open. tabs: true also lists the tabs open in each browser (site and title), to find the window where an account is signed in.',
    inputSchema: {
      tabs: z.boolean().optional().describe('Also list the open tabs of each user browser (origin and title).'),
      browser: z.string().optional().describe('Only this browser.'),
    },
  }, guard(async ({ tabs, browser }) => {
    const lines = [config.mode === 'extension' ? 'agent: none (extension mode)' : `agent: dedicated browser (${config.mode} mode)`];
    const relay = getRelayClient();
    if (!relay) lines.push('Extension relay turned off (FLINTRAIL_RELAY=off).');
    else {
      try {
        await relay.ensure();
      } catch (e) {
        lines.push(`Relay unreachable on 127.0.0.1:${config.relayPort}: ${(e as Error).message}`);
      }
      if (relay.connected) {
        const list = relay.browsers.filter((b) => !browser || b === relay.find(browser));
        for (const b of list) {
          const name = (b.label ? ` "${b.label}"` : '') + (b.profile ? `, profile "${b.profile}"` : '');
          const old = b.legacy ? ' (outdated: reload the extension in this browser to update it)' : '';
          lines.push(`${b.key}: Extension connected (${b.browser}${name}, extension ${b.version})${old}`);
          if (!tabs) continue;
          try {
            const open = await relay.request('tabs', { key: b.key }) as { origin: string; title: string; window: number; attached: boolean }[];
            // Tabs on sites outside the user's list are not described to the agent.
            const offList = (t: { origin: string }) => config.allowedDomains.length > 0 && (!t.origin || !!domainProblem(t.origin));
            const outside = open.filter(offList).length;
            if (outside) lines.push(`  ${outside} tab(s) on sites outside the allowed list, not shown.`);
            for (const t of open.filter((x) => !offList(x))) lines.push(`  window ${t.window}: ${t.origin || '(blank)'}  ${t.title}${t.attached ? '  [driven or shared]' : ''}`);
          } catch (e) { lines.push(`  tabs unavailable: ${(e as Error).message}`); }
        }
        // Profiles of this computer with no connected window: fl_open opens them on demand.
        const open = new Set(relay.browsers.map((b) => `${b.key.split('-')[0]}/${slug(b.profile)}`));
        const closed = localProfiles().filter((p) => !open.has(`${p.brand}/${slug(p.name)}`) && (!browser || matchProfiles(browser, [p]).length));
        if (closed.length) lines.push(`Not open (fl_open with browser "<profile name>" opens it): ${closed.map((p) => `${p.brand} "${p.name}"`).join(', ')}.`);
        if (!relay.browsers.length) lines.push(`No user browser connected. The Flintrail extension pairs and connects by itself once installed (relay 127.0.0.1:${config.relayPort}, version ${relay.relayVersion}).`);
        else if (browser && !list.length) lines.push(`Browser "${browser}" is not connected.`);
      }
    }
    lines.push(`Recording: ${recorder.status() || 'none'}.`);
    return lines.join('\n');
  }));

  return s;
}
