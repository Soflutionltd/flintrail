// Live driving: tabs, compact snapshots, batched actions, smart waits, network capture.
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { BrowserContext, Dialog, Frame, Locator, Page, Request } from 'playwright-core';
import { AGENT, getDriven, type Driven } from './browser.js';
import { getRelayClient } from './relay-client.js';
import { config } from './config.js';
import { assertAllowed, domainProblem } from './domains.js';
import { maskUrl, redact, rememberUrlTokens } from './secrets.js';
import { urlMatches, type MatchMode } from './relay-protocol.js';
import { describeScript, dialogOverrideScript, domQuietScript, fetchScript, snapshotScript, type TargetDescriptor } from './page-scripts.js';
import { recorder } from './recorder.js';
import type { DesktopStep } from './desktop.js';

export type ActionKind =
  | 'click' | 'dblclick' | 'hover' | 'drag' | 'fill' | 'type' | 'select' | 'check' | 'uncheck' | 'press' | 'download' | 'upload'
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
  /** wait: what the element or text must become (default visible). */
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
  /** wait: until the page made no request for half a second. */
  network?: boolean;
  /** Element actions: the target closest to this text (a table row, a card), or "dialog" for the open dialog. */
  within?: string;
  /** drag: where to drop, by ref, selector or text. */
  toRef?: string;
  toSelector?: string;
  toText?: string;
  /** login steps: password source, login ID in that source, and whether to press Enter after filling. */
  source?: string;
  item?: string;
  /** login: the account the user asked for; a saved login for another account is refused. */
  account?: string;
  /** login: the identifier typed instead of the saved login's own (never a secret). */
  username?: string;
  submit?: boolean;
}

