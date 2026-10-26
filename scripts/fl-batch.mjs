// Runs fl_act with actions read from a JSON file (handy for long texts):  node scripts/fl-batch.mjs <tab> <actions.json> [text]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [tab, file, text = '0'] = process.argv.slice(2);
const actions = JSON.parse(readFileSync(file, 'utf8'));
const token = readFileSync(join(homedir(), '.flintrail/token'), 'utf8').trim();
const client = new Client({ name: 'fl-batch', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8931/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const r = await client.callTool({ name: 'fl_act', arguments: { tab, actions, text: Number(text), max: Number(text) ? 60 : 0 } });
for (const c of r.content) if (c.type === 'text') console.log(c.text);
await client.close();
