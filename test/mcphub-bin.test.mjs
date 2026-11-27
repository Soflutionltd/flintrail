// McpHub is found by its full path: Claude Desktop, opened from the Dock, starts Rocketwright with a PATH that leaves
// out ~/.local/bin, where McpHub installs itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mcphub } = await import('../dist/capture.js');

function withEnv(env, fn) {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, ROCKETWRIGHT_MCPHUB: process.env.ROCKETWRIGHT_MCPHUB };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('McpHub in ~/.local/bin is found with the short PATH of an app opened from the Dock', () => {
  const home = mkdtempSync(join(tmpdir(), 'rocketwright-home-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const bin = join(home, '.local', 'bin', 'McpHub');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  assert.equal(withEnv({ HOME: home, PATH: '/usr/bin:/bin', ROCKETWRIGHT_MCPHUB: undefined }, mcphub), bin);
  // ROCKETWRIGHT_MCPHUB, set by the user, wins.
  assert.equal(withEnv({ HOME: home, PATH: '/usr/bin:/bin', ROCKETWRIGHT_MCPHUB: '/somewhere/McpHub' }, mcphub), '/somewhere/McpHub');
});

test('a file that cannot run is skipped, and a missing McpHub says where it looked and what to set', () => {
  const home = mkdtempSync(join(tmpdir(), 'rocketwright-home-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'McpHub'), 'not a program');
  assert.throws(() => withEnv({ HOME: home, PATH: '/usr/bin:/bin', ROCKETWRIGHT_MCPHUB: undefined }, mcphub),
    /McpHub not found \(looked in PATH, ~\/\.local\/bin, \/opt\/homebrew\/bin and \/usr\/local\/bin\)\. Set ROCKETWRIGHT_MCPHUB/);
});
