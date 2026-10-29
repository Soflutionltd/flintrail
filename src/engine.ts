// Live driving: tabs, compact snapshots, batched actions, smart waits, network capture.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Dialog, Frame, Locator, Page, Request } from 'playwright-core';
import { getAttachedBrowser, getContext } from './browser.js';
import { config } from './config.js';
import { describeScript, dialogOverrideScript, domQuietScript, fetchScript, snapshotScript, type TargetDescriptor } from './page-scripts.js';
import { recorder } from './recorder.js';

export type ActionKind =
  | 'click' | 'dblclick' | 'hover' | 'fill' | 'type' | 'select' | 'check' | 'uncheck' | 'press' | 'download' | 'upload'
  | 'goto' | 'back' | 'wait' | 'scroll' | 'eval' | 'request' | 'mouse' | 'dialog' | 'resize' | 'login';

export interface Action {
  do: ActionKind;
  ref?: string;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  exact?: boolean;
  value?: string;
  var?: string;
  key?: string;
  url?: string;
  ms?: number;
  x?: number;
  y?: number;
  count?: number;
  width?: number;
  height?: number;
  accept?: boolean;
  files?: string[];
  js?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /** login steps: password source, login ID in that source, and whether to press Enter after filling. */
  source?: string;
  item?: string;
  submit?: boolean;
}

export interface Step extends Omit<Action, 'ref'> {
  target?: TargetDescriptor;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tabs = new Map<string, Page>();
let nextTab = 1;

interface ConsoleEntry { level: 'error' | 'warning' | 'info' | 'pageerror'; text: string; at: string }
interface PageState {
  console: ConsoleEntry[];
  unseenErrors: number;
  dialogs: string[];
  nextDialog?: { accept: boolean; value?: string };
}
const states = new WeakMap<Page, PageState>();
function stateOf(page: Page): PageState {
  let s = states.get(page);
  if (!s) states.set(page, (s = { console: [], unseenErrors: 0, dialogs: [] }));
  return s;
}

function logConsole(page: Page, level: ConsoleEntry['level'], text: string) {
  const s = stateOf(page);
  s.console.push({ level, text: text.slice(0, 2000), at: new Date().toISOString().slice(11, 23) });
  if (s.console.length > 300) s.console.shift();
  if (level === 'error' || level === 'pageerror') s.unseenErrors++;
}

async function onDialog(page: Page, d: Dialog) {
  const s = stateOf(page);
  const policy = s.nextDialog;
  s.nextDialog = undefined;
  const accept = policy ? policy.accept : d.type() === 'beforeunload';
  const label = `dialog ${d.type()} "${d.message().slice(0, 200)}" -> ${accept ? 'accepted' : 'dismissed'}`;
  try {
    await (accept ? d.accept(policy?.value ?? d.defaultValue()) : d.dismiss());
    s.dialogs.push(label);
  } catch (e) {
    s.dialogs.push(`${label} FAILED: ${(e as Error).message.split('\n')[0]}`);
  }
}

function register(page: Page): string {
  for (const [id, p] of tabs) if (p === page) return id;
  const id = 't' + nextTab++;
  tabs.set(id, page);
  page.on('close', () => tabs.delete(id));
  page.on('request', (r) => recorder.onRequest(r));
  page.on('response', (r) => recorder.onResponse(r));
  page.on('console', (m) => {
    const t = m.type();
    const level = t === 'error' ? 'error' : t === 'warning' ? 'warning' : 'info';
    const where = m.location();
    logConsole(page, level, level === 'info' || !where.url ? m.text() : `${m.text()} (${where.url.slice(0, 160)}:${where.lineNumber})`);
  });
  page.on('pageerror', (e) => logConsole(page, 'pageerror', e.message));
  page.on('dialog', (d) => void onDialog(page, d));
  return id;
}

/** Console messages and uncaught exceptions of a tab, errors only unless level is "all". */
export function consoleLog(page: Page, level: 'errors' | 'all' = 'errors', clear = false): string {
  const s = stateOf(page);
  const list = s.console.filter((c) => level === 'all' || c.level === 'error' || c.level === 'pageerror');
  s.unseenErrors = 0;
  if (clear) s.console = [];
  if (!list.length) return level === 'all' ? 'Console is empty.' : 'No console errors.';
  return list.map((c) => `${c.at} ${c.level}: ${c.text}`).join('\n');
}

/** Notes about dialogs handled and new console errors since the last report. */
function pageNotes(page: Page): string[] {
  const s = stateOf(page);
  const notes = s.dialogs.splice(0);
  if (s.unseenErrors) {
    notes.push(`${s.unseenErrors} new console error${s.unseenErrors > 1 ? 's' : ''}, see fl_console`);
    s.unseenErrors = 0;
  }
  return notes;
}

export async function newPage(): Promise<Page> {
  const ctx = await getContext();
  const browser = getAttachedBrowser();
  if (browser) {
    // Open the tab in the background so the window never steals focus.
    try {
      const cdp = await browser.newBrowserCDPSession();
      const waitPage = ctx.waitForEvent('page', { timeout: 8000 });
      // Open it in the profile the user is actually using: with several Chrome profiles, the CDP default
      // context can be a profile that is signed out of everything.
      const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: { type: string; url: string; browserContextId?: string }[] };
      const count = new Map<string, number>();
      for (const t of targetInfos) {
        if (t.type === 'page' && /^https?:/.test(t.url) && t.browserContextId) count.set(t.browserContextId, (count.get(t.browserContextId) || 0) + 1);
      }
      const browserContextId = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
      await cdp.send('Target.createTarget', { url: 'about:blank', background: true, ...(browserContextId ? { browserContextId } : {}) });
      const page = await waitPage;
      await cdp.detach().catch(() => {});
      return page;
    } catch { /* fall back below */ }
  }
  return ctx.newPage();
}

