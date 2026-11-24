// Shared extension relay (daemon). One small process, started by the first Flintrail that needs it, owns
// the relay port for every conversation on this computer:
//
//   Flintrail A ──/client──┐                          ┌──/extension── Brave "IdéeKdo"  (chrome.debugger)
//   Flintrail B ──/client──┼──▶ relay daemon ◀───────┼──/extension── Brave "Perso"
//   Playwright A ──/cdp/<secret>─┘ (one view per       └──/extension── Chrome
//   Playwright B ──/cdp/<secret>─┘  client and browser)
//
// Each Flintrail process is a client: it gets its own private CDP endpoint per browser, and only sees the
// tabs it opened, or a tab the user shared from the extension and it claimed (fl_adopt). The daemon does
// not belong to any conversation: closing one never cuts the others off. It exits by itself once no
// Flintrail has been connected for a while (FLINTRAIL_RELAY_IDLE_MS, 10 minutes by default).
//
// Security: it listens on 127.0.0.1 only and refuses requests coming from a web page (Origin header).
// Clients and extensions prove they know the token in ~/.flintrail/token with an HMAC over a fresh nonce,
// and the daemon proves it back, so the token itself never travels and a process squatting the port
// learns nothing.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { config } from './config.js';
import { installNativeHost } from './pairing.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileOfInstance, profileReadProblems } from './profiles.js';
import { macFor, macMatches, RELAY_PROTOCOL, slug, urlMatches, type BrowserInfo, type MatchMode } from './relay-protocol.js';
import { VERSION } from './version.js';

interface Tab {
  tabId: number;
  sessionId: string;
  targetInfo: Record<string, unknown> & { targetId: string; url?: string };
  /** The view (client + browser) driving this tab. null: shared by the user, not claimed yet. */
  owner: CdpView | null;
  /** Page.getFrameTree calls still unanswered: the tab's events wait for them (see onDebuggerEvent). */
  frameTreesPending?: number;
  heldEvents?: Record<string, unknown>[];
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface Hello {
  token?: string;
  mac?: string;
  cnonce?: string;
  version?: string;
  userAgent?: string;
  browser?: string;
  instance?: string;
  label?: string;
  /** The browser profile's name: found by the relay (src/profiles.ts), else as the extension's pairing host read it. */
  profile?: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

// Browser-level sessions (Playwright opens one per Target.attachToBrowserTarget, several at once when tabs
// open in parallel): each gets its own id, or answers meant for one reach another and Playwright aborts.
const BROWSER_SESSION = 'flintrail-browser';
let browserSessions = 0;
const isBrowserSession = (sessionId: string | undefined) => !sessionId || sessionId === BROWSER_SESSION || sessionId.startsWith(BROWSER_SESSION + '-');

/** "Google Chrome" -> chrome, "Microsoft Edge" -> edge, "Brave" -> brave. */
/**
 * The name each browser got the first time it connected, kept in ~/.flintrail/browsers.json: a browser keeps
 * its name whatever the order browsers connect in, and keeps its profile name when the profiles cannot be read.
 */
class BrowserNames {
  private file = join(config.home, 'browsers.json');
  private names: Record<string, { key: string; profile?: string }> = {};

  constructor() {
    try { if (existsSync(this.file)) this.names = JSON.parse(readFileSync(this.file, 'utf8')); } catch { this.names = {}; }
  }

  get(instance: string) { return this.names[instance]; }

  /** Names other browsers already hold, connected or not. */
  takenBy(key: string, instance: string) {
    return Object.entries(this.names).some(([id, n]) => id !== instance && n.key === key);
  }

  set(instance: string, key: string, profile: string) {
    const was = this.names[instance];
    if (was && was.key === key && (was.profile || '') === profile) return;
    this.names[instance] = { key, ...(profile ? { profile } : {}) };
    try {
      mkdirSync(config.home, { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.names, null, 2) + '\n');
    } catch (e) {
      log(`could not save browser names: ${(e as Error).message}`);
    }
  }
}

function browserKey(brand: string | undefined): string {
  const b = (brand || 'chromium').toLowerCase();
  if (b.includes('edge')) return 'edge';
  if (b.includes('chrome')) return 'chrome';
  if (b.includes('opera') || b.includes('opr')) return 'opera';
  return slug(b) || 'chromium';
}

/** A web page can open a WebSocket to 127.0.0.1: it always sends its http(s) origin, an extension or Node does not. */
function fromWebPage(req: IncomingMessage): boolean {
  return /^https?:/i.test(String(req.headers.origin || ''));
}

/** One Flintrail process connected to the daemon. */
class ClientConn {
  readonly id = randomBytes(6).toString('hex');
  lastActive = Date.now();
  private demoWaiters = new Map<number, (text: string) => void>();
  private nextDemo = 1;

  constructor(readonly ws: WebSocket, readonly pid: number) {}

  send(message: Record<string, unknown>) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  /** Forwards a demonstration request from the extension, waits for the recorder's answer. */
  demo(action: string, extra: Record<string, unknown>): Promise<string> {
    const reqId = this.nextDemo++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.demoWaiters.delete(reqId); resolve('Error: Flintrail did not answer.'); }, 4000);
      this.demoWaiters.set(reqId, (text) => { clearTimeout(timer); resolve(text); });
      this.send({ type: 'demo', reqId, action, ...extra });
    });
  }

  demoResult(reqId: number, text: string) {
    this.demoWaiters.get(reqId)?.(text);
    this.demoWaiters.delete(reqId);
  }
}

