// Fixed rules of password filling, whatever the settings: HTTPS or this computer only, one site per login, no bank items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalNames, fillProblem, keysOf, siteOf } from '../dist/login.js';
import { assertLoginItem, savedHostOf } from '../dist/passwords.js';

test('secrets are sent over HTTPS only, or to this computer', () => {
  assert.equal(fillProblem('https://github.com/sessions/sudo'), null);
  assert.equal(fillProblem('http://127.0.0.1:8080/login'), null);
  assert.equal(fillProblem('http://localhost/login'), null);
  assert.match(fillProblem('http://github.com/login'), /plain HTTP/);
  assert.match(fillProblem('chrome-extension://abc/options.html'), /never filled/);
  assert.match(fillProblem('not a url'), /not a web page/);
});

test('development addresses of this computer are filled over plain HTTP, a *.test name only when it points here', async () => {
  assert.equal(fillProblem('http://admin.localhost:5173/login'), null);
  assert.equal(fillProblem('http://[::1]:3000/login'), null);
  assert.match(fillProblem('http://shop.test/login'), /does not point to this computer only/);
  await checkLocalNames(['http://shop.test/login'], async () => ['127.0.0.1']);
  assert.equal(fillProblem('http://shop.test/login'), null);
  // A name moved to another machine: plain HTTP would cross the network again.
  await checkLocalNames(['http://shop.test/login'], async () => ['127.0.0.1', '192.168.1.20']);
  assert.match(fillProblem('http://shop.test/login'), /does not point to this computer only/);
  await checkLocalNames(['http://gone.test/login'], async () => { throw new Error('ENOTFOUND'); });
  assert.match(fillProblem('http://gone.test/login'), /does not point to this computer only/);
  // Over HTTPS the name may point anywhere: the connection is encrypted.
  assert.equal(fillProblem('https://shop.test/login'), null);
});

test('a login saved with a local port fits that app only, one saved without a port fits every port', () => {
  assert.equal(savedHostOf('http://localhost:5191/admin'), 'localhost:5191');
  assert.equal(savedHostOf('http://localhost/admin'), 'localhost');
  assert.equal(savedHostOf('https://app.example.com:8443/'), 'app.example.com');
  const fits = (saved, page) => keysOf(page).has(siteOf(savedHostOf(saved)));
  assert.equal(fits('http://localhost:5191', 'http://localhost:5191/admin/login'), true);
  assert.equal(fits('http://localhost:5191', 'http://localhost:3000/login'), false);
  assert.equal(fits('http://localhost', 'http://localhost:3000/login'), true);
  assert.equal(fits('https://ideekdo.test:5173', 'https://ideekdo.test:5173/admin'), true);
  assert.equal(fits('https://ideekdo.test:5173', 'https://ideekdo.test/admin'), false);
  // A public website is still matched by its site, port or not.
  assert.equal(fits('https://github.com', 'https://github.com:443/login'), true);
  assert.equal(fits('https://soflution.com', 'http://localhost:5191/admin/login'), false);
});

test('a login is for its own site only, public suffixes included', () => {
  assert.equal(siteOf('accounts.google.com'), 'google.com');
  assert.equal(siteOf('www.amazon.co.uk'), 'amazon.co.uk');
  // Two GitHub Pages sites belong to two different people.
  assert.notEqual(siteOf('alice.github.io'), siteOf('bob.github.io'));
  assert.equal(siteOf('127.0.0.1'), '127.0.0.1');
});

test('payment cards and bank accounts are refused', () => {
  assert.doesNotThrow(() => assertLoginItem('1Password', 'GitHub', 'LOGIN'));
  assert.throws(() => assertLoginItem('1Password', 'Company card', 'CREDIT_CARD'), /credit card\. Flintrail only fills logins/);
  assert.throws(() => assertLoginItem('1Password', 'Bank', 'BANK_ACCOUNT'), /bank account/);
});

test('the desktop tools never drive browsers, password managers, terminals or system settings', async () => {
  const { assertDesktopAllowed } = await import('../dist/desktop.js');
  assert.doesNotThrow(() => assertDesktopAllowed('Calculator', 'com.apple.calculator'));
  for (const [name, bundle] of [['Brave Browser', 'com.brave.Browser'], ['Google Chrome', 'com.google.Chrome'], ['1Password', 'com.1password.1password'],
    ['Terminal', 'com.apple.Terminal'], ['Réglages Système', 'com.apple.systempreferences'], ['Trousseau d’accès', 'com.apple.keychainaccess'], ['Cursor', undefined]]) {
    assert.throws(() => assertDesktopAllowed(name, bundle), /never drives browsers/, name);
  }
});
