import { mkdtempSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
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
    // Never touch the real browsers of the machine running the tests.
    FLINTRAIL_RELAY: 'off',
    FLINTRAIL_PAIRING: 'off',
    // A relay daemon started by a test leaves soon after the test's Flintrail processes.
    FLINTRAIL_RELAY_IDLE_MS: '1500',
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

/** The entries of a zip file (a Playwright trace), by name, read with the central directory. */
export function zipEntries(file) {
  const buf = readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString();
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(raw) : raw);
    at += 46 + nameLen + extra + comment;
  }
  return out;
}