export async function openTab(url?: string): Promise<string> {
  const page = await newPage();
  const id = register(page);
  if (url) {
    await gotoFast(page, url);
    recorder.onOpen(url);
  }
  return id;
}

/** Take over a tab the user already has open, for example one where they just signed in by hand. */
export async function adoptTab(match: string): Promise<string> {
  const ctx = await getContext();
  const owned = new Set(tabs.values());
  const page = ctx.pages().filter((p) => !owned.has(p) && !p.isClosed() && p.url().includes(match)).at(-1);
  if (!page) throw new Error(`No open tab whose URL contains "${match}".`);
  return register(page);
}

export function getTab(id: string): Page {
  const p = tabs.get(id);
  if (!p || p.isClosed()) throw new Error(`Tab ${id} not found. Use fl_open first.`);
  return p;
}

export function listTabs(): string[] {
  return [...tabs].filter(([, p]) => !p.isClosed()).map(([id, p]) => `${id}  ${p.url()}`);
}

export async function closeTab(id: string) {
  await getTab(id).close();
}

export async function gotoFast(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

/** Lets a client-side app finish re-rendering before we read it. Never waits on the network. */
export async function domQuiet(page: Page, idle = 25, quiet = 80, max = 1200) {
  await page.mainFrame().evaluate(domQuietScript, { idle, quiet, max }).catch(() => {});
}

/** Runs an interaction and waits for a navigation only if that interaction actually started one. */
export async function withNavigation<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  let navigated = false;
  const onReq = (r: Request) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigated = true;
  };
  page.on('request', onReq);
  try {
    const out = await fn();
    await sleep(25);
    if (navigated) await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    return out;
  } finally {
    page.off('request', onReq);
  }
}

