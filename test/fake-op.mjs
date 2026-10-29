#!/usr/bin/env node
// Stands in for 1Password CLI in tests: one Login for the fixture site, one for another domain.
const [cmd, sub, id] = process.argv.slice(2);
const vault = { id: 'v1', name: 'Test' };
const items = [
  { id: 'fixture1', title: 'Fixture shop', vault, additional_information: 'ann@example.com', urls: [{ href: 'http://127.0.0.1/login' }] },
  { id: 'other1', title: 'Elsewhere', vault, additional_information: 'bob@example.com', urls: [{ href: 'https://elsewhere.example/login' }] },
];
const fields = [
  { id: 'username', type: 'STRING', purpose: 'USERNAME', value: 'ann@example.com' },
  { id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value: 'S3cret pass&"42' },
  { id: 'TOTP_test', type: 'OTP', value: 'otpauth://totp/test?secret=JBSWY3DPEHPK3PXP', totp: '123456' },
];

if (cmd === 'item' && sub === 'list') {
  process.stdout.write(JSON.stringify(items));
} else if (cmd === 'item' && sub === 'get') {
  const item = items.find((i) => i.id === id);
  if (!item) {
    process.stderr.write(`[ERROR] "${id}" isn't an item.\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ...item, fields }));
} else {
  process.stderr.write(`[ERROR] unsupported: ${process.argv.slice(2).join(' ')}\n`);
  process.exit(1);
}
