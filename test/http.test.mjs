import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { cli, testEnv } from './helpers.mjs';

test('HTTP transport requires the bearer token and serves tools', async () => {
  const port = 18931 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [cli, '--http', '--port', String(port), '--token', 'secret-test-token'], { env: testEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((resolve) => proc.stderr.on('data', (d) => String(d).includes('listening') && resolve()));
  try {
    const url = `http://127.0.0.1:${port}/mcp`;
    const denied = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(denied.status, 401);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: 'Bearer secret-test-token' } } }));
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'fl_run'));
    await client.close();
  } finally {
    proc.kill('SIGTERM');
  }
});