export async function snapshot(page: Page, opts: { max?: number; text?: number } = {}): Promise<string> {
  const frames = page.frames().filter((f) => !f.isDetached()).slice(0, 6);
  // Frames are read in parallel: one round trip instead of one per frame.
  const reads = await Promise.all(frames.map((f, i) => f.evaluate(snapshotScript, {
    max: i === 0 ? opts.max ?? 150 : 40,
    text: i === 0 ? opts.text ?? 600 : 0,
    prefix: i === 0 ? '' : `f${i}:`,
  }).catch(() => null)));
  const head = reads[0];
  const extra: string[] = [];
  reads.forEach((s, i) => {
    if (i > 0 && s?.lines.length) extra.push(`-- frame ${i} (${frames[i]!.url().slice(0, 80)})`, ...s.lines);
  });
  const notes = pageNotes(page);
  if (!head) return [...notes, `URL: ${page.url()} (page not readable yet)`].join('\n');
  const out = [...notes, `URL: ${head.url}`, `Title: ${head.title}`, ...head.heads, '', ...head.lines, ...extra];
  if (head.more) out.push('(list truncated, raise max if needed)');
  if (head.body) out.push('', 'Text: ' + head.body);
  return out.join('\n');
}

function fromRef(page: Page, ref: string): { frame: Frame; key: string } {
  const m = /^f(\d+):(e\d+)$/.exec(ref);
  if (m) {
    const frame = page.frames()[Number(m[1])];
    if (!frame) throw new Error(`Frame for ref ${ref} is gone, take a new snapshot.`);
    return { frame, key: m[2]! };
  }
  return { frame: page.mainFrame(), key: ref };
}

export function elementByRef(page: Page, ref: string): Locator {
  const { frame, key } = fromRef(page, ref);
  return frame.locator(`[data-fl="${key}"]`).first();
}

function liveLocator(page: Page, a: Action): { loc: Locator; frame: Frame } | null {
  const main = page.mainFrame();
  if (a.ref) {
    const { frame, key } = fromRef(page, a.ref);
    return { loc: frame.locator(`[data-fl="${key}"]`), frame };
  }
  if (a.selector) return { loc: page.locator(a.selector), frame: main };
  if (a.role) return { loc: page.getByRole(a.role as Parameters<Page['getByRole']>[0], { name: a.name, exact: !!a.exact }), frame: main };
  if (a.text) return { loc: page.getByText(a.text, { exact: !!a.exact }), frame: main };
  if (a.label) return { loc: page.getByLabel(a.label), frame: main };
  if (a.placeholder) return { loc: page.getByPlaceholder(a.placeholder), frame: main };
  return null;
}

const quote = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const unstableId = (id: string) => /\d{3,}|[a-f0-9]{8,}|:/.test(id);

/** Finds a recorded element again, trying the most stable clues first. */
export async function resolveTarget(page: Page, d: TargetDescriptor, timeout = 7000): Promise<Locator | null> {
  const frame = (d.frameUrl && page.frames().find((f) => f.url().split('?')[0] === d.frameUrl)) || page.mainFrame();
  const c: Locator[] = [];
  if (d.testid) c.push(frame.locator(`[data-testid="${quote(d.testid)}"],[data-test="${quote(d.testid)}"],[data-qa="${quote(d.testid)}"]`));
  if (d.id && !unstableId(d.id)) c.push(frame.locator(`[id="${quote(d.id)}"]`));
  if (d.nameAttr) c.push(frame.locator(`${d.tag}[name="${quote(d.nameAttr)}"]`));
  if (d.role && d.name) c.push(frame.getByRole(d.role as Parameters<Page['getByRole']>[0], { name: d.name, exact: true }));
  if (d.placeholder) c.push(frame.getByPlaceholder(d.placeholder, { exact: true }));
  if (d.href && d.tag === 'a') c.push(frame.locator(`a[href="${quote(d.href)}"]`));
  if (d.text && d.text.length < 60) c.push(frame.locator(d.tag).filter({ hasText: d.text }));
  if (d.css) c.push(frame.locator(d.css));
  const end = Date.now() + timeout;
  for (;;) {
    let fallback: Locator | null = null;
    for (const cand of c) {
      const n = await cand.count().catch(() => 0);
      if (n === 1) return cand;
      if (n > 1) {
        const v = cand.filter({ visible: true });
        if ((await v.count().catch(() => 0)) === 1) return v;
        fallback ??= v.first();
      }
    }
    if (Date.now() > end) return fallback;
    await sleep(60);
  }
}

