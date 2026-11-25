#!/usr/bin/env node
// Stands in for LastPass CLI (lpass) in tests: `lpass show --json` prints entries as JSON; secure notes use http://sn.
const args = process.argv.slice(2);
const entry = { id: '4417', name: 'Fixture shop', fullname: 'Web/Fixture shop', username: 'ann@example.com', password: 'S3cret pass&"42', url: 'http://127.0.0.1/login', group: 'Web', note: '' };
const note = { id: '4418', name: 'Wifi', fullname: 'Notes/Wifi', username: '', password: '', url: 'http://sn', group: 'Notes', note: 'x' };
if (args[0] !== 'show' || !args.includes('--json')) { process.stderr.write('unknown command\n'); process.exit(1); }
const last = args.at(-1);
process.stdout.write(JSON.stringify(last === entry.id ? [entry] : last === '.*' ? [entry, note] : []));
