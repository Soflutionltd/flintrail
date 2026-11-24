// The pairing host, started by the browser itself, tells the extension which profile it runs in: macOS often
// keeps the relay from reading a browser's files, but not the browser's own child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = new URL('../dist/native-host.js', import.meta.url).pathname;

function ask(message, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [host], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      resolve(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString('utf8')));
    });
    const body = Buffer.from(JSON.stringify(message));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    child.stdin.end(Buffer.concat([head, body]));
  });
}

test('the pairing host names the profile the extension runs in', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'flintrail-host-'));
  const instance = 'c0ffee00-1234-4abc-8def-0123456789ab';
  writeFileSync(join(dataDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Perso' }, 'Profile 2': { name: 'Soflution' } } } }));
  mkdirSync(join(dataDir, 'Default'));
  const store = join(dataDir, 'Profile 2', 'Local Extension Settings', 'hgkglidmccenjlhdcplcpkgbadonplnb');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, '000003.log'), `...instance\u0000"${instance}"...`);
  const env = { FLINTRAIL_HOME: mkdtempSync(join(tmpdir(), 'flintrail-')), FLINTRAIL_PAIRING_DIRS: dataDir };
  assert.deepEqual(await ask({ type: 'profile', instance }, env), { type: 'profile', name: 'Soflution' });
  assert.deepEqual(await ask({ type: 'profile', instance: 'aaaaaaaa-0000-4000-8000-000000000000' }, env), { type: 'profile', name: '' });
});