/** Substitutes {{var}} placeholders. Without a vars object (live mode) values pass through untouched. */
export function fillVars(v: string | undefined, vars?: Record<string, string>): string | undefined {
  if (typeof v !== 'string' || !vars) return v;
  return v.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`Missing variable: ${k}`);
    return vars[k]!;
  });
}

const TIMEOUT = 8000;

/** Performs an element action. Returns optional artefacts (download path). */
export async function performOn(page: Page, loc: Locator, a: Step, vars?: Record<string, string>): Promise<{ download?: string }> {
  const value = fillVars(a.value, vars) ?? '';
  if (a.do === 'download') {
    mkdirSync(config.downloadsDir, { recursive: true });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), loc.click({ timeout: TIMEOUT })]);
    const path = join(config.downloadsDir, dl.suggestedFilename());
    await dl.saveAs(path);
    return { download: path };
  }
  if (a.do === 'upload') {
    const files = (a.files || []).map((f) => fillVars(f, vars)!);
    if (!files.length) throw new Error('upload needs files: absolute paths on this machine.');
    const absent = files.find((f) => !existsSync(f));
    if (absent) throw new Error(`File not found: ${absent}`);
    const isFileInput = await loc.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file', undefined, { timeout: TIMEOUT });
    if (isFileInput) {
      await loc.setInputFiles(files, { timeout: TIMEOUT });
    } else {
      // A button or drop zone that opens the native file chooser: answer the chooser instead.
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: TIMEOUT }), loc.click({ timeout: TIMEOUT })]);
      await chooser.setFiles(files);
    }
    return {};
  }
  await withNavigation(page, async () => {
    switch (a.do) {
      case 'click': return loc.click({ timeout: TIMEOUT });
      case 'dblclick': return loc.dblclick({ timeout: TIMEOUT });
      case 'hover': return loc.hover({ timeout: TIMEOUT });
      case 'fill': return loc.fill(value, { timeout: TIMEOUT });
      case 'type': return loc.pressSequentially(value, { delay: 25, timeout: TIMEOUT });
      case 'select': return loc.selectOption(value, { timeout: TIMEOUT });
      case 'check': return loc.check({ timeout: TIMEOUT });
      case 'uncheck': return loc.uncheck({ timeout: TIMEOUT });
      case 'press': return loc.press(a.key || 'Enter', { timeout: TIMEOUT });
      default: throw new Error(`Unknown element action: ${a.do}`);
    }
  });
  return {};
}

export const PAGE_ACTIONS = new Set<ActionKind>(['goto', 'back', 'wait', 'scroll', 'eval', 'request', 'mouse', 'dialog', 'resize']);