export interface Step extends Omit<Action, 'ref'> {
  target?: TargetDescriptor;
  /** drag: the element it was dropped on. */
  toTarget?: TargetDescriptor;
  /** do: 'desktop' steps act on a native app instead of the browser. */
  desktop?: DesktopStep;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tabs = new Map<string, Page>();
/** Last address and browser of tabs no longer driven, to tell the agent why when it calls them again, or open the page again. */
const goneTabs = new Map<string, { url: string; browser: string }>();
let nextTab = 1;

interface ConsoleEntry { level: 'error' | 'warning' | 'info' | 'pageerror'; text: string; at: string }
interface PageState {
  console: ConsoleEntry[];
  unseenErrors: number;
  dialogs: string[];
  nextDialog?: { accept: boolean; value?: string };
  /** Browser the tab lives in ("agent", "brave"...) and whether it is driven through the extension. */
  browser: string;
  /** The window of the user's browser the tab is in, by the id its extension gives it ("W7"; its name with 2.2.0). */
  window?: string;
  /** That window's name, for people ("Cloudflare"). */
  windowName?: string;
  viaExtension: boolean;
  /**
   * The agent ran JavaScript in this tab. Kept for the tab's whole life: a window it opened from the page
   * outlives a reload and could read the next document of the same site.
   */
  agentJs?: boolean;
  /** fl_login is filling this tab, or filled a password or code in its current document. */
  loginRunning?: boolean;
  secretFilled?: boolean;
  /** Rocketwright opened this tab itself (not a tab of the user it took over): closing it takes nothing from the user. */
  openedByAgent?: boolean;
  /** Tabs this page opened (a link with target=_blank, window.open), driven since, not told to the agent yet. */
  popups?: string[];
  /** Requests of the page still waiting for an answer, and when the last one started or ended (wait network). */
  inflight?: number;
  netAt?: number;
}
const states = new WeakMap<Page, PageState>();
/** The agent's JavaScript could read a filled secret in a form no masking recognizes (base64, sent to another site). */
export function assertNoSecret(page: Page, what: string) {
  const s = stateOf(page);
  if (s.loginRunning) throw new Error(`Blocked: fl_login is filling this tab. ${what} is refused meanwhile.`);
  if (s.secretFilled) {
    throw new Error(`Blocked: this page holds a password, code or secret Rocketwright filled or captured. ${what} is refused until the tab loads another page (after signing in, or with a goto).`);
  }
}

/** fl_login refuses a tab the agent ran JavaScript in: a listener there would catch the value as it is filled. */
export function agentRanJs(page: Page): boolean {
  return !!stateOf(page).agentJs;
}

/** Marks the tab while fl_login works in it: scripts and screenshots wait for the end, they are refused. */
export function loginRunning(page: Page, on: boolean) {
  stateOf(page).loginRunning = on;
  if (on) void secretNear(page);
}

export function markSecretFilled(page: Page) {
  stateOf(page).secretFilled = true;
  void secretNear(page);
}

/** Told when a password, code or secret is about to be filled or shown in a tab (a trace or video of it is dropped). */
const secretListeners = new Set<(page: Page) => Promise<void>>();
export function onSecret(fn: (page: Page) => Promise<void>) { secretListeners.add(fn); }
function secretNear(page: Page): Promise<void> {
  return Promise.allSettled([...secretListeners].map((fn) => fn(page))).then(() => {});
}

/** Waits until nothing records the tab any more: called before a password, code or secret is filled in it. */
export function beforeSecret(page: Page): Promise<void> {
  return secretNear(page);
}

/** Whether Rocketwright is filling, or the tab shows, a password, code or secret (a network rule then stands aside). */
export function secretInTab(page: Page): boolean {
  const s = stateOf(page);
  return !!(s.loginRunning || s.secretFilled);
}

/** Refuses when any tab Rocketwright drives in this browser holds a secret: a trace records them all. */
export function assertNoSecretIn(ctx: BrowserContext, what: string) {
  for (const page of tabs.values()) if (!page.isClosed() && page.context() === ctx) assertNoSecret(page, what);
}

/** How many tabs Rocketwright still drives in this browser. */
export function drivenIn(ctx: BrowserContext): number {
  return [...tabs.values()].filter((p) => !p.isClosed() && p.context() === ctx).length;
}

/** A network rule (fl_mock) can change what the page runs, or stop its scripts: the same as running JavaScript there. */
export function markAgentJs(page: Page) {
  stateOf(page).agentJs = true;
}

// Sites a secret was just captured from: a page of theirs the agent drives, now or later, is closed to scripts and
// screenshots until it loads another page, since the secret may still be on screen.
const sealedHosts = new Map<string, number>();
const SEAL_MS = 5 * 60_000;
const hostOfPage = (page: Page) => { try { return new URL(page.url()).hostname; } catch { return ''; } };
function sealIfCaptured(page: Page) {
  const at = sealedHosts.get(hostOfPage(page));
  if (at && Date.now() - at < SEAL_MS) markSecretFilled(page);
}

/** A secret was captured from this site: its driven pages are closed to scripts and screenshots until they change page. */
export function sealSite(host: string) {
  sealedHosts.set(host, Date.now());
  for (const page of tabs.values()) if (!page.isClosed()) sealIfCaptured(page);
}

/** The browser a tab lives in, and whether it is driven through the extension. */
export function pageBrowser(page: Page): { browser: string; viaExtension: boolean } {
  const s = stateOf(page);
  return { browser: s.browser, viaExtension: s.viaExtension };
}

function stateOf(page: Page): PageState {
  let s = states.get(page);
  if (!s) states.set(page, (s = { console: [], unseenErrors: 0, dialogs: [], browser: AGENT, viaExtension: false }));
  return s;
}

function logConsole(page: Page, level: ConsoleEntry['level'], text: string) {
  const s = stateOf(page);
  // Masked before it is cut: a cut password would no longer be recognized.
  s.console.push({ level, text: redact(text).slice(0, 2000), at: new Date().toISOString().slice(11, 23) });
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
  sealIfCaptured(page);
  page.on('close', () => {
    goneTabs.set(id, { url: page.url(), browser: stateOf(page).browser });
    tabs.delete(id);
  });
  // A new document: the secrets filled in the previous one are gone (the agent's scripts may not be, see agentJs),
  // unless a secret was just captured from or pasted into this site: the next page may show it again.
  page.on('domcontentloaded', () => { stateOf(page).secretFilled = false; sealIfCaptured(page); });
  page.on('request', (r) => recorder.onRequest(r));
  const net = (d: number) => { const s = stateOf(page); s.inflight = Math.max(0, (s.inflight || 0) + d); s.netAt = Date.now(); };
  page.on('request', () => net(1));
  page.on('requestfinished', () => net(-1));
  page.on('requestfailed', () => net(-1));
  page.on('response', (r) => recorder.onResponse(r));
  page.on('console', (m) => {
    const t = m.type();
    const level = t === 'error' ? 'error' : t === 'warning' ? 'warning' : 'info';
    const where = m.location();
    logConsole(page, level, level === 'info' || !where.url ? m.text() : `${m.text()} (${where.url.slice(0, 160)}:${where.lineNumber})`);
  });
  page.on('pageerror', (e) => logConsole(page, 'pageerror', e.message));
  page.on('dialog', (d) => void onDialog(page, d));
  // A tab this page opens (a link with target=_blank, window.open) is driven at once, and told with the next answer.
  page.on('popup', (popup) => {
    if (popup.isClosed() || idOf(popup)) return;
    const child = register(popup, where);
    stateOf(popup).openedByAgent = true;
    (stateOf(page).popups ??= []).push(child);
  });
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
  for (const child of s.popups?.splice(0) ?? []) {
    const opened = tabs.get(child);
    if (!opened || opened.isClosed()) continue;
    const url = opened.url();
    // Its address may carry a one-time token (a sign-in link): masked here and in everything after.
    rememberUrlTokens(url);
    notes.push(`New tab ${child} [${s.browser}] opened by this page, now driven: ${domainProblem(url) ? '(a site outside the allowed list: close it with fl_close)' : maskUrl(url)}. Read it with fl_snapshot {tab:"${child}"}.`);
  }
  if (s.unseenErrors) {
    notes.push(`${s.unseenErrors} new console error${s.unseenErrors > 1 ? 's' : ''}, see fl_console`);
    s.unseenErrors = 0;
  }
  const other = s.viaExtension ? getRelayClient()?.takeWarning(page.url()) : undefined;
  if (other) {
    notes.push(`Warning: another extension (${other === '1password' || other === 'aeblfdkhhhdcdjpifhhbdiojplfjncoa' ? '1Password' : 'not Rocketwright'}) put its own frame in this page. The browser may now stop Rocketwright from driving this tab: ask the user to set that extension's "Site access" to "On click" (brave://extensions or chrome://extensions, Details), then fl_reopen opens the page again in a fresh tab. A secret this page shows can still be stored with fl_capture_secret.`);
  }
  return notes;
}

/** In a user browser: open the tab in this window (id from fl_extension tabs), or in a new window. */
export interface Placement {
  /** A window's name (given by the extension, see fl_tabs all:true), or its number. */
  window?: number | string;
  /** The window is the one this conversation was in, not one just asked for: when the user keeps the agent to
   * another window, or that window is gone, the tab goes where it would have gone without it. */
  kept?: boolean;
  newWindow?: boolean;
  /** One more tab of a site already open in the user's browser, on purpose (see openTab). */
  evenIfSiteOpen?: boolean;
  /** The address about to be opened: the new tab goes next to the user's tabs of that site. */
  near?: string;
  /** A browser profile of this computer that is not open may be opened for this tab (the user asked for it). */
  launch?: boolean;
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
        ...(typeof placement.window === 'number' ? { flintrailWindowId: placement.window } : {}),
        ...(typeof placement.window === 'string' ? { rocketwrightWindow: placement.window } : {}),
        ...(placement.kept ? { rocketwrightWindowKept: true } : {}),
        ...(placement.newWindow ? { flintrailNewWindow: true } : {}),
        ...(placement.near ? { flintrailNear: placement.near } : {}),
      };
      const made = (await cdp.send('Target.createTarget', params)) as WindowFields;
      const page = await waitPage;
      await cdp.detach().catch(() => {});
      setWindow(page, made);
      return page;
    } catch (e) {
      // A tab asked for a given window must not silently land elsewhere.
      if (placed) throw e;
    }
  }
  return ctx.newPage();
}

