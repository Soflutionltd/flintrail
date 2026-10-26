import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const cli = new URL('../dist/cli.js', import.meta.url).pathname;

export function testEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'flintrail-'));
  return {
    ...process.env,
    FLINTRAIL_MODE: 'launch',
    FLINTRAIL_HOME: home,
    FLINTRAIL_DOWNLOADS: join(home, 'downloads'),
    FLINTRAIL_HEADLESS: '1',
    ...(process.env.FLINTRAIL_CHROME ? { FLINTRAIL_CHROME: process.env.FLINTRAIL_CHROME } : {}),
    ...extra,
  };
}

export async function connect(env = testEnv()) {
  const client = new Client({ name: 'flintrail-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli], env, stderr: 'inherit' }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text ?? '[image]').join('\n');
    if (r.isError) throw new Error(`${name}: ${text}`);
    return text;
  };
  return { client, call };
}

export const refOf = (snap, pattern) => {
  const line = snap.split('\n').find((l) => pattern.test(l));
  return line ? /\[([^\]]+)\]/.exec(line)[1] : undefined;
};
