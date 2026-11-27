// A profile moved into a browser instance of its own: its own data folder, so its own process, where Chromium's
// "is debugging this browser" bar stays. Run on a fake Brave folder, never the user's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli } from './helpers.mjs';

const EXTENSION_ID = 'hgkglidmccenjlhdcplcpkgbadonplnb';

test('a profile is copied into an instance of its own, the original kept and renamed, and Rocketwright opens it there', { skip: platform() !== 'darwin' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'rocketwright-sep-'));
  const brave = join(home, 'Library/Application Support/BraveSoftware/Brave-Browser');
  const prof = join(brave, 'Profile 1');
  for (const d of ['Cache', 'Local Extension Settings/' + EXTENSION_ID, 'Local Extension Settings/other-extension']) mkdirSync(join(prof, d), { recursive: true });
  writeFileSync(join(prof, 'Cookies'), 'cookies');
  writeFileSync(join(prof, 'Cache', 'data'), 'cache');
  writeFileSync(join(prof, 'Local Extension Settings', EXTENSION_ID, '000003.log'), 'instance-id');
  mkdirSync(join(brave, 'Default'));
  writeFileSync(join(brave, 'Local State'), JSON.stringify({ os_crypt: { kept: true }, profile: { info_cache: { Default: { name: 'Perso' }, 'Profile 1': { name: 'Soflution', avatar_icon: 'x' } }, last_used: 'Default' } }));
  const env = { ...process.env, HOME: home, ROCKETWRIGHT_HOME: join(home, '.rocketwright') };
  delete env.ROCKETWRIGHT_INSTANCES_DIR;
  delete env.ROCKETWRIGHT_PAIRING_DIRS;
  const run = (...a) => spawnSync(process.execPath, [cli, '--separate-profile', ...a], { env, encoding: 'utf8' });

  // Refused while the browser has its folder open (its lock points to a live process: this test's own).
  symlinkSync(`host-${process.pid}`, join(brave, 'SingletonLock'));
  const busy = run('brave', 'Soflution');
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /Brave Browser is open: quit it completely/);
  unlinkSync(join(brave, 'SingletonLock'));
  // A lock left by a browser that crashed points to a process that is gone: not in the way.
  symlinkSync('host-999999', join(brave, 'SingletonLock'));

  const done = run('brave', 'Soflution');
  assert.equal(done.status, 0, done.stderr);
  const target = join(home, 'Library/Application Support/Rocketwright/Browsers/brave/Soflution');
  assert.equal(readFileSync(join(target, 'Default', 'Cookies'), 'utf8'), 'cookies');
  assert.ok(!existsSync(join(target, 'Default', 'Cache')), 'caches are left out');
  assert.ok(!existsSync(join(target, 'Default', 'Local Extension Settings', EXTENSION_ID)), 'Rocketwright\'s own storage is not copied');
  assert.ok(existsSync(join(target, 'Default', 'Local Extension Settings', 'other-extension')));
  const own = JSON.parse(readFileSync(join(target, 'Local State'), 'utf8'));
  assert.deepEqual(own.profile.info_cache, { Default: { name: 'Soflution', avatar_icon: 'x' } });
  assert.deepEqual(own.os_crypt, { kept: true });
  // The original is kept, renamed, and its Local State backed up.
  const main = JSON.parse(readFileSync(join(brave, 'Local State'), 'utf8'));
  assert.equal(main.profile.info_cache['Profile 1'].name, 'Soflution (old)');
  assert.ok(existsSync(join(prof, 'Cookies')));
  assert.ok(readdirSync(brave).some((f) => f.startsWith('Local State.rocketwright-')));
  // The extension of the new instance can pair, and a launcher opens it.
  assert.ok(existsSync(join(target, 'NativeMessagingHosts')));
  assert.ok(existsSync(join(home, 'Applications', 'Brave Soflution.app')));
  assert.match(done.stdout, /renamed "Soflution \(old\)" and kept/);
  // Run again: the original now has another name, and the instance is never written over.
  const again = run('brave', 'Soflution');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /No brave profile called "Soflution"/);
  const main2 = JSON.parse(readFileSync(join(brave, 'Local State'), 'utf8'));
  main2.profile.info_cache['Profile 1'].name = 'Soflution';
  writeFileSync(join(brave, 'Local State'), JSON.stringify(main2));
  const over = run('brave', 'Soflution');
  assert.equal(over.status, 1);
  assert.match(over.stderr, /already exists: Rocketwright never writes over a separate instance/);
  main2.profile.info_cache['Profile 1'].name = 'Soflution (old)';
  writeFileSync(join(brave, 'Local State'), JSON.stringify(main2));

  // Rocketwright lists it, and opens it in its own instance.
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const { localProfiles, openCommand, matchProfiles } = await import('../dist/profiles.js');
    const found = matchProfiles('Soflution', localProfiles());
    assert.equal(found.length, 1);
    assert.equal(found[0].separate, true);
    assert.deepEqual(openCommand(found[0]), ['open', ['-na', 'Brave Browser', '--args', `--user-data-dir=${target}`, '--profile-directory=Default']]);
  } finally {
    process.env.HOME = saved;
  }
});

test('an instance Flintrail made before the rename is still found and opened, and never made twice', { skip: platform() !== 'darwin' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'rocketwright-sep-old-'));
  const brave = join(home, 'Library/Application Support/BraveSoftware/Brave-Browser');
  mkdirSync(join(brave, 'Profile 1'), { recursive: true });
  writeFileSync(join(brave, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Soflution' } } } }));
  // What `flintrail --separate-profile brave Soflution` left: the instance under Flintrail's folder.
  const old = join(home, 'Library/Application Support/Flintrail/Browsers/brave/Soflution');
  mkdirSync(join(old, 'Default'), { recursive: true });
  writeFileSync(join(old, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Soflution' } } } }));
  const saved = process.env.HOME;
  const savedDir = process.env.ROCKETWRIGHT_INSTANCES_DIR;
  process.env.HOME = home;
  delete process.env.ROCKETWRIGHT_INSTANCES_DIR;
  try {
    const { localProfiles, openCommand, separateInstancesDirs } = await import('../dist/profiles.js');
    assert.ok(separateInstancesDirs().includes(join(home, 'Library/Application Support/Flintrail/Browsers')));
    const found = localProfiles().filter((p) => p.separate && p.name === 'Soflution');
    assert.equal(found.length, 1);
    assert.deepEqual(openCommand(found[0]), ['open', ['-na', 'Brave Browser', '--args', `--user-data-dir=${old}`, '--profile-directory=Default']]);
  } finally {
    process.env.HOME = saved;
    if (savedDir !== undefined) process.env.ROCKETWRIGHT_INSTANCES_DIR = savedDir;
  }
  // A second instance of the same profile is refused: the two could not be told apart.
  const env = { ...process.env, HOME: home, ROCKETWRIGHT_HOME: join(home, '.rocketwright') };
  delete env.ROCKETWRIGHT_INSTANCES_DIR;
  delete env.ROCKETWRIGHT_PAIRING_DIRS;
  const again = spawnSync(process.execPath, [cli, '--separate-profile', 'brave', 'Soflution'], { env, encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /is already a separate instance of "Soflution"/);
});