/** What one client sees of one browser: its own CDP endpoint and its own tabs. */
class CdpView {
  readonly path = '/cdp/' + randomBytes(16).toString('hex');
  ws: WebSocket | null = null;
  autoAttach = false;

  constructor(readonly bridge: ExtensionBridge, readonly client: ClientConn) {}
}

/** How long a browser whose extension dropped its connection keeps its tabs and the agents' connections. */
const EXTENSION_GRACE_MS = 60 * 1000;

/** handleCdp already sent the reply itself (in order with the events it held back). */
const HANDLED = Symbol('handled');

/** One line in relay.log: when tabs are lost, it says why. */
const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);

/** One connected browser extension, shared by every client. */
class ExtensionBridge {
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private nextTab = 1;
  private tabsBySession = new Map<string, Tab>();
  private tabsById = new Map<number, Tab>();
  private childSessions = new Map<string, number>();
  readonly views = new Set<CdpView>();
  /** The client that last drove this browser: it receives the recordings made by demonstration. */
  lastClient: ClientConn | null = null;
  private demoClient: ClientConn | null = null;
  /** Running while the extension is away: it expires the bridge unless the extension comes back. */
  private grace: NodeJS.Timeout | null = null;
  private backWaiters: (() => void)[] = [];

  constructor(readonly key: string, readonly instance: string, readonly info: Hello, private ext: WebSocket, readonly legacy: boolean,
    private readonly relay: ExtensionRelay) {}

  get connected() { return this.ext.readyState === WebSocket.OPEN; }

  /** Disconnected, but expected back within the grace period. */
  get reconnecting() { return !!this.grace; }

  /** The relay stops: no timer keeps it alive. */
  stop() { if (this.grace) { clearTimeout(this.grace); this.grace = null; } }

  describe(): BrowserInfo {
    return {
      key: this.key, label: this.info.label || '', profile: this.info.profile || '', browser: this.info.browser || 'browser',
      version: this.info.version || '?', legacy: this.legacy,
    };
  }

  /** The extension reconnected (service worker restart, dropped socket): keep the name, the tabs and the agents' connections. */
  replaceSocket(ws: WebSocket) {
    const old = this.ext;
    this.ext = ws;
    if (this.grace) { clearTimeout(this.grace); this.grace = null; }
    if (old !== ws && old.readyState === WebSocket.OPEN) old.close(4000, 'replaced');
    this.backWaiters.splice(0).forEach((back) => back());
  }

  /** The same browser came back under another name: drop this one. */
  retire() {
    const ws = this.ext;
    this.expire('renamed');
    ws.close(4000, 'renamed');
  }

