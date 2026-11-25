#!/usr/bin/env node
// Stands in for keepassxc-cli in tests: `<command> [options] <database> <entry or term>`. The database opens with the
// key file (--no-password --key-file) or with the password read on standard input.
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const [command] = args;
const target = args.at(-1);
const db = args.at(-2);
if (db !== process.env.FAKE_KP_DB) { process.stderr.write('Error while reading the database: no such file\n'); process.exit(1); }
if (!args.includes('--no-password')) {
  let typed = '';
  try { typed = readFileSync(0, 'utf8').trim(); } catch { /* nothing on stdin */ }
  if (typed !== 'kp master') { process.stderr.write('Error while reading the database: Invalid credentials were provided\n'); process.exit(1); }
}
const entry = { path: '/Web/Fixture shop', Title: 'Fixture shop', UserName: 'ann@example.com', URL: 'http://127.0.0.1/login', Password: 'S3cret pass&"42' };
const attrs = args.flatMap((a, i) => (a === '-a' ? [args[i + 1]] : []));
if (command === 'search') process.stdout.write(target.includes('127.0.0.1') ? `${entry.path}\n` : '');
else if (command === 'show' && target === entry.path) {
  const lines = attrs.map((a) => entry[a]);
  if (args.includes('--totp')) lines.push('123456');
  process.stdout.write(lines.join('\n') + '\n');
} else { process.stderr.write('Entry not found\n'); process.exit(1); }
