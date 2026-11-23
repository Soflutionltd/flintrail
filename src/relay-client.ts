// Client side of the shared relay: every Flintrail process connects to the relay daemon (src/relay.ts),
// and starts it when nobody has. Several conversations can then drive the user's browsers at once.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, type RawData } from 'ws';
import { config } from './config.js';
import { recorder } from './recorder.js';
import { macFor, macMatches, RELAY_PROTOCOL, slug, type BrowserInfo } from './relay-protocol.js';
import type { Step } from './engine.js';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** -1, 0 or 1, comparing "1.3.0"-style versions. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private waiters: (() => void)[] = [];
  private browserListeners: ((list: BrowserInfo[]) => void)[] = [];
  browsers: BrowserInfo[] = [];
  relayVersion = '';
  lastError = '';
  /** Tabs of this conversation the browser took back lately, and why. */
  private lost: { url: string; reason: string; at: number }[] = [];

  /** Why the tab last seen on this URL is no longer driven, if the extension said so in the last 10 minutes. */
  lostReason(url?: string): string | undefined {
    const recent = this.lost.filter((l) => Date.now() - l.at < 10 * 60_000);
    return (url ? recent.filter((l) => l.url === url).at(-1) : recent.at(-1))?.reason;
  }

  constructor(private readonly token: string, private readonly version: string) {}

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  /** Notified each time the list of connected browsers changes (a browser left: forget its driver). */
  onBrowsers(fn: (list: BrowserInfo[]) => void) { this.browserListeners.push(fn); }

  /** Connects to the relay daemon, starting it first if no Flintrail did. */
  ensure(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.connectOrSpawn()
        .catch((e) => { this.lastError = (e as Error).message; throw e; })
        .finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  private async connectOrSpawn(retired = false): Promise<void> {
    let welcome = await this.tryConnect();
    if (!welcome) {
      spawnDaemon();
      for (let i = 0; i < 60 && !welcome; i++) {
        await sleep(150);
        welcome = await this.tryConnect();
      }
      if (!welcome) throw new Error(`The Flintrail relay did not start on 127.0.0.1:${config.relayPort} (see ${join(config.home, 'relay.log')}).`);
    }
    // An older daemon left over from a previous Flintrail version: replace it when nobody else uses it.
    const outdated = welcome.protocol !== RELAY_PROTOCOL || compareVersions(welcome.version, this.version) < 0;
    if (outdated && welcome.clients === 1 && !retired) {
      const ok = await this.request('retire', {}).then(() => true, () => false);
      if (ok) {
        this.ws?.close();
        for (let i = 0; i < 40 && await this.portBusy(); i++) await sleep(100);
        return this.connectOrSpawn(true);
      }
    }
    if (welcome.protocol !== RELAY_PROTOCOL) {
      this.ws?.close();
      throw new Error(`The running Flintrail relay (${welcome.version}) is incompatible with this Flintrail (${this.version}). It is replaced once the other conversations using it are closed.`);
    }
  }

  private async portBusy(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${config.relayPort}/client`);
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
    });
  }

  /** One attempt. Resolves null when nothing listens on the port. */
  private tryConnect(): Promise<{ version: string; protocol: number; clients: number } | null> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${config.relayPort}/client`);
      const cnonce = randomBytes(16).toString('hex');
      let settled = false;
      const fail = (e: Error | null) => { if (!settled) { settled = true; ws.close(); if (e) reject(e); else resolve(null); } };
      const timer = setTimeout(() => fail(new Error(`The process on 127.0.0.1:${config.relayPort} does not answer like a Flintrail relay.`)), 5000);
      ws.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (e.code === 'ECONNREFUSED') { fail(null); return; }
        // Flintrail 1.3 and older kept the relay inside one conversation, and hang up on /client.
        fail(e.code === 'ECONNRESET' || /socket hang up|Unexpected server response/.test(e.message)
          ? new Error(`Port ${config.relayPort} is held by an older Flintrail (1.3 or earlier) running in another conversation, or by another program. Close that conversation, or update its Flintrail, so the shared relay can start.`)
          : e);
      });
      ws.on('close', (code) => {
        clearTimeout(timer);
        if (!settled) fail(code === 4401 ? new Error('The Flintrail relay refused the token (different ~/.flintrail/token?).') : null);
        else if (this.ws === ws) this.onClose();
      });
      ws.on('message', (raw: RawData) => {
        let m: any;
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (!settled && m.type === 'challenge') {
          ws.send(JSON.stringify({ type: 'hello', mac: macFor(this.token, 'client:' + m.nonce), cnonce, version: this.version, protocol: RELAY_PROTOCOL, pid: process.pid }));
          return;
        }
        if (!settled && m.type === 'welcome') {
          clearTimeout(timer);
          // The daemon proves it knows the token too: a process squatting the port is not trusted.
          if (!macMatches(this.token, 'relay:' + cnonce, String(m.mac || ''))) { fail(new Error(`The process on 127.0.0.1:${config.relayPort} is not a Flintrail relay.`)); return; }
          settled = true;
          this.ws = ws;
          this.relayVersion = String(m.version);
          this.lastError = '';
          this.setBrowsers(m.browsers || []);
          resolve({ version: String(m.version), protocol: Number(m.protocol), clients: Number(m.clients) });
          return;
        }
        if (settled && this.ws === ws) this.onMessage(m);
      });
    });
  }

  private onClose() {
    this.ws = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('relay disconnected')); }
    this.pending.clear();
    this.setBrowsers([]);
  }

  private setBrowsers(list: BrowserInfo[]) {
    this.browsers = list;
    this.browserListeners.forEach((fn) => fn(list));
    this.waiters.splice(0).forEach((w) => w());
  }

  private async onMessage(m: any) {
    if (typeof m.id === 'number' && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String(m.error))); else p.resolve(m.result);
      return;
    }
    switch (m.type) {
      case 'browsers': return this.setBrowsers(m.browsers || []);
      case 'tabLost':
        this.lost = [...this.lost, { url: String(m.url || ''), reason: String(m.reason || ''), at: Date.now() }].slice(-20);
        return;
      case 'recorded': return recorder.addDemoStep(m.step as Step);
      case 'demo': {
        let text: string;
        try {
          text = m.action === 'start' ? recorder.start(m.name, 'Recorded by demonstration', m.url) : recorder.stop(true);
        } catch (e) { text = `Error: ${(e as Error).message}`; }
        this.ws?.send(JSON.stringify({ type: 'demoResult', reqId: m.reqId, text }));
        return;
      }
    }
  }

  request(method: string, params: Record<string, unknown>, timeout = 10000): Promise<any> {
    if (!this.connected) return Promise.reject(new Error('relay not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`relay timeout on ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Connected browsers answering to this name: their exact name, the user's label, or the profile name. */
  matching(key: string): BrowserInfo[] {
    const k = key.trim().toLowerCase();
    const exact = this.browsers.filter((b) => b.key === k);
    if (exact.length) return exact;
    const s = slug(k);
    const labelled = this.browsers.filter((b) => b.label && slug(b.label) === s);
    if (labelled.length) return labelled;
    return this.browsers.filter((b) => b.profile && (slug(b.profile) === s || `${b.key.split('-')[0]}-${slug(b.profile)}` === s));
  }

  /** A browser by name, label or profile, or the first connected one when no name is given. Never guesses between two. */
  find(key?: string): BrowserInfo | undefined {
    if (!key) return this.browsers[0];
    const found = this.matching(key);
    return found.length === 1 ? found[0] : undefined;
  }

  /** Waits for a browser by name, or for any browser when no name is given. */
  async waitFor(key: string | undefined, ms: number): Promise<BrowserInfo> {
    await this.ensure();
    const found = this.find(key);
    if (found) return found;
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        done = true;
        const names = this.browsers.map((b) => b.key);
        reject(new Error(key
          ? `Browser "${key}" is not connected to Flintrail.${names.length ? ` Connected: ${names.join(', ')}.` : ''} Open it: the Flintrail extension connects by itself.`
          : 'No browser is connected to Flintrail. Open a browser where the Flintrail extension is installed: it connects by itself.'));
      }, ms);
      const check = () => {
        if (done) return;
        const b = this.find(key);
        if (b) { done = true; clearTimeout(t); resolve(b); } else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  /** A private CDP endpoint on that browser, for this process only. */
  async open(key: string): Promise<{ key: string; cdpUrl: string }> {
    await this.ensure();
    return this.request('open', { key });
  }
}

/** Starts the relay daemon, detached: it outlives this conversation and serves the others. */
function spawnDaemon() {
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = existsSync(join(here, 'cli.js')) ? join(here, 'cli.js') : process.argv[1]!;
  mkdirSync(config.home, { recursive: true });
  const log = openSync(join(config.home, 'relay.log'), 'a');
  const child = spawn(process.execPath, [cli, '--relay'], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
}

let client: RelayClient | null = null;

/** The relay client of this process, or null when the relay is turned off (FLINTRAIL_RELAY=off). */
export function relayClient(token: string, version: string): RelayClient | null {
  if (process.env.FLINTRAIL_RELAY === 'off') return null;
  if (!client) client = new RelayClient(token, version);
  return client;
}

export function getRelayClient(): RelayClient | null {
  return client;
}
