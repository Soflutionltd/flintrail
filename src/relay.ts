// Extension relay. The Flintrail browser extension connects here over a local WebSocket and drives tabs
// with chrome.debugger. Playwright connects to a private CDP endpoint on the same server, and the relay
// translates between the two, so the whole engine works unchanged on top of any Chromium browser.
//
//   Playwright ──CDP──▶ /cdp/<secret> ──▶ relay ──JSON──▶ /extension ──▶ chrome.debugger (one tab each)
//
// Only tabs that Flintrail opened, or that the user explicitly shared from the extension, are visible.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { config } from './config.js';
import { recorder } from './recorder.js';
import type { Step } from './engine.js';

interface Tab {
  tabId: number;
  sessionId: string;
  targetInfo: Record<string, unknown> & { targetId: string };
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const BROWSER_SESSION = 'flintrail-browser';

export class ExtensionRelay {
  readonly cdpPath = '/cdp/' + randomBytes(16).toString('hex');
  private server: Server | null = null;
  private ext: WebSocket | null = null;
  private cdp: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private nextTab = 1;
  private tabsBySession = new Map<string, Tab>();
  private tabsById = new Map<number, Tab>();
  private childSessions = new Map<string, number>();
  private autoAttach = false;
  private waiters: (() => void)[] = [];
  info: { userAgent?: string; version?: string; browser?: string } = {};

  constructor(private readonly token: string, readonly port: number) {}

  get connected() { return !!this.ext && this.ext.readyState === WebSocket.OPEN; }
  get cdpUrl() { return `ws://127.0.0.1:${this.port}${this.cdpPath}`; }