  /** The extension's socket closed. True when the browser is gone for good (extension 1.3 has no reconnection). */
  closed(ws: WebSocket, code: number, reason: string): boolean {
    if (this.ext !== ws) return false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('extension disconnected')); }
    this.pending.clear();
    if (this.legacy) { this.expire(`disconnected (${code})`); return true; }
    log(`${this.key}: extension disconnected (${code}${reason ? ` ${reason}` : ''}), its tabs are kept ${EXTENSION_GRACE_MS / 1000} s`);
    this.grace = setTimeout(() => {
      this.grace = null;
      this.expire('did not come back');
      this.relay.forget(this);
    }, EXTENSION_GRACE_MS);
    return false;
  }

  /** The extension is back: tabs it no longer drives (closed, or released meanwhile) are dropped. */
  keepOnly(tabIds: number[]) {
    const kept = new Set(tabIds);
    const lost = [...this.tabsById.keys()].filter((id) => !kept.has(id));
    for (const tabId of lost) this.dropTab(tabId);
    // Still attached in the browser, but nobody drives them here any more (conversation closed meanwhile,
    // relay restarted): release them, or the debugging bar would stay.
    const orphans = tabIds.filter((id) => !this.tabsById.has(id));
    if (orphans.length) this.request('release', { tabIds: orphans }, 5000).catch(() => {});
    log(`${this.key}: extension back, ${this.tabsById.size} tab(s) kept${lost.length ? `, ${lost.length} lost` : ''}${orphans.length ? `, ${orphans.length} released` : ''}`);
  }

  private expire(why: string) {
    if (this.grace) { clearTimeout(this.grace); this.grace = null; }
    if (this.tabsById.size || this.views.size) log(`${this.key}: ${why}, ${this.tabsById.size} tab(s) and ${this.views.size} agent connection(s) released`);
    this.tabsBySession.clear();
    this.tabsById.clear();
    this.childSessions.clear();
    for (const view of this.views) view.ws?.close();
    this.views.clear();
    this.backWaiters.splice(0).forEach((back) => back());
  }

  async request(method: string, params: Record<string, unknown>, timeout = 30000): Promise<any> {
    // Reconnecting: the extension usually comes back within seconds, wait for it rather than fail.
    if (!this.connected && this.grace) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 15000);
        this.backWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    if (!this.connected) throw new Error(`${this.key}: extension not connected`);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.key}: extension timeout on ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ext.send(JSON.stringify({ id, method, params }));
    });
  }

  send(message: Record<string, unknown>) {
    if (this.connected) this.ext.send(JSON.stringify(message));
  }

  async onExtensionMessage(m: any) {
    if (typeof m.id === 'number' && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String(m.error))); else p.resolve(m.result);
      return;
    }
    switch (m.type) {
      case 'event': return this.onDebuggerEvent(m.tabId, m.sessionId, m.method, m.params);
      case 'detached': {
        const tab = this.tabsById.get(m.tabId);
        if (tab) {
          const reason = String(m.reason || 'unknown');
          log(`${this.key}: tab ${m.tabId} detached (${reason})`);
          // The conversation that drove it learns why, for its next call on that tab.
          tab.owner?.client.send({ type: 'tabLost', url: String(m.url || tab.targetInfo.url || ''), reason });
        }
        return this.dropTab(m.tabId);
      }
      case 'tabClosed': return this.dropTab(m.tabId);
      case 'foreignExtension': {
        const tab = this.tabsById.get(m.tabId);
        // An extension id or "1password", nothing else: the page cannot slip its own words into the warning.
        const id = /^([a-p]{32}|1password)$/.test(String(m.id)) ? String(m.id) : 'unknown';
        const warning = { url: String(m.url || tab?.targetInfo.url || ''), id };
        this.foreign.set(Number(m.tabId), warning);
        if (this.foreign.size > 200) this.foreign.delete(this.foreign.keys().next().value!);
        if (tab) log(`${this.key}: tab ${m.tabId}: another extension (${id}) put its frame in the page`);
        tab?.owner?.client.send({ type: 'tabWarning', ...warning });
        return;
      }
      case 'attached': return this.keepOnly(Array.isArray(m.tabIds) ? m.tabIds.map(Number) : []);
      case 'shared': { this.addTab(m.tabId, m.targetInfo, null); return; }
      case 'recorded': {
        this.demoClient?.send({ type: 'recorded', step: m.step });
        return;
      }
      case 'demo': {
        let text: string;
        if (m.action === 'start') {
          const client = this.relay.recordingTarget(this);
          this.demoClient = client;
          text = client
            ? await client.demo('start', { name: m.name, url: m.url })
            : 'Error: no Flintrail conversation is running. Start your agent first.';
          if (text.startsWith('Error')) this.demoClient = null;
        } else {
          const client = this.demoClient;
          this.demoClient = null;
          text = client ? await client.demo('stop', {}) : 'Error: no recording in progress.';
        }
        this.send({ type: 'demoResult', reqId: m.reqId, text });
        return;
      }
      case 'ping': this.send({ type: 'pong' }); return;
    }
  }

  private addTab(tabId: number, targetInfo: Tab['targetInfo'], owner: CdpView | null): Tab {
    const existing = this.tabsById.get(tabId);
    if (existing) return existing;
    const tab: Tab = { tabId, sessionId: `flintrail-tab-${this.nextTab++}`, targetInfo, owner };
    this.tabsBySession.set(tab.sessionId, tab);
    this.tabsById.set(tabId, tab);
    if (owner?.autoAttach) this.announce(tab);
    return tab;
  }

  private announce(tab: Tab) {
    this.toView(tab.owner, {
      method: 'Target.attachedToTarget',
      params: { sessionId: tab.sessionId, targetInfo: { ...tab.targetInfo, attached: true }, waitingForDebugger: false },
    });
    // Another extension was already in that page before the agent took it: said from the start.
    // Only if the tab still shows that page: another page since then holds nothing of the kind.
    const foreign = this.foreign.get(tab.tabId);
    if (foreign && foreign.url === String(tab.targetInfo.url || '')) tab.owner?.client.send({ type: 'tabWarning', ...foreign });
  }

  /** Tabs where another extension put its frame (a password manager), even before an agent drives them. */
  private foreign = new Map<number, { url: string; id: string }>();

  private dropTab(tabId: number) {
    const tab = this.tabsById.get(tabId);
    if (!tab) return;
    this.tabsById.delete(tabId);
    this.tabsBySession.delete(tab.sessionId);
    this.foreign.delete(tabId);
    for (const [sid, t] of this.childSessions) if (t === tabId) this.childSessions.delete(sid);
    this.toView(tab.owner, { method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetInfo.targetId } });
  }

  private onDebuggerEvent(tabId: number, childSession: string | undefined, method: string, params: any) {
    const tab = this.tabsById.get(tabId);
    if (!tab) return;
    if (method === 'Target.attachedToTarget' && params?.sessionId) this.childSessions.set(params.sessionId, tabId);
    if (method === 'Target.detachedFromTarget' && params?.sessionId) this.childSessions.delete(params.sessionId);
    if (method === 'Target.targetInfoChanged' && !childSession && params?.targetInfo?.targetId === tab.targetInfo.targetId) {
      tab.targetInfo = params.targetInfo;
    }
    const event = { method, params, sessionId: childSession || tab.sessionId };
    // chrome.debugger answers commands asynchronously, so the execution contexts Runtime.enable reports can
    // arrive before the frame tree asked for just before it. Playwright then ignores them as belonging to
    // unknown frames and waits forever for a context: hold the tab's events until the frame tree is answered.
    if (tab.frameTreesPending) (tab.heldEvents ??= []).push(event);
    else this.toView(tab.owner, event);
  }

  /** Gives a tab the user shared (URL containing match) to this client. */
  async claim(client: ClientConn, match: string, mode: MatchMode = 'contains'): Promise<{ url: string } | null> {
    const view = this.viewOf(client);
    const shared = [...this.tabsById.values()].filter((t) => !t.owner && urlMatches(String(t.targetInfo.url || ''), match, mode)).at(-1);
    if (shared) {
      shared.owner = view;
      if (view.autoAttach) this.announce(shared);
      return { url: String(shared.targetInfo.url || '') };
    }
    // Not shared: the extension may hand over a tab the user has open, as its settings allow (older extensions do not).
    if (this.legacy) return null;
    let found: { tabId?: number | null; targetInfo?: Tab['targetInfo']; refused?: string };
    try {
      found = await this.request('adoptTab', { match, mode }, 10000);
    } catch (e) {
      if (/Unknown method adoptTab/.test((e as Error).message)) return null;
      throw e;
    }
    if (found.refused) throw new Error(`Refused by the Flintrail extension settings in ${this.key}: ${found.refused}.`);
    if (typeof found.tabId !== 'number' || !found.targetInfo) return null;
    const tab = this.addTab(found.tabId, found.targetInfo, view);
    log(`${this.key}: tab ${found.tabId} taken over by a conversation`);
    return { url: String(tab.targetInfo.url || '') };
  }

  /** The connected view of this client on this browser. */
  viewOf(client: ClientConn): CdpView {
    const view = [...this.views].find((v) => v.client === client && v.ws);
    if (!view) throw new Error(`${this.key}: connect to this browser first.`);
    return view;
  }

  // ---------- Playwright side ----------

  openView(client: ClientConn): CdpView {
    const view = new CdpView(this, client);
    this.views.add(view);
    // Playwright failed to connect to it: forget it rather than keep a dead endpoint.
    setTimeout(() => { if (!view.ws) this.views.delete(view); }, 30000).unref();
    return view;
  }

  onCdp(view: CdpView, ws: WebSocket) {
    if (view.ws) { ws.close(4409, 'view already in use'); return; }
    view.ws = ws;
    ws.on('message', async (raw: RawData) => {
      let m: CdpMessage;
      try { m = JSON.parse(String(raw)); } catch { return; }
      view.client.lastActive = Date.now();
      this.lastClient = view.client;
      try {
        const result = await this.handleCdp(view, m);
        if (result !== HANDLED) this.toView(view, { id: m.id, sessionId: m.sessionId, result: result ?? {} });
      } catch (e) {
        this.toView(view, { id: m.id, sessionId: m.sessionId, error: { code: -32000, message: (e as Error).message } });
      }
      if (m.method === 'Target.setAutoAttach' && isBrowserSession(m.sessionId)) {
        for (const tab of this.tabsBySession.values()) if (tab.owner === view) this.announce(tab);
      }
    });
    ws.on('close', () => this.closeView(view));
  }

  /** The client went away: release its tabs in the browser (the user keeps them open, no longer driven), and leave the other clients' tabs alone. */
  closeView(view: CdpView) {
    if (!this.views.delete(view)) return;
    view.ws?.close();
    const released: number[] = [];
    for (const tab of [...this.tabsById.values()]) {
      if (tab.owner !== view) continue;
      released.push(tab.tabId);
      this.tabsById.delete(tab.tabId);
      this.tabsBySession.delete(tab.sessionId);
      for (const [sid, t] of this.childSessions) if (t === tab.tabId) this.childSessions.delete(sid);
    }
    // Extension 1.3 has no per-tab release: its own idle timer detaches the tabs after 5 minutes.
    if (released.length && !this.legacy && this.connected) this.request('release', { tabIds: released }, 5000).catch(() => {});
  }

  private toView(view: CdpView | null, m: Record<string, unknown>) {
    if (view?.ws?.readyState === WebSocket.OPEN) view.ws.send(JSON.stringify(m));
  }

  private ownedTab(view: CdpView, sessionId: string): Tab | undefined {
    const tab = this.tabsBySession.get(sessionId);
    return tab?.owner === view ? tab : undefined;
  }

  private async handleCdp(view: CdpView, m: CdpMessage): Promise<unknown> {
    const { method = '', params = {}, sessionId } = m;
    if (!sessionId || isBrowserSession(sessionId)) return this.browserCommand(view, method, params);
    const tab = this.ownedTab(view, sessionId);
    if (tab && method === 'Page.getFrameTree') {
      tab.frameTreesPending = (tab.frameTreesPending || 0) + 1;
      try {
        const tree = await this.request('send', { tabId: tab.tabId, method, params });
        this.toView(view, { id: m.id, sessionId, result: tree ?? {} });
        return HANDLED;
      } finally {
        if (!--tab.frameTreesPending) for (const event of tab.heldEvents?.splice(0) ?? []) this.toView(tab.owner, event);
      }
    }
    if (tab) return this.request('send', { tabId: tab.tabId, method, params });
    const owner = this.childSessions.get(sessionId);
    if (owner !== undefined && this.tabsById.get(owner)?.owner === view) return this.request('send', { tabId: owner, sessionId, method, params });
    throw new Error(`Unknown session ${sessionId}`);
  }

  private async browserCommand(view: CdpView, method: string, params: Record<string, unknown>): Promise<unknown> {
    const own = () => [...this.tabsBySession.values()].filter((t) => t.owner === view);
    switch (method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: 'Chrome/Flintrail-Extension', revision: '', userAgent: this.info.userAgent || '', jsVersion: '' };
      case 'Target.setAutoAttach':
        view.autoAttach = true;
        return {};
      case 'Target.attachToBrowserTarget':
        return { sessionId: `${BROWSER_SESSION}-${++browserSessions}` };
      case 'Target.getTargetInfo':
        return { targetInfo: { targetId: 'flintrail-browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
      case 'Target.getTargets':
        return { targetInfos: own().map((t) => ({ ...t.targetInfo, attached: true })) };
      case 'Target.createTarget': {
        // Window choice sent by Flintrail along with the command: an existing window, or a new one.
        const placement = {
          ...(typeof params.flintrailWindowId === 'number' ? { windowId: params.flintrailWindowId } : {}),
          ...(params.flintrailNewWindow === true ? { newWindow: true } : {}),
        };
        if (Object.keys(placement).length && this.legacy) {
          throw new Error(`${this.key}: extension ${this.info.version} cannot pick a window, reload it in this browser to update it.`);
        }
        const near = typeof params.flintrailNear === 'string' ? { near: params.flintrailNear } : {};
        const r = await this.request('createTab', { url: params.url || 'about:blank', ...placement, ...near });
        if (!this.views.has(view)) {
          // The client left while the tab was opening: nobody will drive it.
          if (!this.legacy) this.request('release', { tabIds: [r.tabId] }, 5000).catch(() => {});
          throw new Error('client disconnected');
        }
        const tab = this.addTab(r.tabId, r.targetInfo, view);
        return { targetId: tab.targetInfo.targetId };
      }
      case 'Flintrail.releaseTarget': {
        // fl_release: this conversation stops driving the tab, the user keeps it open. The tab may have moved
        // since it was taken: the extension says which of this conversation's tabs is at that address now.
        const mine = own();
        const found = this.legacy ? null : await this.request('tabAt', { tabIds: mine.map((t) => t.tabId), url: String(params.url || '') }, 5000) as { tabIds?: number[] };
        const at = mine.filter((t) => found?.tabIds?.includes(t.tabId));
        if (at.length !== 1) throw new Error(at.length ? 'two tabs of this conversation are on that address: close one with fl_close' : 'no such tab of this conversation');
        const tab = at[0]!;
        this.dropTab(tab.tabId);
        if (!this.legacy) await this.request('release', { tabIds: [tab.tabId] }, 5000);
        return {};
      }
      case 'Target.closeTarget': {
        const tab = own().find((t) => t.targetInfo.targetId === params.targetId);
        if (tab) await this.request('closeTab', { tabId: tab.tabId });
        return { success: !!tab };
      }
      case 'Target.getBrowserContexts':
        return { browserContextIds: [] };
      default:
        // Browser-level domains (downloads, permissions, window bounds) are not exposed to extensions.
        return {};
    }
  }
}