/** The site of a web address ("https://example.com"), or '' for anything else. */
function siteOf(address: string): string {
  try {
    const origin = new URL(address).origin;
    return /^https?:/.test(origin) ? origin : '';
  } catch {
    return '';
  }
}

/** Where a tab of this conversation was before fl_open brought it to another page of its site. */
const reusedFrom = new Map<string, string>();

/** The address a tab was on when the last fl_open reused it, told once to the agent: the page it held is gone. */
export function takeReusedFrom(id: string): string | undefined {
  const from = reusedFrom.get(id);
  reusedFrom.delete(id);
  return from;
}

/** The tab of this conversation showing this site in this browser, if any. */
function ownTabOn(where: Driven, site: string): { id: string; page: Page } | null {
  for (const [id, page] of tabs) {
    if (!page.isClosed() && stateOf(page).browser === where.name && siteOf(page.url()) === site) return { id, page };
  }
  return null;
}

/**
 * The window of each user browser this conversation works in, once the agent named one (the user said "work in
 * Docix"): its next tabs open there without naming it again. Until a window is named, tabs open as they always
 * did: the user's own tab of the site is taken over wherever it is, and a new one goes next to it.
 */
const boundWindows = new Map<string, string>();

/** A window of a user browser as the relay tells it: its id ("W7") and its name. */
interface WindowFields { rocketwrightWindow?: string; rocketwrightWindowName?: string }

function setWindow(page: Page, w: WindowFields | null | undefined) {
  if (typeof w?.rocketwrightWindow !== 'string' || !w.rocketwrightWindow) return;
  stateOf(page).window = w.rocketwrightWindow;
  stateOf(page).windowName = w.rocketwrightWindowName || w.rocketwrightWindow;
}

/** How a window is told: its id, and its name when it has one of its own (W7 "Cloudflare"). */
export function windowLabel(key: string, name?: string): string {
  return name && name.toLowerCase() !== key.toLowerCase() ? `${key} "${name}"` : key;
}

/** The window a tab is in (W7 "Cloudflare"): '' in the dedicated browser, or with an extension that names none. */
export function tabWindow(id: string): string {
  const s = stateOf(getTab(id));
  return s.window ? windowLabel(s.window, s.windowName) : '';
}

/** A tab of a user browser as the extension lists it. */
interface ListedTab { id?: number; window?: number; windowKey?: string; windowName?: string; origin?: string; title?: string; attached?: boolean }

const inWindow = (t: ListedTab, wanted: string) => {
  const w = wanted.toLowerCase();
  return (t.windowKey || '').toLowerCase() === w || (t.windowName || '').toLowerCase() === w;
};

/** The window this conversation was told to work in, while the browser still has it: forgotten once it is closed,
 * so the conversation opens its tabs as it did before any window was named. */
async function keptWindow(where: Driven): Promise<string | undefined> {
  const kept = boundWindows.get(where.name);
  if (kept === undefined) return undefined;
  const listed = await getRelayClient()?.request('tabs', { key: where.name }, 5000).catch(() => null) as ListedTab[] | null | undefined;
  // No answer is no proof the window is gone: the extension decides when the tab opens.
  if (!Array.isArray(listed) || listed.some((t) => inWindow(t, kept))) return kept;
  boundWindows.delete(where.name);
  return undefined;
}

/** A free tab of this site in the named window of the user's browser, by its number there: null when none. */
async function freeTabIn(where: Driven, windowName: string, site: string): Promise<number | null> {
  const listed = await getRelayClient()?.request('tabs', { key: where.name }, 5000).catch(() => null) as ListedTab[] | null | undefined;
  if (!Array.isArray(listed)) return null;
  const found = listed.find((t) => typeof t.id === 'number' && !t.attached && t.origin === site && inWindow(t, windowName));
  return found?.id ?? null;
}

/** The windows of the user's browser showing this site, by id (those with a free tab of it first): [] when none or unknown. */
async function windowsWithSite(where: Driven, site: string): Promise<string[]> {
  const listed = await getRelayClient()?.request('tabs', { key: where.name }, 5000).catch(() => null) as ListedTab[] | null | undefined;
  if (!Array.isArray(listed)) return [];
  const on = listed.filter((t) => t.origin === site && (t.windowKey || t.windowName));
  on.sort((a, b) => Number(!!a.attached) - Number(!!b.attached));
  return [...new Set(on.map((t) => (t.windowKey || t.windowName)!))];
}

/**
 * Is this site already open in the user's browser? Asked to the extension, which sees every tab of the
 * profile, driven or not. An extension too old to list its tabs, or a relay that does not answer, leaves only
 * the tabs this process drives: the user's other tabs are then not seen and the new tab is let through.
 */
async function siteOpenIn(where: Driven, site: string): Promise<boolean> {
  const listed = await getRelayClient()?.request('tabs', { key: where.name }, 5000).catch(() => null) as { origin?: string }[] | null | undefined;
  if (Array.isArray(listed)) return listed.some((tab) => tab.origin === site);
  return where.ctx.pages().some((page) => !page.isClosed() && siteOf(page.url()) === site);
}

