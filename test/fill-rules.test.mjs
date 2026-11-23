// Fixed rules of password filling, whatever the settings: HTTPS only, one site per login, no bank items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillProblem, siteOf } from '../dist/login.js';
import { assertLoginItem } from '../dist/passwords.js';

test('secrets are sent over HTTPS only, or to this computer', () => {
  assert.equal(fillProblem('https://github.com/sessions/sudo'), null);
  assert.equal(fillProblem('http://127.0.0.1:8080/login'), null);
  assert.equal(fillProblem('http://localhost/login'), null);
  assert.match(fillProblem('http://github.com/login'), /plain HTTP/);
  assert.match(fillProblem('chrome-extension://abc/options.html'), /never filled/);
  assert.match(fillProblem('not a url'), /not a web page/);
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
