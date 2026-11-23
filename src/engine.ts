// Live driving: tabs, compact snapshots, batched actions, smart waits, network capture.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Dialog, Frame, Locator, Page, Request } from 'playwright-core';
import { AGENT, getDriven, type Driven } from './browser.js';
import { getRelayClient } from './relay-client.js';
import { config } from './config.js';
import { assertAllowed, domainProblem } from './domains.js';
import { describeScript, dialogOverrideScript, domQuietScript, fetchScript, snapshotScript, type TargetDescriptor } from './page-scripts.js';
import { recorder } from './recorder.js';
import type { DesktopStep } from './desktop.js';

export type ActionKind =
  | 'click' | 'dblclick' | 'hover' | 'fill' | 'type' | 'select' | 'check' | 'uncheck' | 'press' | 'download' | 'upload'
  | 'goto' | 'back' | 'wait' | 'scroll' | 'eval' | 'request' | 'mouse' | 'dialog' | 'resize' | 'login' | 'desktop';

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
  /** do: 'desktop' steps act on a native app instead of the browser. */
  desktop?: DesktopStep;
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
  /** Browser the tab lives in ("agent", "brave"...) and whether it is driven through the extension. */
  browser: string;
  viaExtension: boolean;
}
const states = new WeakMap<Page, PageState>();
function stateOf(page: Page): PageState {
  let s = states.get(page);
  if (!s) states.set(page, (s = { console: [], unseenErrors: 0, dialogs: [], browser: AGENT, viaExtension: false }));
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

function register(page: Page, where: Driven): string {
  for (const [id, p] of tabs) if (p === page) return id;
  const id = 't' + nextTab++;
  tabs.set(id, page);
  Object.assign(stateOf(page), { browser: where.name, viaExtension: where.viaExtension });
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

/** In a user browser: open the tab in this window (id from fl_extension tabs), or in a new window. */
export interface Placement {
  window?: number;
  newWindow?: boolean;
}

/** Tabs being opened, per browser context. */
const opening = new WeakMap<BrowserContext, Promise<unknown>>();

/**
 * Opens a tab, one at a time per browser: each opening waits for "the next page" of the context, so two
 * at once could both get the same tab.
 */
function newPage(where: Driven, placement: Placement = {}): Promise<Page> {
  const run = (opening.get(where.ctx) ?? Promise.resolve()).catch(() => {}).then(() => openPage(where, placement));
  opening.set(where.ctx, run);
  return run;
}

async function openPage(where: Driven, placement: Placement = {}): Promise<Page> {
  const placed = placement.window !== undefined || !!placement.newWindow;
  const { ctx, browser } = where;
  if (browser) {
    // Open the tab in the background so the window never steals focus.
    try {
      const cdp = await browser.newBrowserCDPSession();
      const waitPage = ctx.waitForEvent('page', { timeout: 8000 });
      // If a CDP call below throws first, this wait would time out later with nobody awaiting it and
      // crash the whole process: mark it handled, it is still awaited on the success path.
      waitPage.catch(() => {});
      // Open it in the profile the user is actually using: with several Chrome profiles, the CDP default
      // context can be a profile that is signed out of everything.
      const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: { type: string; url: string; browserContextId?: string }[] };
      const count = new Map<string, number>();
      for (const t of targetInfos) {
        if (t.type === 'page' && /^https?:/.test(t.url) && t.browserContextId) count.set(t.browserContextId, (count.get(t.browserContextId) || 0) + 1);
      }
      const browserContextId = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
      // In a user browser the window choice travels in the same command, read by the relay (Chrome ignores it),
      // so two tabs opened at once never swap windows.
      const params = {
        url: 'about:blank', background: true, ...(browserContextId ? { browserContextId } : {}),
        ...(placement.window !== undefined ? { flintrailWindowId: placement.window } : {}),
        ...(placement.newWindow ? { flintrailNewWindow: true } : {}),
      };
      await cdp.send('Target.createTarget', params);
      const page = await waitPage;
      await cdp.detach().catch(() => {});
      return page;
    } catch (e) {
      // A tab asked for a given window must not silently land elsewhere.
      if (placed) throw e;
    }
  }
  return ctx.newPage();
}

/** Opens a background tab in the named browser (see getDriven), optionally on a URL. */
export async function openTab(url?: string, browserName?: string, placement: Placement = {}): Promise<string> {
  const where = await getDriven(browserName);
  if ((placement.window !== undefined || placement.newWindow) && !where.viaExtension) {
    throw new Error('window and newWindow apply to the user\'s browsers only (set browser, see fl_extension).');
  }
  const page = await newPage(where, placement);
  const id = register(page, where);
  if (url) {
    await gotoFast(page, url);
    recorder.onOpen(url);
  }
  return id;
}

/** Take over a tab the user already has open, for example one where they just signed in by hand. */
export async function adoptTab(match: string, browserName?: string): Promise<string> {
  const where = await getDriven(browserName);
  const owned = new Set(tabs.values());
  const free = () => where.ctx.pages().filter((p) => !owned.has(p) && !p.isClosed() && p.url().includes(match)).at(-1);
  let page = free();
  // In a user browser, a tab the user shared from the extension belongs to no conversation until one
  // claims it: the relay then hands it to this process only.
  if (!page && where.viaExtension) {
    const claimed = await getRelayClient()?.request('claim', { key: where.name, match });
    for (let i = 0; claimed && !page && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      page = free();
    }
  }
  if (page) assertAllowed(page.url());
  if (!page) throw new Error(`No open tab in ${where.name} whose URL contains "${match}"${where.viaExtension ? ' (in a user browser, share the tab from the Flintrail extension first)' : ''}.`);
  return register(page, where);
}

/** Browser a Flintrail tab lives in. */
export function tabBrowser(id: string): string {
  return stateOf(getTab(id)).browser;
}

export function getTab(id: string): Page {
  const p = tabs.get(id);
  if (!p || p.isClosed()) throw new Error(`Tab ${id} not found: closed, or released by the extension after 5 minutes without use. Use fl_open, or fl_adopt to take an open tab back.`);
  const why = domainProblem(p.url());
  if (why) throw new Error(`Blocked: tab ${id} went to a site the agent may not work on. ${why} Close it with fl_close.`);
  return p;
}

export function listTabs(): string[] {
  return [...tabs].filter(([, p]) => !p.isClosed())
    .map(([id, p]) => `${id}  [${stateOf(p).browser}]  ${domainProblem(p.url()) ? '(on a site outside the allowed list: close it with fl_close)' : p.url()}`);
}

export async function closeTab(id: string) {
  const page = tabs.get(id);
  if (!page || page.isClosed()) throw new Error(`Tab ${id} not found.`);
  await page.close();
}

export async function gotoFast(page: Page, url: string) {
  assertAllowed(url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The allowed address may redirect elsewhere: nothing is read from that page.
  const why = domainProblem(page.url());
  if (why) {
    await page.goto('about:blank').catch(() => {});
    throw new Error(`Blocked: ${url} redirected to another site. ${why}`);
  }
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

/** A child frame the agent may read: loaded (a frame still on about:blank may be about to load anything) and on an allowed site. */
function readableFrame(frame: Frame): boolean {
  const url = frame.url();
  if (!config.allowedDomains.length) return true;
  return /^https?:/.test(url) && !domainProblem(url);
}

/** Hides the embedded frames the agent may not read, for the time of a screenshot. */
export async function hideForeignFrames(page: Page): Promise<{ restore: () => Promise<void> }> {
  const undo: (() => Promise<void>)[] = [];
  for (const frame of page.frames().slice(1)) {
    if (frame.isDetached() || readableFrame(frame)) continue;
    try {
      const el = await frame.frameElement();
      const before = await el.evaluate((node) => {
        const e = node as HTMLElement;
        const was = e.style.visibility;
        e.style.setProperty('visibility', 'hidden', 'important');
        return was;
      });
      undo.push(async () => { await el.evaluate((node, was) => { (node as HTMLElement).style.visibility = was; }, before).catch(() => {}); });
    } catch { /* the frame went away */ }
  }
  return { restore: async () => { for (const u of undo) await u(); } };
}

export async function snapshot(page: Page, opts: { max?: number; text?: number; diff?: boolean } = {}): Promise<string> {
  const away = domainProblem(page.url());
  if (away) return `Blocked: nothing was read from this tab. ${away} Close it with fl_close.`;
  // An embedded frame of a site outside the user's list is not read either.
  // Each frame keeps its index in page.frames(): a ref "f2:e1" must lead back to that very frame.
  const frames = page.frames().map((frame, index) => ({ frame, index }))
    .filter(({ frame, index }) => !frame.isDetached() && (index === 0 || readableFrame(frame))).slice(0, 6);
  // Frames are read in parallel: one round trip instead of one per frame.
  const reads = await Promise.all(frames.map(({ frame, index }) => frame.evaluate(snapshotScript, {
    max: index === 0 ? opts.max ?? 150 : 40,
    text: index === 0 ? opts.text ?? 600 : 0,
    prefix: index === 0 ? '' : `f${index}:`,
  }).catch(() => null)));
  // The page may have moved while it was being read: what a tab or frame now outside the list returned is dropped.
  const moved = domainProblem(page.url());
  if (moved) {
    lastSeen.delete(page);
    return `Blocked: nothing was read from this tab. ${moved} Close it with fl_close.`;
  }
  const head = reads[0];
  const extra: string[] = [];
  reads.forEach((s, i) => {
    const { frame, index } = frames[i]!;
    if (i > 0 && s?.lines.length && readableFrame(frame)) extra.push(`-- frame ${index} (${frame.url().slice(0, 80)})`, ...s.lines);
  });
  const notes = pageNotes(page);
  if (!head) {
    lastSeen.delete(page);
    return [...notes, `URL: ${page.url()} (page not readable yet)`].join('\n');
  }
  const seen: Seen = {
    url: head.url, title: head.title, max: opts.max ?? 150, text: opts.text ?? 600, more: head.more,
    heads: head.heads, lines: [...head.lines, ...extra], body: head.body,
  };
  const before = lastSeen.get(page);
  lastSeen.set(page, seen);
  const delta = opts.diff && before ? changesSince(before, seen) : null;
  if (delta) return [...notes, ...delta].join('\n');
  const out = [...notes, `URL: ${head.url}`, `Title: ${head.title}`, ...head.heads, '', ...seen.lines];
  if (head.more) out.push('(list truncated, raise max if needed)');
  if (head.body) out.push('', 'Text: ' + head.body);
  return out.join('\n');
}

/** What the agent last received about a tab: the next snapshot can be told as a difference from it. */
interface Seen { url: string; title: string; max: number; text: number; more: boolean; heads: string[]; lines: string[]; body: string }
const lastSeen = new WeakMap<Page, Seen>();

const refOfLine = (line: string) => /^\[([^\]]+)\]/.exec(line)?.[1];

/**
 * The changes between two snapshots of the same page, or null when a full snapshot is the better answer:
 * another page, other options, a truncated list, or so many changes that a difference saves nothing.
 * Refs are stable on a page (an element keeps its ref for as long as it lives), so unchanged lines can be left out.
 */
function changesSince(before: Seen, now: Seen): string[] | null {
  if (before.url !== now.url || before.max !== now.max || before.text !== now.text || before.more || now.more) return null;
  const old = new Map<string, string>();
  for (const line of before.lines) {
    const ref = refOfLine(line);
    if (ref) old.set(ref, line);
  }
  const changes: string[] = [];
  const kept = new Set<string>();
  let same = 0;
  for (const line of now.lines) {
    const ref = refOfLine(line);
    if (!ref) continue; // frame separators
    kept.add(ref);
    const was = old.get(ref);
    if (was === line) same++;
    else changes.push(`${was === undefined ? '+' : '~'} ${line}`);
  }
  for (const [ref, line] of old) if (!kept.has(ref)) changes.push(`- ${line}`);
  const headsChanged = before.heads.join('\n') !== now.heads.join('\n');
  const bodyChanged = before.body !== now.body;
  const full = now.lines.length + now.heads.length + (now.body ? 1 : 0);
  const told = changes.length + (headsChanged ? now.heads.length : 0) + (bodyChanged ? 1 : 0);
  // Past half of the page, the whole page is as short and easier to read.
  if (told * 2 > full) return null;
  const out = [`URL: ${now.url}`];
  if (before.title !== now.title) out.push(`Title: ${now.title}`);
  if (!told) {
    out.push(`No change since the last snapshot of this tab (${same} elements, same refs).`);
    return out;
  }
  out.push(`Changes since the last snapshot of this tab (+ new, ~ changed, - gone). ${same} other element${same === 1 ? '' : 's'} unchanged, same refs.`);
  if (headsChanged) out.push(...now.heads);
  out.push(...changes);
  if (bodyChanged && now.body) out.push('', textChange(before.body, now.body));
  return out;
}

/** The words of the page text that are new, each run with a few words around it; the whole text when most of it changed. */
function textChange(before: string, now: string): string {
  const a = before.split(' ');
  const b = now.split(' ');
  // Longest common subsequence of words: what is left of `now` is new. The text is a few hundred words at most.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const fresh: boolean[] = new Array<boolean>(b.length).fill(true);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { fresh[j] = false; i++; j++; } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++; else j++;
  }
  const count = fresh.filter(Boolean).length;
  if (!count) return 'Text: some of it went away, nothing new.';
  if (count * 2 > b.length) return 'Text: ' + now;
  const parts: string[] = [];
  for (let j = 0; j < b.length; j++) {
    if (!fresh[j]) continue;
    let end = j;
    while (end + 1 < b.length && fresh[end + 1]) end++;
    const from = Math.max(0, j - 3);
    const to = Math.min(b.length, end + 4);
    parts.push(`${from > 0 ? '…' : ''}${b.slice(from, j).join(' ')} [${b.slice(j, end + 1).join(' ')}] ${b.slice(end + 1, to).join(' ')}${to < b.length ? '…' : ''}`.replace(/ +/g, ' ').trim());
    j = end;
  }
  return 'Text, new words in [brackets]: ' + parts.join('  ');
}

function fromRef(page: Page, ref: string): { frame: Frame; key: string } {
  const m = /^f(\d+):(e\d+)$/.exec(ref);
  if (m) {
    const frame = page.frames()[Number(m[1])];
    if (!frame) throw new Error(`Frame for ref ${ref} is gone, take a new snapshot.`);
    if (!readableFrame(frame)) throw new Error(`Blocked: ref ${ref} is in a frame of another site. ${domainProblem(frame.url()) ?? ''}`);
    return { frame, key: m[2]! };
  }
  return { frame: page.mainFrame(), key: ref };
}

export function elementByRef(page: Page, ref: string): Locator {
  const { frame, key } = fromRef(page, ref);
  return frame.locator(`[data-fl="${key}"]`).first();
}

/** With a list of allowed sites, a selector may not step into an embedded frame: use the frame's refs (f1:e3). */
export function mainFrameSelector(selector: string): string {
  if (config.allowedDomains.length && /enter-frame|content-frame/i.test(selector)) {
    throw new Error('Blocked: with FLINTRAIL_ALLOWED_DOMAINS set, a selector cannot enter a frame. Use the refs of that frame from the snapshot.');
  }
  return selector;
}

function liveLocator(page: Page, a: Action): { loc: Locator; frame: Frame } | null {
  const main = page.mainFrame();
  if (a.ref) {
    const { frame, key } = fromRef(page, a.ref);
    return { loc: frame.locator(`[data-fl="${key}"]`), frame };
  }
  if (a.selector) return { loc: page.locator(mainFrameSelector(a.selector)), frame: main };
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
  // A flow recorded without the list may target a frame of a site the list now excludes.
  if (frame !== page.mainFrame() && !readableFrame(frame)) throw new Error(`Blocked: this step targets a frame of another site. ${domainProblem(frame.url()) ?? ''}`);
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
    // A file the allowed page builds itself (blob:, data:) has no other site behind it.
    const source = dl.url().replace(/^blob:/, '');
    const away = source.startsWith('data:') ? null : domainProblem(source);
    if (away) {
      await dl.cancel().catch(() => {});
      throw new Error(`Blocked: the file comes from another site, it was not saved. ${away}`);
    }
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
      if (!stateOf(page).viaExtension) {
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
      const target = fillVars(a.url, vars)!;
      let absolute = target;
      try { absolute = new URL(target, page.url()).href; } catch { /* refused below when a list is set */ }
      assertAllowed(absolute);
      const r = await page.evaluate(fetchScript, {
        method: (a.method || 'GET').toUpperCase(),
        // With a list, the checked address is the one sent: a <base> tag in the page cannot point a relative URL elsewhere.
        url: config.allowedDomains.length ? absolute : target,
        body: fillVars(a.body, vars),
        headers: a.headers,
        max: 20000,
        // With a list of allowed sites a redirect is not followed: it could carry the request to another site.
        manualRedirect: config.allowedDomains.length > 0,
      });
      if (r.redirectedTo !== undefined && config.allowedDomains.length) {
        throw new Error('Blocked: the site answered with a redirect, which is not followed while FLINTRAIL_ALLOWED_DOMAINS is set. Request the final address directly.');
      }
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
export async function act(page: Page, actions: Action[], opts: { snapshot?: boolean; max?: number; text?: number; diff?: boolean } = {}) {
  const notes: string[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    recorder.beginAction(page);
    try {
      // A click may have led to a site outside the user's list: stop there, read nothing.
      assertAllowed(page.url());
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
  const away = domainProblem(page.url());
  if (away) return [...notes, `Blocked: the tab went to another site, nothing was read from it. ${away} Close it with fl_close.`].join('\n');
  if (opts.snapshot === false) return [...notes, ...pageNotes(page), `URL: ${page.url()}`].join('\n');
  await domQuiet(page);
  return (notes.length ? notes.join('\n') + '\n\n' : '') + (await snapshot(page, { max: opts.max, text: opts.text, diff: opts.diff !== false }));
}