/** Opens a tab in the named browser (see getDriven), optionally on a URL. */
export async function openTab(url?: string, browserName?: string, placement: Placement = {}, reuse = true): Promise<string> {
  const where = await getDriven(browserName, { launch: placement.launch });
  if ((placement.window !== undefined || placement.newWindow) && !where.viaExtension) {
    throw new Error('window and newWindow apply to the user\'s browsers only (set browser, see fl_extension).');
  }
  const wanted = url && where.viaExtension ? siteOf(url) : '';
  // A new window is asked for, but this conversation already works in one, or the site is open in one: that
  // window is used, so one task never ends up spread over several windows the user has to tell apart.
  let said = '';
  if (where.viaExtension && placement.newWindow && placement.window === undefined && !placement.evenIfSiteOpen) {
    const kept = await keptWindow(where);
    const own = wanted ? ownTabOn(where, wanted) : null;
    const open = kept || !wanted ? [] : await windowsWithSite(where, wanted);
    const there = kept ?? (own ? stateOf(own.page).window : undefined) ?? open[0];
    if (there !== undefined) {
      said = kept
        ? `No new window: this conversation already works in window ${there}, the tab is there.`
        : `No new window: ${wanted} is already open in window ${there}, its tab was used.`;
      placement = { ...placement, newWindow: false, window: there };
    }
  }
  // A window named by the agent is where this conversation works from now on; without one, it stays in the
  // window its tabs went to before.
  if (typeof placement.window === 'string') boundWindows.set(where.name, placement.window);
  const bound = where.viaExtension && placement.window === undefined && !placement.newWindow ? await keptWindow(where) : undefined;
  const windowName = typeof placement.window === 'string' ? placement.window : bound;
  const id = await openIn(where, url, placement, reuse, wanted, windowName);
  const s = stateOf(getTab(id));
  if (s.viaExtension && s.window) {
    // From now on, by its id: renaming the window does not lose it. A new window becomes this conversation's window.
    if (windowName !== undefined || placement.newWindow) boundWindows.set(where.name, s.window);
  }
  if (said) openNotes.set(id, said);
  return id;
}

/** What fl_open did differently from what was asked, told once with its answer. */
const openNotes = new Map<string, string>();
export function takeOpenNote(id: string): string | undefined {
  const note = openNotes.get(id);
  openNotes.delete(id);
  return note;
}

