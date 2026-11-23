#!/usr/bin/env node
// Stands in for agent-desktop in tests: a tiny calculator app with a display, and a log of what was clicked.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [cmd, ...args] = process.argv.slice(2);
const log = process.env.FAKE_AD_LOG;
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const out = (data) => { process.stdout.write(JSON.stringify({ ok: true, version: '2.5', command: cmd, data }) + '\n'); };
const fail = (code, message) => { process.stdout.write(JSON.stringify({ ok: false, version: '2.5', command: cmd, error: { code, message } }) + '\n'); process.exit(1); };

const display = () => (log && existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')[1]).join('') : '');
const buttons = [
  { name: '7', id: 'Seven' }, { name: 'Ajouter', id: 'Add' }, { name: '5', id: 'Five' }, { name: 'Égale', id: 'Equals' },
];
const tree = (sid) => ({
  role: 'window', name: 'Calculatrice',
  children: [
    { role: 'scrollarea', ref_id: `@${sid}:e1`, native_id: { value: 'StandardInputView;value:0' }, children: [{ role: 'statictext', name: display(), value: display() }] },
    ...buttons.map((b, i) => ({ role: 'button', name: b.name, ref_id: `@${sid}:e${i + 2}`, native_id: { value: b.id } })),
  ],
});

switch (cmd) {
  case 'list-apps': out({ apps: [{ name: 'Calculatrice', bundle_id: 'com.apple.calculator', presentation: 'foreground' }] }); break;
  case 'list-windows': out([{ id: 'w-1', title: 'Calculatrice', is_focused: true }]); break;
  case 'snapshot':
    if (opt('--app') && opt('--app') !== 'Calculatrice') fail('APP_NOT_FOUND', `No running application matches '${opt('--app')}'`);
    if (opt('--root')) out({ tree: { role: 'scrollarea', children: [{ role: 'statictext', name: display() }] } });
    else out({ app: 'Calculatrice', window: { id: 'w-1', title: 'Calculatrice' }, snapshot_id: 'snap', complete: true, tree: tree('snap') });
    break;
  case 'find': {
    const id = opt('--native-id');
    const name = opt('--name');
    if (opt('--role') === 'scrollarea') { out({ matches: [{ ref_id: '@find:e1', role: 'scrollarea' }] }); break; }
    const i = buttons.findIndex((b) => (id ? b.id === id : b.name === name));
    out(i >= 0 ? { matches: [{ ref_id: `@find:e${i + 2}`, role: 'button', name: buttons[i].name }] } : { matches: [] });
    break;
  }
  case 'click': {
    const n = Number(String(args[0]).split(':e')[1]) - 2;
    const b = buttons[n];
    if (!b) fail('STALE_REF', 'stale');
    if (log) appendFileSync(log, `click ${b.name === 'Ajouter' ? '+' : b.name === 'Égale' ? '=' : b.name}\n`);
    out({ action: 'click' });
    break;
  }
  case 'get': out({ value: '' }); break;
  default: fail('UNSUPPORTED', `fake agent-desktop: ${cmd}`);
}
