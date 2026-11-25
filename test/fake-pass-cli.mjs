#!/usr/bin/env node
// Stands in for Proton Pass CLI (pass-cli) in tests: vaults and items as JSON, fields read through pass:// references.
const args = process.argv.slice(2);
const login = { item: { id: 'I1', share_id: 'S1', content: { title: 'Fixture shop', content: { Login: { username: 'ann@example.com', email: '', password: 'S3cret pass&"42', urls: ['http://127.0.0.1/login'], totp_uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP' } } } } };
const out = (x) => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
if (args[0] === 'vault' && args[1] === 'list') out([{ name: 'Personal', share_id: 'S1' }]);
else if (args[0] === 'item' && args[1] === 'list') out({ items: [{ id: 'I1', share_id: 'S1', title: 'Fixture shop', state: 'Active' }], folders: [] });
else if (args[0] === 'item' && args[1] === 'view' && args[2] === 'pass://S1/I1') out(login);
else if (args[0] === 'item' && args[1] === 'view' && args[2] === 'pass://S1/I1/password') out('S3cret pass&"42\n');
else if (args[0] === 'item' && args[1] === 'view' && args[2] === 'pass://S1/I1/totp') out('123456\n');
else { process.stderr.write(`unknown: ${args.join(' ')}\n`); process.exit(1); }