async function openIn(where: Driven, url: string | undefined, placement: Placement, reuse: boolean, wanted: string, windowName: string | undefined): Promise<string> {
  // In a user browser, asking for one more tab or window of a site already open there is refused: the user
  // finds their site open several times and has to clean up. The tab already there is the one to use.
  if (wanted && (!reuse || placement.newWindow) && !placement.evenIfSiteOpen) {
    const own = ownTabOn(where, wanted);
    if (own || (await siteOpenIn(where, wanted))) {
      throw new Error(
        `${wanted} is already open in ${where.name}${own ? ` (tab ${own.id} of this conversation)` : ''}: use that tab instead of opening one more. ` +
          'fl_open without newTab or newWindow takes it over and brings it to the address, fl_adopt takes a tab by its address, ' +
          'and fl_act {do:"goto"} moves a tab you already drive. Pass evenIfSiteOpen:true only when two pages of this site ' +
          'have to stay open together, or when the user asked for another tab.'
      );
    }
  }
  // In a user browser, a tab already showing this address (or a page under it) is taken over rather than
  // opening one more tab: the user does not end up with the same site open ten times.
  if (url && reuse && where.viaExtension && windowName !== undefined) {
    assertAllowed(url);
    // In its window, the conversation takes the tab it already drives on that site, else a free tab of the
    // site there, and only then opens one more: a tab of the same site in another window is someone else's work.
    const own = wanted && !placement.evenIfSiteOpen ? ownTabOn(where, wanted) : null;
    const ownWin = own ? stateOf(own.page) : null;
    if (own && [ownWin?.window, ownWin?.windowName].some((w) => w?.toLowerCase() === windowName.toLowerCase())) {
      reusedFrom.set(own.id, own.page.url());
      await gotoFast(own.page, url);
      recorder.onOpen(url);
      return own.id;
    }
    const free = wanted && !placement.evenIfSiteOpen ? await freeTabIn(where, windowName, wanted) : null;
    if (free !== null) {
      const id = await adoptTabById(free, where.name);
      await gotoFast(getTab(id), url);
      recorder.onOpen(url);
      return id;
    }
  } else if (url && reuse && where.viaExtension && placement.window === undefined && !placement.newWindow) {
    assertAllowed(url);
    // The same page (or one under it) as it is; else a tab of the same site, brought to the page asked for.
    const same = await takeOver(where, url.replace(/[?#].*$/, '').replace(/\/+$/, ''), 'prefix').catch(() => null);
    if (same) return register(same, where);
    // A tab this conversation already drives on that site goes to the page asked for: no second tab of it.
    const own = wanted && !placement.evenIfSiteOpen ? ownTabOn(where, wanted) : null;
    if (own) {
      reusedFrom.set(own.id, own.page.url());
      await gotoFast(own.page, url);
      recorder.onOpen(url);
      return own.id;
    }
    let origin = '';
    try { origin = new URL(url).origin; } catch { /* not a web address: a new tab below */ }
    const site = /^https?:/.test(origin) ? await takeOver(where, origin, 'origin').catch(() => null) : null;
    if (site) {
      const id = register(site, where);
      await gotoFast(site, url);
      recorder.onOpen(url);
      return id;
    }
  }
  // In a named window the tab goes there, not next to the user's tabs of the site in another window.
  const placed: Placement = windowName !== undefined ? { ...placement, window: windowName, kept: typeof placement.window !== 'string' } : placement;
  const page = await newPage(where, url && where.viaExtension && windowName === undefined ? { ...placed, near: url } : placed);
  const id = register(page, where);
  stateOf(page).openedByAgent = true;
  if (url) {
    await gotoFast(page, url);
    recorder.onOpen(url);
  }
  return id;
}

/** Take over a tab the user already has open, for example one where they just signed in by hand. */
export async function adoptTab(match: string, browserName?: string, mode: MatchMode = 'contains'): Promise<string> {
  const where = await getDriven(browserName);
  const page = await takeOver(where, match, mode);
  if (!page) throw new Error(`No open tab in ${where.name} whose URL contains "${match}"${where.viaExtension ? ' that this conversation may take: it is driven by another conversation, or the extension is older than 1.5 (share the tab from the Rocketwright popup then)' : ''}.`);
  return register(page, where);
}

/** Take over a tab of a user browser by the id fl_tabs all:true listed (the browser's own tab id). */
export async function adoptTabById(tabId: number, browserName?: string): Promise<string> {
  const where = await getDriven(browserName);
  if (!where.viaExtension) throw new Error('id names a tab of one of the user\'s browsers (from fl_tabs all:true). In the dedicated browser, use url.');
  const owned = new Set(tabs.values());
  const claimed = await getRelayClient()?.request('claim', { key: where.name, tabId }) as ({ url?: string } & WindowFields) | null | undefined;
  if (!claimed) throw new Error(`No tab #${tabId} in ${where.name} that this conversation may take: closed, driven by another conversation, or a browser page. List them again with fl_tabs all:true.`);
  let page: Page | undefined;
  for (let i = 0; !page && i < 50; i++) {
    const fresh = where.ctx.pages().filter((p) => !owned.has(p) && !p.isClosed());
    page = fresh.find((p) => p.url() === claimed.url) ?? (fresh.length === 1 ? fresh[0] : undefined);
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) throw new Error(`Tab #${tabId} of ${where.name} was handed over but did not show up: try fl_adopt again.`);
  assertAllowed(page.url());
  setWindow(page, claimed);
  return register(page, where);
}

/** A tab open in this browser whose address contains match, now driven by this conversation; null when there is none. */
async function takeOver(where: Driven, match: string, mode: MatchMode = 'contains'): Promise<Page | null> {
  const owned = new Set(tabs.values());
  const free = () => where.ctx.pages().filter((p) => !owned.has(p) && !p.isClosed() && urlMatches(p.url(), match, mode)).at(-1);
  let page = free();
  // In a user browser, a tab the user shared from the extension belongs to no conversation until one
  // claims it: the relay then hands it to this process only.
  if (!page && where.viaExtension) {
    const claimed = await getRelayClient()?.request('claim', { key: where.name, match, mode }) as WindowFields | null | undefined;
    for (let i = 0; claimed && !page && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      page = free();
    }
    if (page) setWindow(page, claimed);
  }
  if (page) assertAllowed(page.url());
  return page ?? null;
}

/**
 * Stops driving a tab of the user's browser without closing it: the user keeps it, another conversation may
 * take it over, and the browser's debugging bar goes away once no tab is driven.
 */
export async function releaseTab(id: string) {
  const page = getTab(id);
  const where = await getDriven(stateOf(page).browser);
  if (!where.viaExtension || !where.browser) throw new Error(`Tab ${id} is in the dedicated browser: close it with fl_close.`);
  const cdp = await where.browser.newBrowserCDPSession();
  try {
    // A command of the relay only, outside the CDP protocol types: it finds the tab by its address now.
    const send = cdp.send.bind(cdp) as (method: string, params: Record<string, unknown>) => Promise<unknown>;
    await send('Rocketwright.releaseTarget', { url: page.url() });
  } finally {
    await cdp.detach().catch(() => {});
  }
  for (let i = 0; i < 50 && !page.isClosed(); i++) await new Promise((r) => setTimeout(r, 100));
  tabs.delete(id);
}

/** The id this conversation drives a page under, if it does. */
export function idOf(page: Page): string | undefined {
  for (const [id, p] of tabs) if (p === page && !p.isClosed()) return id;
  return undefined;
}

/** The pages this conversation drives in one browser. */
export function drivenPages(browserName: string): { id: string; page: Page }[] {
  return [...tabs].filter(([, p]) => !p.isClosed() && stateOf(p).browser === browserName).map(([id, page]) => ({ id, page }));
}

/**
 * The addresses of the tabs open in a browser, driven or not, as far as Rocketwright may know them: every page of the
 * dedicated browser, and the site (origin) of each tab of a user browser (its extension never says more).
 */
export async function openOrigins(browserName: string): Promise<string[]> {
  const where = await getDriven(browserName);
  if (!where.viaExtension) return where.ctx.pages().filter((p) => !p.isClosed()).map((p) => siteOf(p.url())).filter(Boolean);
  const listed = await getRelayClient()?.request('tabs', { key: where.name }, 5000) as { origin?: string }[] | undefined;
  return (listed || []).map((t) => String(t.origin || '')).filter(Boolean);
}

/** Stops driving a tab without closing it: released in a user browser, simply forgotten in the dedicated one. */
export async function letGo(id: string) {
  const page = tabs.get(id);
  if (!page || page.isClosed()) return;
  if (stateOf(page).viaExtension) await releaseTab(id);
  else tabs.delete(id);
}

/**
 * Opens the page of a tab again in a fresh tab of the same browser: a tab another extension cut off, one released or
 * closed, or one where the agent ran JavaScript (fl_login and secrets refuse those). Returns the new tab id.
 */
export async function reopenTab(id: string): Promise<string> {
  const live = tabs.get(id);
  const was = live && !live.isClosed() ? { url: live.url(), browser: stateOf(live).browser } : goneTabs.get(id);
  if (!was) throw new Error(`Tab ${id} was never driven by this conversation: use fl_open with the address.`);
  if (!/^https?:/.test(was.url)) throw new Error(`Tab ${id} was on ${was.url.slice(0, 80) || 'a blank page'}, which cannot be opened again: use fl_open with the address.`);
  assertAllowed(was.url);
  return openTab(was.url, was.browser, { evenIfSiteOpen: true }, false);
}

/** Done with a tab replaced by a fresh one: closed when Rocketwright opened it, else given back to the user (released). */
export async function retireTab(id: string): Promise<'closed' | 'released'> {
  const page = tabs.get(id);
  if (!page || page.isClosed()) return 'closed';
  if (stateOf(page).openedByAgent) {
    await page.close();
    return 'closed';
  }
  await letGo(id);
  return 'released';
}

/** Browser a Rocketwright tab lives in. */
export function tabBrowser(id: string): string {
  return stateOf(getTab(id)).browser;
}

export function getTab(id: string): Page {
  const p = tabs.get(id);
  if (!p || p.isClosed()) {
    const url = p ? p.url() : goneTabs.get(id)?.url;
    const why = url ? getRelayClient()?.lostReason(url) : undefined;
    if (why) throw new Error(`Tab ${id} is no longer driven: ${why}. fl_reopen {tab:"${id}"} opens its page again in a fresh tab.`);
    throw new Error(`Tab ${id} not found: closed, released by the extension after 5 minutes without use, or debugging cancelled from the browser's bar (the reason is in ~/.rocketwright/relay.log). Use fl_reopen to open its page again in a fresh tab, fl_open, or fl_adopt to take an open tab back.`);
  }
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
  await withDeadline(page.mainFrame().evaluate(domQuietScript, { idle, quiet, max }), max + 3000).catch(() => {});
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

/** Rejects with a TimeoutError-like error when work takes longer than ms (the work itself goes on, its result dropped). */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(ms)), ms); });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
export class DeadlineError extends Error {
  constructor(readonly ms: number) { super(`no answer within ${ms / 1000} s`); }
}

