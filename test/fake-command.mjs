#!/usr/bin/env node
// A custom password source as documented: gets the page URL, prints the matching logins as JSON.
const page = new URL(process.argv[2]);
const logins = page.hostname === '127.0.0.1'
  ? [{ url: 'http://127.0.0.1/login', username: 'ann@example.com', password: 'S3cret pass&"42', totp: '123456', title: 'Fixture shop' }]
  : [];
process.stdout.write(JSON.stringify(logins));
