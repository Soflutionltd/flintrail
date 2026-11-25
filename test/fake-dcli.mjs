#!/usr/bin/env node
// Stands in for Dashlane CLI (dcli) in tests, with its documented output: `dcli password <filter> -o json` prints the
// matching credentials (VaultCredential), `-f otp -o console` prints the current code.
const args = process.argv.slice(2);
const cred = { id: 'dl-1', title: 'Fixture shop', login: 'ann@example.com', email: 'ann@example.com', password: 'S3cret pass&"42', url: 'http://127.0.0.1/login', otpSecret: 'JBSWY3DPEHPK3PXP' };
const note = { id: 'dl-2', title: 'Elsewhere', login: 'bob@example.com', password: 'other', url: 'https://elsewhere.example/login' };
if (args[0] !== 'password') { process.stderr.write('unknown command\n'); process.exit(1); }
const filter = args[1];
const matches = filter === 'id=dl-1' ? [cred] : [cred, note].filter((c) => c.url.includes(filter) || c.title.includes(filter));
if (args.includes('-f') && args[args.indexOf('-f') + 1] === 'otp') process.stdout.write('123456 (expires in 21 seconds)\n');
else process.stdout.write(JSON.stringify(matches));
