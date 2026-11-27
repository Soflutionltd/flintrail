// What an install from before the rename (Flintrail) left: its variables and its folder.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adoptEnvironment, moveHome, resolveHome } from '../dist/legacy.js';

const home = () => mkdtempSync(join(tmpdir(), 'rw-legacy-'));

test('an old variable stands for its new one unless that is set', () => {
  const env = { FLINTRAIL_MODE: 'extension', FLINTRAIL_RELAY_PORT: '9000', ROCKETWRIGHT_RELAY_PORT: '8932', PATH: '/bin' };
  assert.deepEqual(adoptEnvironment(env), ['ROCKETWRIGHT_MODE']);
  assert.equal(env.ROCKETWRIGHT_MODE, 'extension');
  assert.equal(env.ROCKETWRIGHT_RELAY_PORT, '8932');
});

test('the old folder moves, with a link left where it was', () => {
  const dir = home();
  mkdirSync(join(dir, '.flintrail', 'flows'), { recursive: true });
  writeFileSync(join(dir, '.flintrail', 'token'), 'secret');
  assert.equal(resolveHome(dir, {}), join(dir, '.flintrail'), 'until the command moves it, it is used where it is');
  assert.deepEqual(moveHome(dir, {}), []);
  assert.equal(readFileSync(join(dir, '.rocketwright', 'token'), 'utf8'), 'secret');
  assert.ok(lstatSync(join(dir, '.flintrail')).isSymbolicLink());
  assert.equal(realpathSync(join(dir, '.flintrail')), realpathSync(join(dir, '.rocketwright')));
  assert.equal(resolveHome(dir, {}), join(dir, '.rocketwright'));
  assert.deepEqual(moveHome(dir, {}), [], 'once moved, nothing is moved again');
});

test('a folder another tool left at the new place takes what the old one holds, nothing replaced', () => {
  const dir = home();
  mkdirSync(join(dir, '.rocketwright', 'run'), { recursive: true });
  mkdirSync(join(dir, '.flintrail'));
  writeFileSync(join(dir, '.flintrail', 'token'), 'secret');
  assert.deepEqual(moveHome(dir, {}), []);
  assert.equal(readFileSync(join(dir, '.rocketwright', 'token'), 'utf8'), 'secret');
  assert.ok(existsSync(join(dir, '.rocketwright', 'run')) && lstatSync(join(dir, '.flintrail')).isSymbolicLink());

  const clash = home();
  mkdirSync(join(clash, '.rocketwright'));
  writeFileSync(join(clash, '.rocketwright', 'browsers.json'), '{}');
  mkdirSync(join(clash, '.flintrail'));
  writeFileSync(join(clash, '.flintrail', 'browsers.json'), '{"a":1}');
  const [problem] = moveHome(clash, {});
  assert.match(problem, /^left in .*\.flintrail: files /);
  assert.equal(readFileSync(join(clash, '.flintrail', 'browsers.json'), 'utf8'), '{"a":1}');
});

test('nothing moves when a place is named, the new folder has its token, or there is no old one', () => {
  const dir = home();
  mkdirSync(join(dir, '.flintrail'));
  assert.deepEqual(moveHome(dir, { ROCKETWRIGHT_HOME: '/elsewhere' }), []);
  assert.ok(!existsSync(join(dir, '.rocketwright')));
  assert.equal(resolveHome(dir, { ROCKETWRIGHT_HOME: '/elsewhere' }), '/elsewhere');
  mkdirSync(join(dir, '.rocketwright'));
  writeFileSync(join(dir, '.rocketwright', 'token'), 'new');
  assert.deepEqual(moveHome(dir, {}), []);
  assert.ok(!lstatSync(join(dir, '.flintrail')).isSymbolicLink());
  assert.equal(resolveHome(dir, {}), join(dir, '.rocketwright'));
  const fresh = home();
  assert.equal(resolveHome(fresh, {}), join(fresh, '.rocketwright'), 'a fresh install');
});
