#!/usr/bin/env node
// rocketwright            -> MCP over stdio (Claude Desktop, Claude Code, Cursor...)
// rocketwright --http     -> MCP over Streamable HTTP with a bearer token (remote agents, servers)
// rocketwright --relay    -> shared extension relay, started by Rocketwright itself (src/relay.ts)
import './legacy-home.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadToken } from './auth.js';
import { shutdown } from './browser.js';
import { config } from './config.js';
import { installNativeHost } from './pairing.js';
import { runRelayDaemon } from './relay.js';
import { separateProfile } from './separate.js';
import { relayClient } from './relay-client.js';
import { buildServer, VERSION } from './server.js';
import { attachUpdateNotice, startUpdateCheck } from './update-notice.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};

if (flag('version')) {
  console.log(VERSION);
  process.exit(0);
}
if (flag('help')) {
  console.log(`rocketwright ${VERSION}
  rocketwright                 MCP over stdio
  rocketwright --http          MCP over HTTP (default 127.0.0.1:8931, path /mcp)
  rocketwright --relay         shared extension relay (started by Rocketwright itself when needed)
  rocketwright --separate-profile <brand> "<profile>"   move a copy of a browser profile into an instance of its own
                            (macOS): the "is debugging this browser" bar then stays in its windows
    --host <h> --port <p>   listen address
    --token <t>             bearer token (default: ROCKETWRIGHT_TOKEN or ~/.rocketwright/token)
Environment: ROCKETWRIGHT_MODE=attach|launch|extension, ROCKETWRIGHT_RELAY_PORT, ROCKETWRIGHT_RELAY=off, ROCKETWRIGHT_RELAY_IDLE_MS, ROCKETWRIGHT_PAIRING=off,
  ROCKETWRIGHT_EXTENSION_IDS, ROCKETWRIGHT_CDP_URL, ROCKETWRIGHT_CHROME, ROCKETWRIGHT_HEADLESS=0,
  ROCKETWRIGHT_ALLOWED_DOMAINS=example.com,*.example.org   the only sites the agent may open, read and send requests to (default: any),
  ROCKETWRIGHT_PASSWORDS=browser,1password[:path],bitwarden[:path],command:path   sources for fl_login, in order (default browser, "off" to disable)
  ROCKETWRIGHT_MASK_SECRETS=off   show values that look like credentials in tool results (masked by default)`);
  process.exit(0);
}

// A browser profile moved into an instance of its own (see src/separate.ts).
if (flag('separate-profile')) {
  const i = args.indexOf('--separate-profile');
  const [brand, name] = [args[i + 1], args[i + 2]];
  if (!brand || !name) {
    console.error('Usage: rocketwright --separate-profile <brand> "<profile name>"   e.g. rocketwright --separate-profile brave Soflution');
    process.exit(2);
  }
  try {
    for (const line of separateProfile(brand, name, { launcher: !flag('no-launcher') })) console.log(line);
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

// The shared relay daemon (started by Rocketwright itself): it never returns, the rest is the MCP server.
if (flag('relay')) await runRelayDaemon(loadToken(opt('token', '')));

const stop = async () => { await shutdown(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Join the shared relay right away (starting it if no Rocketwright did), so the user's browsers (Brave,
// Chrome...) connect through the extension, and can record by demonstration, before the agent's first call.
const relay = relayClient(loadToken(opt('token', '')), VERSION);
// The pairing host is registered here, before the MCP handshake, and again by the daemon: a browser opened
// right after Rocketwright starts must not try to pair before the detached daemon is up, or it waits for the
// extension's next retry, 30 seconds later.
if (relay) installNativeHost(config.dedicatedProfile ? [config.dedicatedProfile] : []);
relay?.ensure().catch((e: Error) => console.error(`rocketwright: extension relay unavailable: ${e.message}`));

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

if (flag('http')) {
  const host = opt('host', '127.0.0.1');
  const port = Number(opt('port', '8931'));
  const token = Buffer.from(loadToken(opt('token', '')));
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer(async (req, res) => {
    try {
      if (req.url === '/health') { res.writeHead(200).end('ok'); return; }
      if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
      const auth = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (auth.length !== token.length || !timingSafeEqual(auth, token)) { res.writeHead(401).end('unauthorized'); return; }
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const sid = req.headers['mcp-session-id'] as string | undefined;
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        if (req.method !== 'POST' || !isInitializeRequest(body)) { res.writeHead(400).end('no session'); return; }
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { sessions.set(id, t); },
        });
        t.onclose = () => { if (t.sessionId) sessions.delete(t.sessionId); };
        await buildServer().connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String((e as Error).message));
    }
  });
  http.listen(port, host, () => {
    console.error(`rocketwright ${VERSION} listening on http://${host}:${port}/mcp (bearer token in ${join(config.home, 'token')})`);
  });
} else {
  startUpdateCheck('rocketwright', VERSION, 'https://github.com/Soflutionltd/rocketwright');
  await buildServer().connect(attachUpdateNotice(new StdioServerTransport()));
  // An attached browser keeps the event loop alive: leave when the client goes away, or the process lingers.
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
}
