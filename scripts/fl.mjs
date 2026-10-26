// One Flintrail tool call from the command line, against a running `flintrail --http` server.
//   node scripts/fl.mjs <tool> '<json arguments>'
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [tool, json = '{}'] = process.argv.slice(2);
const token = process.env.FLINTRAIL_TOKEN || readFileSync(join(homedir(), '.flintrail/token'), 'utf8').trim();
const url = new URL(process.env.FLINTRAIL_URL || 'http://127.0.0.1:8931/mcp');
const client = new Client({ name: 'fl-cli', version: '1' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const r = await client.callTool({ name: tool, arguments: JSON.parse(json) });
for (const c of r.content) {
  if (c.type === 'text') console.log(c.text);
  else if (c.type === 'image') console.log(`[image ${c.mimeType}, ${c.data.length} b64 chars]`);
}
await client.close();
process.exit(r.isError ? 1 : 0);