export class ExtensionRelay {
  private server: Server | null = null;
  private bridges = new Map<string, ExtensionBridge>();
  private clients = new Set<ClientConn>();
  private idleTimer: NodeJS.Timeout | null = null;
  private names = new BrowserNames();

  constructor(private readonly token: string, readonly port: number, readonly version: string,
    private readonly idleMs: number, private readonly onIdle: () => void) {}

  /** Connected browsers, by name (brave, brave-ideekdo, chrome ...). */
  list(): ExtensionBridge[] {
    return [...this.bridges.values()].filter((b) => b.connected);
  }

  /** A browser by name, or by the label the user gave it in the extension. */
  get(key: string): ExtensionBridge | undefined {
    const k = key.trim().toLowerCase();
    const s = slug(k);
    // A browser reconnecting is still found: its requests wait for it to come back.
    const all = [...this.bridges.values()].filter((b) => b.connected || b.reconnecting);
    return all.find((b) => b.key === k)
      || all.find((b) => b.info.label && slug(b.info.label) === s)
      || all.find((b) => b.info.profile && slug(b.info.profile) === s);
  }

  start(): Promise<void> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.server = createServer((_req, res) => { res.writeHead(404).end(); });
    this.server.on('upgrade', (req, socket, head) => {
      const path = (req.url || '').split('?')[0];
      if (fromWebPage(req)) { socket.destroy(); return; }
      if (path === '/extension') { wss.handleUpgrade(req, socket, head, (ws) => this.onExtension(ws)); return; }
      if (path === '/client') { wss.handleUpgrade(req, socket, head, (ws) => this.onClient(ws)); return; }
      for (const bridge of this.bridges.values()) {
        const view = [...bridge.views].find((v) => v.path === path);
        if (view) { wss.handleUpgrade(req, socket, head, (ws) => bridge.onCdp(view, ws)); return; }
      }
      socket.destroy();
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => { this.armIdle(); resolve(); });
    });
  }

  close() {
    this.server?.close();
    for (const b of this.bridges.values()) b.stop();
    for (const c of this.clients) c.ws.close();
  }

  /** A browser whose extension did not come back. */
  forget(bridge: ExtensionBridge) {
    if (this.bridges.get(bridge.key) === bridge) this.bridges.delete(bridge.key);
    this.broadcastBrowsers();
  }

  /** Who gets a recording made by demonstration in this browser: whoever drove it last, else the most recent client. */
  recordingTarget(bridge: ExtensionBridge): ClientConn | null {
    if (bridge.lastClient && this.clients.has(bridge.lastClient)) return bridge.lastClient;
    return [...this.clients].sort((a, b) => b.lastActive - a.lastActive)[0] || null;
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = this.clients.size ? null : setTimeout(this.onIdle, this.idleMs);
  }

  private broadcastBrowsers() {
    const browsers = this.list().map((b) => b.describe());
    for (const c of this.clients) c.send({ type: 'browsers', browsers });
  }

  // ---------- Flintrail clients ----------

  private onClient(ws: WebSocket) {
    const nonce = randomBytes(16).toString('hex');
    let client: ClientConn | null = null;
    const kick = setTimeout(() => { if (!client) ws.close(4401, 'no hello'); }, 5000);
    ws.send(JSON.stringify({ type: 'challenge', nonce, version: this.version, protocol: RELAY_PROTOCOL }));
    ws.on('message', async (raw: RawData) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!client) {
        if (m.type !== 'hello' || !macMatches(this.token, 'client:' + nonce, String(m.mac || ''))) { ws.close(4401, 'bad token'); return; }
        clearTimeout(kick);
        client = new ClientConn(ws, Number(m.pid) || 0);
        this.clients.add(client);
        this.armIdle();
        ws.send(JSON.stringify({
          type: 'welcome', mac: macFor(this.token, 'relay:' + String(m.cnonce || '')), version: this.version, protocol: RELAY_PROTOCOL,
          clients: this.clients.size, browsers: this.list().map((b) => b.describe()),
        }));
        return;
      }
      if (m.type === 'demoResult') { client.demoResult(Number(m.reqId), String(m.text ?? '')); return; }
      if (typeof m.id !== 'number') return;
      try {
        client.send({ id: m.id, result: await this.clientRequest(client, String(m.method), m.params || {}) });
      } catch (e) {
        client.send({ id: m.id, error: (e as Error).message });
      }
    });
    ws.on('close', () => {
      clearTimeout(kick);
      if (!client) return;
      this.clients.delete(client);
      for (const bridge of this.bridges.values()) {
        for (const view of [...bridge.views]) if (view.client === client) bridge.closeView(view);
      }
      this.armIdle();
    });
  }

  private bridgeFor(key: unknown): ExtensionBridge {
    const bridge = this.get(String(key || ''));
    if (!bridge) throw new Error(`Browser "${key}" is not connected to Flintrail.`);
    return bridge;
  }

  private async clientRequest(client: ClientConn, method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'open': {
        const bridge = this.bridgeFor(p.key);
        return { key: bridge.key, cdpUrl: `ws://127.0.0.1:${this.port}${bridge.openView(client).path}` };
      }
      case 'claim':
        return this.bridgeFor(p.key).claim(client, String(p.match || ''), p.mode === 'prefix' || p.mode === 'origin' ? p.mode : 'contains');
      case 'tabs': {
        const bridge = this.bridgeFor(p.key);
        if (bridge.legacy) throw new Error(`${bridge.key}: extension ${bridge.info.version} cannot list its tabs, reload it to update.`);
        return bridge.request('listTabs', {}, 5000);
      }
      case 'captureSecret': {
        const bridge = this.bridgeFor(p.key);
        if (bridge.legacy) throw new Error(`${bridge.key}: extension ${bridge.info.version} cannot capture a secret, reload it to update it.`);
        const { key: _key, ...rest } = p;
        try {
          return await bridge.request('captureSecret', rest, 125_000);
        } catch (e) {
          if (/Unknown method captureSecret/.test((e as Error).message)) throw new Error(`${bridge.key}: its Flintrail extension is too old to capture a secret, reload it to update it.`);
          throw e;
        }
      }
      case 'pastePolicy': {
        // Always the user's click: an extension that cannot ask (too old) refuses.
        const bridge = this.bridgeFor(p.key);
        if (bridge.legacy) return { refused: 'this extension is too old to ask you, reload it to update it' };
        const { key: _key, ...rest } = p;
        return bridge.request('pastePolicy', rest, 125_000);
      }
      case 'fillRules': {
        const bridge = this.bridgeFor(p.key);
        if (bridge.legacy) return {};
        return bridge.request('fillRules', {}, 5000);
      }
      case 'fillPolicy':
      case 'fillAudit': {
        // Asked of the extension only: it holds the user's settings, and only the user can answer a confirmation.
        // An extension without settings (1.4.0 and older) is said so explicitly: Flintrail then applies the
        // defaults, while an error (an older relay, say) is a refusal, never a silent fill.
        const bridge = this.bridgeFor(p.key);
        if (bridge.legacy) return { noSettings: true };
        const { key: _key, ...rest } = p;
        try {
          return await bridge.request(method, rest, method === 'fillPolicy' ? 125_000 : 5000);
        } catch (e) {
          if (new RegExp(`Unknown method ${method}`).test((e as Error).message)) return { noSettings: true };
          throw e;
        }
      }
      case 'retire':
        // A newer Flintrail replaces this daemon, only when nobody else depends on it.
        if (this.clients.size > 1) throw new Error('other Flintrail processes still use this relay');
        setImmediate(this.onIdle);
        return { ok: true };
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }

  // ---------- browser extensions ----------

  private onExtension(ws: WebSocket) {
    const nonce = randomBytes(16).toString('hex');
    let bridge: ExtensionBridge | null = null;
    const kick = setTimeout(() => { if (!bridge) ws.close(4401, 'no hello'); }, 5000);
    // Extension 1.4+ answers this challenge. Extension 1.3 ignores it and sends its token in clear.
    ws.send(JSON.stringify({ type: 'challenge', nonce }));
    ws.on('message', async (raw: RawData) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!bridge) {
        const hello = m as Hello;
        const legacy = !hello.mac;
        const ok = m.type === 'hello' && (legacy
          ? macMatches(this.token, 'token', macFor(String(hello.token || ''), 'token'))
          : macMatches(this.token, 'extension:' + nonce, String(hello.mac)));
        if (!ok) { ws.close(4401, 'bad token'); return; }
        clearTimeout(kick);
        bridge = this.register(ws, hello, legacy);
        ws.send(JSON.stringify({
          type: 'welcome', name: bridge.key, recording: null,
          ...(legacy ? {} : { mac: macFor(this.token, 'relay:' + String(hello.cnonce || '')) }),
        }));
        this.broadcastBrowsers();
        return;
      }
      await bridge.onExtensionMessage(m);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(kick);
      if (!bridge) return;
      if (bridge.closed(ws, code, String(reason || ''))) this.forget(bridge);
      else this.broadcastBrowsers();
    });
  }

  private register(ws: WebSocket, hello: Hello, legacy: boolean): ExtensionBridge {
    const instance = String(hello.instance || randomBytes(8).toString('hex'));
    const label = String(hello.label || '').trim().slice(0, 60);
    const same = [...this.bridges.values()].find((b) => b.instance === instance);
    const known = this.names.get(instance);
    const found = profileOfInstance(instance)?.name || String(hello.profile || '').trim().slice(0, 60);
    if (!found && !label) {
      const problems = profileReadProblems();
      if (problems.length) log(`browser profiles not readable here: ${problems.join(', ')}. Names come from ~/.flintrail/browsers.json or the extension popup.`);
    }
    // The profile found now, else the one found on an earlier connection.
    const profile = found || known?.profile || '';
    // Same browser, same name: it keeps its tabs. A new label or a profile found since is a new name.
    if (same && (same.info.label || '') === label && (same.info.profile || '') === profile) {
      log(`${same.key}: extension reconnected (${hello.version || '?'})`);
      // A reloaded extension may be a newer version: what agents are told about it follows.
      Object.assign(same.info, { version: hello.version, userAgent: hello.userAgent, browser: hello.browser });
      same.replaceSocket(ws);
      return same;
    }
    if (same) { this.bridges.delete(same.key); same.retire(); }
    // A name the user gave in the extension wins ("brave-ideekdo"), then the browser profile's own name
    // ("brave-soflution"), then the name this browser got before, then the brand, numbered: brave, brave-2...
    const base = browserKey(hello.browser);
    // A name typed whole ("brave-2", "brave-work") is kept as it is; "Work" becomes brave-work.
    const whole = (n: string) => { const s = slug(n); return s === base || s.startsWith(`${base}-`) ? s : `${base}-${s || 'browser'}`; };
    const taken = (k: string) => [...this.bridges.values()].some((b) => b.key === k && b.instance !== instance) || this.names.takenBy(k, instance);
    const free = (k: string) => {
      if (!taken(k)) return k;
      let n = 2;
      while (taken(`${k}-${n}`)) n++;
      return `${k}-${n}`;
    };
    const defaultKey = free(profile ? whole(profile) : known && known.key.startsWith(base) ? known.key : base);
    const key = label ? free(whole(label)) : defaultKey;
    // Only the name Flintrail gave is kept: clearing the name typed in the popup brings that one back.
    this.names.set(instance, defaultKey, profile);
    const bridge = new ExtensionBridge(key, instance, { ...hello, label, profile, token: undefined }, ws, legacy, this);
    this.bridges.set(key, bridge);
    log(`${key}: extension connected (${hello.browser || 'browser'} ${hello.version || '?'}${profile ? `, profile "${profile}"` : ''})`);
    return bridge;
  }
}

/**
 * Runs this process as the relay daemon. Never resolves: the daemon exits by itself once no Flintrail
 * has been connected for FLINTRAIL_RELAY_IDLE_MS (10 minutes by default), or right away when another
 * daemon already owns the port.
 */
export async function runRelayDaemon(token: string): Promise<never> {
  const idleMs = Number(process.env.FLINTRAIL_RELAY_IDLE_MS || 10 * 60 * 1000);
  const relay = new ExtensionRelay(token, config.relayPort, VERSION, idleMs, () => {
    console.error(`flintrail relay ${VERSION}: no Flintrail connected, exiting.`);
    relay.close();
    process.exit(0);
  });
  try {
    await relay.start();
  } catch (e) {
    // Another daemon won the race to the port: it serves everyone, this one is not needed.
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') process.exit(0);
    throw e;
  }
  installNativeHost(config.dedicatedProfile ? [config.dedicatedProfile] : []);
  console.error(`flintrail relay ${VERSION} (pid ${process.pid}) listening on 127.0.0.1:${config.relayPort}`);
  const stop = () => { relay.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return new Promise<never>(() => {});
}
