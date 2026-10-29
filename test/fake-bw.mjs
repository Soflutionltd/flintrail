#!/usr/bin/env node
// Stands in for Bitwarden CLI in tests: one login for the fixture site.
const [cmd, what, id] = process.argv.slice(2);
const item = {
  id: 'bw-1', name: 'Fixture shop', type: 1,
  login: { username: 'ann@example.com', password: 'S3cret pass&"42', totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: 'http://127.0.0.1/login' }] },
};
if (cmd === 'list' && what === 'items') process.stdout.write(JSON.stringify([item, { id: 'note-1', name: 'A note', type: 2 }]));
else if (cmd === 'get' && what === 'item' && id === item.id) process.stdout.write(JSON.stringify(item));
else if (cmd === 'get' && what === 'totp' && id === item.id) process.stdout.write('123456\n');
else {
  process.stderr.write(`Not found.\n`);
  process.exit(1);
}