// A frame whose script context never reached Rocketwright (an embedded page of another site, most often) would
// leave a read waiting forever: past these delays it is told, never waited for.
const FRAME_READ_MS = 4000;
const PAGE_READ_MS = 15000;

// Defaults kept short: the agent raises max or text, or narrows with within, when it needs more.
const SNAP_MAX = 100;
const SNAP_TEXT = 400;

export async function snapshot(page: Page, opts: { max?: number; text?: number; diff?: boolean; within?: string } = {}): Promise<string> {
  const away = domainProblem(page.url());
  if (away) return `Blocked: nothing was read from this tab. ${away} Close it with fl_close.`;
  // An embedded frame of a site outside the user's list is not read either.
  // Each frame keeps its index in page.frames(): a ref "f2:e1" must lead back to that very frame.
  const frames = page.frames().map((frame, index) => ({ frame, index }))
    .filter(({ frame, index }) => !frame.isDetached() && (index === 0 || readableFrame(frame))).slice(0, 6);
  // Frames are read in parallel: one round trip instead of one per frame.
  const silent: string[] = [];
  const reads = await Promise.all(frames.map(({ frame, index }) => withDeadline(frame.evaluate(snapshotScript, {
    max: index === 0 ? opts.max ?? SNAP_MAX : 40,
    text: index === 0 ? opts.text ?? SNAP_TEXT : 0,
    prefix: index === 0 ? '' : `f${index}:`,
    within: opts.within,
    // A secret Rocketwright put in this page: no field shows its value, even one the site re-rendered.
    hideValues: !!stateOf(page).secretFilled,
  }), index === 0 ? PAGE_READ_MS : FRAME_READ_MS).catch((e) => {
    if (e instanceof DeadlineError) silent.push(index === 0 ? 'page' : `frame ${index} (${maskUrl(frame.url()).slice(0, 80)})`);
    return null;
  })));
  if (silent.includes('page')) {
    throw new Error(`The page in this tab did not answer within ${PAGE_READ_MS / 1000} s: Rocketwright never got to run its reader in it (the page may be frozen, or its scripts never reached Rocketwright). fl_reopen opens the page again in a fresh tab; if that hangs too, tell the user.`);
  }
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
  for (const what of silent) notes.push(`Not read: ${what} did not answer within ${FRAME_READ_MS / 1000} s, skipped.`);
  if (!head) {
    lastSeen.delete(page);
    return [...notes, `URL: ${page.url()} (page not readable yet)`].join('\n');
  }
  const seen: Seen = {
    url: head.url, title: head.title, max: opts.max ?? SNAP_MAX, text: opts.text ?? SNAP_TEXT, more: head.more, scope: head.scope || '',
    heads: head.heads, lines: [...head.lines, ...extra], body: head.body,
  };
  const before = lastSeen.get(page);
  lastSeen.set(page, seen);
  const delta = opts.diff && before ? changesSince(before, seen) : null;
  if (delta) return [...notes, ...delta].join('\n');
  const out = [...notes, `URL: ${head.url}`, `Title: ${head.title}`, ...(head.scope ? [head.scope] : []), ...head.heads, '', ...seen.lines];
  if (head.more) out.push(`(list truncated at ${seen.max} elements: raise max, or narrow with within: "some text" or "dialog")`);
  if (head.body) out.push('', 'Text: ' + head.body);
  return out.join('\n');
}

/** What the agent last received about a tab: the next snapshot can be told as a difference from it. */
interface Seen { url: string; title: string; max: number; text: number; more: boolean; scope: string; heads: string[]; lines: string[]; body: string }
const lastSeen = new WeakMap<Page, Seen>();

const refOfLine = (line: string) => /^\[([^\]]+)\]/.exec(line)?.[1];

/**
 * The changes between two snapshots of the same page, or null when a full snapshot is the better answer:
 * another page, other options, a truncated list, or so many changes that a difference saves nothing.
 * Refs are stable on a page (an element keeps its ref for as long as it lives), so unchanged lines can be left out.
 */
