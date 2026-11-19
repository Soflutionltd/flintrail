// Desktop steps: snapshot refs, live actions, recording with fingerprints, replay without a browser tab.
// Runs against a fake agent-desktop, so it needs no real app and no accessibility permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fake = fileURLToPath(new URL('./fake-agent-desktop.mjs', import.meta.url));
chmodSync(fake, 0o755);
const home = mkdtempSync(join(tmpdir(), 'fl-desktop-'));
process.env.FLINTRAIL_HOME = home;
process.env.FLINTRAIL_AGENT_DESKTOP = fake;
process.env.FAKE_AD_LOG = join(home, 'clicks.log');

const d = await import('../dist/desktop.js');
const { recorder } = await import('../dist/recorder.js');
const { runFlow } = await import('../dist/flows.js');
const { loadFlow } = await import('../dist/store.js');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('snapshot lists elements with dN refs and resolves the English app name', async () => {
  const s = await d.snapshotApp('Calculator');
  assert.match(s, /^App Calculatrice, window "Calculatrice"/);
  assert.match(s, /\[d2\] button "7"/);
  assert.match(s, /\[d5\] button "Égale"/);
});

test('live actions are recorded with fingerprints and replayed without a browser tab', async () => {
  await d.snapshotApp('Calculatrice');
  recorder.start('calc');
  const r = await d.actDesktop('Calculatrice', [
    { do: 'click', ref: 'd2' },
    { do: 'click', role: 'button', name: 'Ajouter' },
    { do: 'click', ref: 'd4' },
    { do: 'click', ref: 'd5' },
    { do: 'get', ref: 'd1' },
  ], { snapshot: false, record: (st) => recorder.addDesktopStep(st) });
  assert.match(r, /#4 get -> "7\+5="/);
  recorder.stop(true);

  const flow = loadFlow('calc');
  assert.equal(flow.steps.length, 5);
  assert.deepEqual(flow.steps[0], { do: 'desktop', desktop: { do: 'click', app: 'Calculatrice', target: { role: 'button', name: '7', nativeId: 'Seven' } } });
  // The display id embeds live state, so it is not kept as a fingerprint.
  assert.equal(flow.steps[4].desktop.target.nativeId, undefined);

  const run = await runFlow('calc', {}, undefined, { snapshot: false });
  assert.equal(run.ok, true, run.text);
  assert.equal(run.tab, '');
  assert.match(run.text, /get -> "7\+5=7\+5="/);
});

test('a missing element fails at the exact step', async () => {
  await d.snapshotApp('Calculatrice');
  recorder.start('broken');
  await d.actDesktop('Calculatrice', [{ do: 'click', ref: 'd2' }], { snapshot: false, record: (st) => recorder.addDesktopStep(st) });
  recorder.stop(true);
  const f = loadFlow('broken');
  f.steps[0].desktop.target = { role: 'button', name: 'Racine', nativeId: 'Sqrt' };
  const { saveFlow } = await import('../dist/store.js');
  saveFlow(f);
  const run = await runFlow('broken', {}, undefined, { snapshot: false });
  assert.equal(run.ok, false);
  assert.equal(run.failedStep, 0);
  assert.match(run.text, /element not found in Calculatrice: button "Racine"/);
});
