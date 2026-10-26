// Recent Chrome builds expose their own UI (toolbar, omnibox popup) as CDP targets of type "browser_ui".
// Playwright waits forever for those to initialise, so connectOverCDP never resolves. This local proxy sits
// between Playwright and Chrome and hides them: it detaches from them as soon as Chrome auto-attaches, and
// drops every message about them. Everything else passes through untouched.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

const HIDDEN_TYPES = new Set(['browser_ui']);
const OWN_ID_BASE = 2_000_000_000;

export interface CdpFilter { url: string; close(): void }

export async function startCdpFilter(browserWsUrl: string): Promise<CdpFilter> {
  const server: Server = createServer((_req, res) => { res.writeHead(404).end(); });
  const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 * 1024 });
  wss.on('connection', (client) => {
    const upstream = new WebSocket(browserWsUrl, { maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
    const hiddenSessions = new Set<string>();
    const hiddenTargets = new Set<string>();
    const queue: string[] = [];
    let ownId = OWN_ID_BASE;
    let ownPending = 0; // answers to our own detach commands, never forwarded
    upstream.on('open', () => { for (const m of queue.splice(0)) upstream.send(m); });
    client.on('message', (m: RawData) => {
      const s = String(m);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(s); else queue.push(s);
    });
    upstream.on('message', (raw: RawData) => {
      const text = String(raw);
      // Fast path: most traffic is page events that cannot concern a hidden target.
      if (ownPending === 0 && hiddenSessions.size === 0 && !text.includes('Target.') && !text.includes('targetInfos')) { client.send(text); return; }
      let d: any;
      try { d = JSON.parse(text); } catch { client.send(text); return; }
      if (typeof d.id === 'number' && d.id >= OWN_ID_BASE) { ownPending--; return; }
      if (d.sessionId && hiddenSessions.has(d.sessionId)) return;
      const info = d.params?.targetInfo;
      if (d.method === 'Target.attachedToTarget' && HIDDEN_TYPES.has(info?.type)) {
        hiddenSessions.add(d.params.sessionId);
        hiddenTargets.add(info.targetId);
        const detach: Record<string, unknown> = { id: ownId++, method: 'Target.detachFromTarget', params: { sessionId: d.params.sessionId } };
        if (d.sessionId) detach.sessionId = d.sessionId;
        ownPending++;
        upstream.send(JSON.stringify(detach));
        return;
      }
      if ((d.method === 'Target.targetCreated' || d.method === 'Target.targetInfoChanged') && HIDDEN_TYPES.has(info?.type)) { hiddenTargets.add(info.targetId); return; }
      if (d.method === 'Target.targetDestroyed' && hiddenTargets.has(d.params?.targetId)) return;
      if (d.method === 'Target.detachedFromTarget' && hiddenSessions.has(d.params?.sessionId)) { hiddenSessions.delete(d.params.sessionId); return; }
      if (Array.isArray(d.result?.targetInfos)) {
        d.result.targetInfos = d.result.targetInfos.filter((t: any) => !HIDDEN_TYPES.has(t.type));
        client.send(JSON.stringify(d));
        return;
      }
      client.send(text);
    });
    const end = () => { client.close(); upstream.close(); };
    client.on('close', end);
    upstream.on('close', end);
    upstream.on('error', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/`, close: () => { wss.close(); server.close(); } };
}