function changesSince(before: Seen, now: Seen): string[] | null {
  if (before.url !== now.url || before.max !== now.max || before.text !== now.text || before.scope !== now.scope || before.more || now.more) return null;
  // Embedded frames added, removed or sent to another address: the frame headers carry that, so tell the whole page.
  const frames = (seen: Seen) => seen.lines.filter((l) => !refOfLine(l)).join('\n');
  if (frames(before) !== frames(now)) return null;
  const old = new Map<string, string>();
  for (const line of before.lines) {
    const ref = refOfLine(line);
    if (ref) old.set(ref, line);
  }
  const changes: string[] = [];
  const kept: string[] = [];
  let same = 0;
  for (const line of now.lines) {
    const ref = refOfLine(line);
    if (!ref) continue;
    const was = old.get(ref);
    if (was !== undefined) kept.push(ref);
    if (was === line) same++;
    else changes.push(`${was === undefined ? '+' : '~'} ${line}`);
  }
  // A difference cannot say where things are: when the elements that stayed changed order (a sorted list), tell the whole page.
  const still = new Set(kept);
  if (before.lines.map(refOfLine).filter((r): r is string => !!r && still.has(r)).join(' ') !== kept.join(' ')) return null;
  for (const [ref, line] of old) if (!still.has(ref)) changes.push(`- ${line}`);
  const goneHeads = before.heads.filter((h) => !now.heads.includes(h));
  const headsChanged = before.heads.join('\n') !== now.heads.join('\n');
  const bodyChanged = before.body !== now.body;
  const full = now.lines.length + now.heads.length + (now.body ? 1 : 0);
  const told = changes.length + (headsChanged ? Math.max(1, now.heads.length + goneHeads.length) : 0) + (bodyChanged ? 1 : 0);
  const out = [`URL: ${now.url}`];
  if (before.title !== now.title) out.push(`Title: ${now.title}`);
  if (!told) {
    // Only what a snapshot shows was compared: the listed elements, the headings and the first characters of text.
    out.push(`No change since the last snapshot of this tab in the elements, headings and text it shows (${same} element${same === 1 ? '' : 's'}, same refs).`);
    return out;
  }
  // Past half of the page, the whole page is as short and easier to read.
  if (told * 2 > full) return null;
  out.push(`Changes since the last snapshot of this tab (+ new, ~ changed, - gone). ${same} other element${same === 1 ? '' : 's'} unchanged, same refs.`);
  if (headsChanged) out.push(...now.heads, ...goneHeads.map((h) => `- ${h}`));
  out.push(...changes);
  if (bodyChanged) out.push('', textChange(before.body, now.body));
  return out;
}

/** The words of the page text that are new or gone, each run with a few words around it; the whole text when most of it changed. */
function textChange(before: string, now: string): string {
  if (!now) return 'Text: none left.';
  const a = before ? before.split(' ') : [];
  const b = now.split(' ');
  // Words the two texts share at both ends are set aside first: the comparison below then stays small.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const fresh: boolean[] = new Array<boolean>(b.length).fill(false);
  const gone: string[] = [];
  if (am.length * bm.length > 250_000) {
    // Too long to compare word by word without stalling every tab: the middle is told whole.
    for (let j = 0; j < bm.length; j++) fresh[head + j] = true;
  } else {
    // Longest common subsequence of words: what is left of `now` is new, what is left of `before` is gone.
    const lcs: number[][] = Array.from({ length: am.length + 1 }, () => new Array<number>(bm.length + 1).fill(0));
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        lcs[i]![j] = am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) { i++; j++; } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) gone.push(am[i++]!); else fresh[head + j++] = true;
    }
    while (i < am.length) gone.push(am[i++]!);
    while (j < bm.length) fresh[head + j++] = true;
  }
  const count = fresh.filter(Boolean).length;
  if (count * 2 > b.length) return 'Text: ' + now;
  const wentAway = gone.length ? `Text, words gone: ${gone.slice(0, 60).join(' ')}${gone.length > 60 ? '…' : ''}` : '';
  if (!count) return wentAway || 'Text: unchanged words, spacing aside.';
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
  return 'Text, new words in [brackets]: ' + parts.join('  ') + (wentAway ? '\n' + wentAway : '');
}

