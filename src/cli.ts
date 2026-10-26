#!/usr/bin/env node
// flintrail            -> MCP over stdio (Claude Desktop, Claude Code, Cursor...)
// flintrail --http     -> MCP over Streamable HTTP with a bearer token (remote agents, servers)
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadToken } from './auth.js';
import { shutdown } from './browser.js';
import { config } from './config.js';
import { startRelay } from './relay.js';
import { buildServer, VERSION } from './server.js';

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
  console.log(`flintrail ${VERSION}
  flintrail                 MCP over stdio
  flintrail --http          MCP over HTTP (default 127.0.0.1:8931, path /mcp)
    --host <h> --port <p>   listen address
    --token <t>             bearer token (default: FLINTRAIL_TOKEN or ~/.flintrail/token)
Environment: FLINTRAIL_MODE=attach|launch|extension, FLINTRAIL_RELAY_PORT, FLINTRAIL_CDP_URL, FLINTRAIL_CHROME, FLINTRAIL_HEADLESS=0`);
  process.exit(0);
}

const stop = async () => { await shutdown(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// In extension mode the relay starts right away, so the extension can connect (and record by
// demonstration) even before the agent makes its first call.
if (config.mode === 'extension') await startRelay(loadToken(opt('token', '')));

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
    console.error(`flintrail ${VERSION} listening on http://${host}:${port}/mcp (bearer token in ${join(config.home, 'token')})`);
  });
} else {
  await buildServer().connect(new StdioServerTransport());
  // An attached browser keeps the event loop alive: leave when the client goes away, or the process lingers.
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
}