/** Performs an action that needs no element. Returns a value for eval/request. */
export async function performPage(page: Page, a: Step, vars?: Record<string, string>): Promise<unknown> {
  switch (a.do) {
    case 'goto': await gotoFast(page, fillVars(a.url, vars)!); return undefined;
    case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); return undefined;
    case 'press': await withNavigation(page, () => page.keyboard.press(a.key || 'Enter')); return undefined;
    case 'scroll': await page.mouse.wheel(0, a.y ?? 800); await sleep(120); return undefined;
    case 'mouse': {
      if (typeof a.x !== 'number' || typeof a.y !== 'number') throw new Error('mouse needs x and y (CSS pixels of the viewport, as in fl_screenshot).');
      await withNavigation(page, () => page.mouse.click(a.x!, a.y!, { clickCount: a.count ?? 1 }));
      return undefined;
    }
    case 'dialog': {
      const policy = { accept: a.accept !== false, value: fillVars(a.value, vars) };
      if (config.mode !== 'extension') {
        stateOf(page).nextDialog = policy;
        return undefined;
      }
      // Chrome auto-dismisses dialogs of background tabs driven by chrome.debugger before CDP can answer,
      // so in extension mode the next dialog is answered inside the page instead.
      await page.mainFrame().evaluate(dialogOverrideScript, policy);
      stateOf(page).dialogs.push(`next dialog will be ${policy.accept ? 'accepted' : 'dismissed'} in the page (extension mode)`);
      return undefined;
    }
    case 'resize': {
      if (!a.width || !a.height) throw new Error('resize needs width and height.');
      await page.setViewportSize({ width: a.width, height: a.height });
      return undefined;
    }
    case 'wait':
      if (a.text) await page.getByText(fillVars(a.text, vars)!).first().waitFor({ timeout: a.ms || 15000 });
      else if (a.url) await page.waitForURL(new RegExp(fillVars(a.url, vars)!), { timeout: a.ms || 15000 });
      else await sleep(a.ms || 1000);
      return undefined;
    case 'eval': {
      const body = fillVars(a.js, vars) || 'return null';
      return page.evaluate(`(async () => { ${body} })()`);
    }
    case 'request': {
      const r = await page.evaluate(fetchScript, {
        method: (a.method || 'GET').toUpperCase(),
        url: fillVars(a.url, vars)!,
        body: fillVars(a.body, vars),
        headers: a.headers,
        max: 20000,
      });
      if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 200)}`);
      return r.contentType.includes('json') ? safeJson(r.body) : r.body;
    }
    default: throw new Error(`Unknown page action: ${a.do}`);
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

const refFingerprints = new WeakMap<Page, Map<string, TargetDescriptor>>();
function seenRefs(page: Page): Map<string, TargetDescriptor> {
  let m = refFingerprints.get(page);
  if (!m) refFingerprints.set(page, (m = new Map()));
  return m;
}

const needsElement = (a: Action) =>
  !PAGE_ACTIONS.has(a.do) && !(a.do === 'press' && !a.ref && !a.selector && !a.role && !a.text && !a.label && !a.placeholder);

/** Batched live actions: one round trip for a whole sequence, then one fresh snapshot. */
export async function act(page: Page, actions: Action[], opts: { snapshot?: boolean; max?: number; text?: number } = {}) {
  const notes: string[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    try {
      if (!needsElement(a)) {
        const v = await performPage(page, a);
        recorder.addStep(page, { ...a, ref: undefined } as Step);
        if (v !== undefined) notes.push(`#${i} ${a.do} -> ${JSON.stringify(v).slice(0, 4000)}`);
        continue;
      }
      const live = liveLocator(page, a);
      if (!live) throw new Error('No target given (ref, selector, role, text, label or placeholder).');
      let loc = live.loc.first();
      const seen = seenRefs(page);
      if (a.ref && (await live.loc.count()) === 0) {
        // The site re-rendered the element (common after typing): find it again from its fingerprint.
        const known = seen.get(a.ref);
        const again = known ? await resolveTarget(page, known, 3000) : null;
        if (!again) throw new Error(`Ref ${a.ref} is no longer on the page, take a new snapshot.`);
        loc = again;
      }
      const target = await loc.evaluate(describeScript, undefined, { timeout: 3000 }).catch(() => undefined);
      if (target) {
        if (live.frame !== page.mainFrame()) target.frameUrl = live.frame.url().split('?')[0];
        if (a.ref) seen.set(a.ref, target);
      }
      const r = await performOn(page, loc, a);
      if (recorder.active && target) {
        const warn = recorder.addElementStep(page, a, target);
        if (warn) notes.push(`#${i} ${warn}`);
      }
      if (r.download) notes.push(`#${i} downloaded -> ${r.download}`);
    } catch (e) {
      notes.push(`#${i} FAILED ${a.do}: ${(e as Error).message.split('\n')[0]}`);
      break;
    }
  }
  if (opts.snapshot === false) return [...notes, ...pageNotes(page), `URL: ${page.url()}`].join('\n');
  await domQuiet(page);
  return (notes.length ? notes.join('\n') + '\n\n' : '') + (await snapshot(page, opts));
}