/** Drops what a tab was last told as: its next snapshot is the whole page. For a snapshot whose text is not returned to the agent. */
export function forgetSnapshot(page: Page) {
  lastSeen.delete(page);
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
    throw new Error('Blocked: with ROCKETWRIGHT_ALLOWED_DOMAINS set, a selector cannot enter a frame. Use the refs of that frame from the snapshot.');
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
export async function performOn(page: Page, loc: Locator, a: Step, vars?: Record<string, string>, dest?: Locator | null): Promise<{ download?: string }> {
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
    // Never Rocketwright's own files (saved sessions, its token, the dedicated browser's profile): they would hand a
    // site the user's sign-ins.
    const own = [config.home, config.profileDir].map((d) => { try { return realpathSync(d); } catch { return d; } });
    const inside = files.find((f) => { const r = realpathSync(f); return own.some((d) => r === d || r.startsWith(d + sep)); });
    if (inside) throw new Error(`Refused: ${inside} is one of Rocketwright's own files (sessions, token, browser profile), never uploaded.`);
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
      case 'drag':
        if (!dest) throw new Error('drag needs where to drop: toRef, toSelector or toText.');
        return loc.dragTo(dest, { timeout: TIMEOUT });
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
    case 'wait': {
      const timeout = a.ms || 15000;
      const state = a.state || 'visible';
      // An element (ref, selector, role, label, placeholder) or a text, until it shows up or goes away.
      const ref = (a as Action).ref;
      const live = ref || a.selector || a.role || a.label || a.placeholder ? liveLocator(page, { ...a, ref, text: undefined } as Action) : null;
      if (live) await live.loc.first().waitFor({ state, timeout });
      else if (a.text) await page.getByText(fillVars(a.text, vars)!).first().waitFor({ state, timeout });
      else if (a.url) await page.waitForURL(new RegExp(fillVars(a.url, vars)!), { timeout });
      else if (a.network) {
        // Half a second with no request waiting, counted from now: a click just before has had time to start its own.
        const end = Date.now() + timeout;
        await sleep(100);
        for (;;) {
          const s = stateOf(page);
          if (!s.inflight && Date.now() - (s.netAt || 0) >= 500) break;
          if (Date.now() > end) throw new Error(`the page still had ${s.inflight || 0} request(s) waiting after ${timeout} ms`);
          await sleep(100);
        }
      }
      else await sleep(a.ms || 1000);
      return undefined;
    }
    case 'eval': {
      assertNoSecret(page, 'Running JavaScript');
      stateOf(page).agentJs = true;
      const body = fillVars(a.js, vars) || 'return null';
      return page.evaluate(`(async () => { ${body} })()`);
    }
    case 'request': {
      assertNoSecret(page, 'A request from the page');
      stateOf(page).agentJs = true;
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
        throw new Error('Blocked: the site answered with a redirect, which is not followed while ROCKETWRIGHT_ALLOWED_DOMAINS is set. Request the final address directly.');
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

/** The open modal dialog, the one on top. */
const DIALOGS = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]';

/**
 * Among the elements a target matches, the one closest to a text: each climbs its ancestors until one shows the
 * text, the fewest steps wins ("Delete" in the row that says "my-token", not in the row below). "dialog": the
 * match inside the dialog opened last.
 */
async function closestTo(matches: Locator, within: string): Promise<Locator> {
  // Only what the user can see: a hidden dialog's button is never the closest one.
  const all = matches.filter({ visible: true });
  const count = Math.min(await all.count(), 60);
  if (!count) throw new Error('No element matches that target.');
  const wanted = within.trim().toLowerCase();
  const distances: number[] = [];
  for (let i = 0; i < count; i++) {
    distances.push(await all.nth(i).evaluate((el, { wanted, dialogs }) => {
      if (wanted === 'dialog') {
        const open = [...document.querySelectorAll(dialogs)].filter((d) => (d as HTMLElement).offsetParent !== null || getComputedStyle(d).position === 'fixed');
        const modal = (d: Element) => d.getAttribute('aria-modal') === 'true' || (() => { try { return d.matches(':modal'); } catch { return false; } })();
        const top = open.filter(modal).at(-1) || open.at(-1);
        return top && top.contains(el) ? 0 : -1;
      }
      let steps = 0;
      for (let node: Element | null = el; node; node = node.parentElement, steps++) {
        if (((node as HTMLElement).innerText || '').toLowerCase().includes(wanted)) return steps;
      }
      return -1;
    }, { wanted, dialogs: DIALOGS }, { timeout: 3000 }).catch(() => -1));
  }
  const found = distances.filter((d) => d >= 0);
  if (!found.length) throw new Error(wanted === 'dialog' ? 'No match inside an open dialog.' : `No match near the text "${within}".`);
  const best = Math.min(...found);
  const ties = distances.flatMap((d, i) => (d === best ? [i] : []));
  if (ties.length > 1 && wanted !== 'dialog') throw new Error(`${ties.length} matches are as close to "${within}": give a longer text, or a ref from the snapshot.`);
  return all.nth(ties[0]!);
}

const needsElement = (a: Action) =>
  !PAGE_ACTIONS.has(a.do) && !(a.do === 'press' && !a.ref && !a.selector && !a.role && !a.text && !a.label && !a.placeholder);

/** Batched live actions: one round trip for a whole sequence, then one fresh snapshot. */
export async function act(page: Page, actions: Action[], opts: { snapshot?: boolean; max?: number; text?: number; diff?: boolean; within?: string } = {}) {
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
        if (recorder.active && a.do === 'wait' && a.ref) notes.push(`#${i} note: a wait on a ref is replayed as a plain pause; wait on a selector, role or text to keep it in the flow.`);
        if (v !== undefined) notes.push(`#${i} ${a.do} -> ${JSON.stringify(v).slice(0, 4000)}`);
        continue;
      }
      const live = liveLocator(page, a);
      if (!live) throw new Error('No target given (ref, selector, role, text, label or placeholder).');
      if (a.within && a.ref) throw new Error('within narrows a role, text, label, placeholder or selector target; a ref is already exact.');
      let loc = a.within ? await closestTo(live.loc, a.within) : live.loc.first();
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
      // drag: the element to drop on, found like any target.
      let dest: Locator | null = null;
      let destTarget: TargetDescriptor | undefined;
      if (a.do === 'drag') {
        const to = liveLocator(page, { do: 'click', ref: a.toRef, selector: a.toSelector, text: a.toText } as Action);
        if (!to) throw new Error('drag needs where to drop: toRef, toSelector or toText.');
        dest = to.loc.first();
        destTarget = await dest.evaluate(describeScript, undefined, { timeout: 3000 }).catch(() => undefined);
        if (destTarget && to.frame !== page.mainFrame()) destTarget.frameUrl = to.frame.url().split('?')[0];
      }
      // A link that opens another tab: the new tab is waited for, so this answer already names it.
      const opensTab = (a.do === 'click' || a.do === 'dblclick') && await loc.evaluate((el) => {
        const link = el.closest('a[href]');
        const target = (link?.getAttribute('target') || '').toLowerCase();
        return !!link && !!target && !['_self', '_parent', '_top'].includes(target);
      }, undefined, { timeout: 2000 }).catch(() => false);
      const popup = opensTab ? page.waitForEvent('popup', { timeout: 5000 }).catch(() => null) : null;
      const r = await performOn(page, loc, a, undefined, dest);
      const opened = popup ? await popup : null;
      if (opened) await opened.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      if (recorder.active && target) {
        const warn = recorder.addElementStep(page, a, target, destTarget);
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
  return (notes.length ? notes.join('\n') + '\n\n' : '') + (await snapshot(page, { max: opts.max, text: opts.text, within: opts.within, diff: opts.diff !== false }));
}