  start(): Promise<void> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.server = createServer((_req, res) => { res.writeHead(404).end(); });
    this.server.on('upgrade', (req, socket, head) => {
      const path = (req.url || '').split('?')[0];
      if (path === '/extension') wss.handleUpgrade(req, socket, head, (ws) => this.onExtension(ws));
      else if (path === this.cdpPath) wss.handleUpgrade(req, socket, head, (ws) => this.onCdp(ws));
      else socket.destroy();
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  waitForExtension(ms: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(
        `The Flintrail extension is not connected. Open it in your browser, paste the token from ${config.home}/token and click Connect.`)), ms);
      this.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  // ---------- extension side ----------

  private onExtension(ws: WebSocket) {
    let authed = false;
    const kick = setTimeout(() => { if (!authed) ws.close(4401, 'no hello'); }, 5000);
    ws.on('message', async (raw: RawData) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!authed) {
        if (m.type !== 'hello' || !this.checkToken(String(m.token || ''))) { ws.close(4401, 'bad token'); return; }
        authed = true;
        clearTimeout(kick);
        if (this.ext && this.ext !== ws) this.ext.close(4000, 'replaced');
        this.ext = ws;
        this.info = { userAgent: m.userAgent, version: m.version, browser: m.browser };
        ws.send(JSON.stringify({ type: 'welcome', recording: recorder.status() }));
        this.waiters.splice(0).forEach((w) => w());
        return;
      }
      await this.onExtensionMessage(m);
    });
    ws.on('close', () => {
      if (this.ext !== ws) return;
      this.ext = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('extension disconnected')); }
      this.pending.clear();
      this.tabsBySession.clear();
      this.tabsById.clear();
      this.childSessions.clear();
      this.cdp?.close();
    });
  }

  private checkToken(t: string) {
    const a = Buffer.from(t), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private request(method: string, params: Record<string, unknown>, timeout = 30000): Promise<any> {
    if (!this.connected) return Promise.reject(new Error('extension not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`extension timeout on ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ext!.send(JSON.stringify({ id, method, params }));
    });
  }

  private async onExtensionMessage(m: any) {
    if (typeof m.id === 'number' && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String(m.error))); else p.resolve(m.result);
      return;
    }
    switch (m.type) {
      case 'event': return this.onDebuggerEvent(m.tabId, m.sessionId, m.method, m.params);
      case 'detached':
      case 'tabClosed': return this.dropTab(m.tabId);
      case 'shared': return this.addTab(m.tabId, m.targetInfo);
      case 'recorded': {
        recorder.addDemoStep(m.step as Step);
        return;
      }
      case 'demo': {
        let text: string;
        try {
          text = m.action === 'start' ? recorder.start(m.name, 'Recorded by demonstration', m.url) : recorder.stop(true);
        } catch (e) { text = `Error: ${(e as Error).message}`; }
        this.ext?.send(JSON.stringify({ type: 'demoResult', reqId: m.reqId, text }));
        return;
      }
      case 'ping': this.ext?.send(JSON.stringify({ type: 'pong' })); return;
    }
  }

  private addTab(tabId: number, targetInfo: Tab['targetInfo']): Tab {
    const existing = this.tabsById.get(tabId);
    if (existing) return existing;
    const tab: Tab = { tabId, sessionId: `flintrail-tab-${this.nextTab++}`, targetInfo };
    this.tabsBySession.set(tab.sessionId, tab);
    this.tabsById.set(tabId, tab);
    if (this.autoAttach) this.announce(tab);
    return tab;
  }

  private announce(tab: Tab) {
    this.toCdp({
      method: 'Target.attachedToTarget',
      params: { sessionId: tab.sessionId, targetInfo: { ...tab.targetInfo, attached: true }, waitingForDebugger: false },
    });
  }

  private dropTab(tabId: number) {
    const tab = this.tabsById.get(tabId);
    if (!tab) return;
    this.tabsById.delete(tabId);
    this.tabsBySession.delete(tab.sessionId);
    for (const [sid, t] of this.childSessions) if (t === tabId) this.childSessions.delete(sid);
    this.toCdp({ method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetInfo.targetId } });
  }

  private onDebuggerEvent(tabId: number, childSession: string | undefined, method: string, params: any) {
    const tab = this.tabsById.get(tabId);
    if (!tab) return;
    if (method === 'Target.attachedToTarget' && params?.sessionId) this.childSessions.set(params.sessionId, tabId);
    if (method === 'Target.detachedFromTarget' && params?.sessionId) this.childSessions.delete(params.sessionId);
    if (method === 'Target.targetInfoChanged' && !childSession && params?.targetInfo?.targetId === tab.targetInfo.targetId) {
      tab.targetInfo = params.targetInfo;
    }
    this.toCdp({ method, params, sessionId: childSession || tab.sessionId });
  }

  // ---------- Playwright side ----------

  private onCdp(ws: WebSocket) {
    if (this.cdp) this.cdp.close();
    this.cdp = ws;
    this.autoAttach = false;
    ws.on('message', async (raw: RawData) => {
      let m: CdpMessage;
      try { m = JSON.parse(String(raw)); } catch { return; }
      try {
        const result = await this.handleCdp(m);
        this.toCdp({ id: m.id, sessionId: m.sessionId, result: result ?? {} });
      } catch (e) {
        this.toCdp({ id: m.id, sessionId: m.sessionId, error: { code: -32000, message: (e as Error).message } });
      }
      if (m.method === 'Target.setAutoAttach' && (!m.sessionId || m.sessionId === BROWSER_SESSION)) {
        for (const tab of this.tabsBySession.values()) this.announce(tab);
      }
    });
    ws.on('close', () => {
      if (this.cdp === ws) this.cdp = null;
      if (this.connected) this.request('releaseAll', {}, 5000).catch(() => {});
    });
  }

  private toCdp(m: Record<string, unknown>) {
    if (this.cdp?.readyState === WebSocket.OPEN) this.cdp.send(JSON.stringify(m));
  }

  private async handleCdp(m: CdpMessage): Promise<unknown> {
    const { method = '', params = {}, sessionId } = m;
    if (!sessionId || sessionId === BROWSER_SESSION) return this.browserCommand(method, params);
    const tab = this.tabsBySession.get(sessionId);
    if (tab) return this.request('send', { tabId: tab.tabId, method, params });
    const owner = this.childSessions.get(sessionId);
    if (owner !== undefined) return this.request('send', { tabId: owner, sessionId, method, params });
    throw new Error(`Unknown session ${sessionId}`);
  }

  private async browserCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: 'Chrome/Flintrail-Extension', revision: '', userAgent: this.info.userAgent || '', jsVersion: '' };
      case 'Target.setAutoAttach':
        this.autoAttach = true;
        return {};
      case 'Target.attachToBrowserTarget':
        return { sessionId: BROWSER_SESSION };
      case 'Target.getTargetInfo':
        return { targetInfo: { targetId: 'flintrail-browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
      case 'Target.getTargets':
        return { targetInfos: [...this.tabsBySession.values()].map((t) => ({ ...t.targetInfo, attached: true })) };
      case 'Target.createTarget': {
        const r = await this.request('createTab', { url: params.url || 'about:blank', background: params.background !== false });
        const tab = this.addTab(r.tabId, r.targetInfo);
        return { targetId: tab.targetInfo.targetId };
      }
      case 'Target.closeTarget': {
        const tab = [...this.tabsBySession.values()].find((t) => t.targetInfo.targetId === params.targetId);
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

let relay: ExtensionRelay | null = null;

/** Starts the relay once per process. Returns null if another Flintrail already owns the port. */
export async function startRelay(token: string): Promise<ExtensionRelay | null> {
  if (relay) return relay;
  const r = new ExtensionRelay(token, config.relayPort);
  try {
    await r.start();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`flintrail: relay port ${config.relayPort} already in use, another Flintrail owns the extension.`);
      return null;
    }
    throw e;
  }
  relay = r;
  return r;
}

export function getRelay(): ExtensionRelay | null {
  return relay;
}
