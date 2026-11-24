// Anything that looks like a credential is masked in what Flintrail returns to the agent, even when Flintrail
// did not fill it: a page showing a new API key in its buttons, a script that reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets, redact } from '../dist/secrets.js';

// Built at run time from parts: fake values only, and no full credential-looking string in the repository
// (GitHub push protection would take it for a real one).
const fake = (prefix, body) => prefix + body;
const secrets = [
  fake('github_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'),
  fake('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
  fake('sk_' + 'live_', '51HxYzAbCdEfGhIjKlMnOpQr'),
  fake('cfut_', 'AbCdEfGhIjKlMnOpQrStUvWx0123'),
  fake('AKIA', 'IOSFODNN7EXAMPLE'),
  fake('eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
];

test('known credential formats are masked', () => {
  for (const s of secrets) {
    const out = maskSecrets(`Your new token: ${s} (copy it now)`);
    assert.ok(!out.includes(s), s);
    assert.match(out, /••• \(secret masked\)/);
  }
});

test('a long value shown next to a word announcing a secret is masked, as Cloudflare shows R2 keys', () => {
  const r2 = 'Secret Access Key\tbutton "e4b8c9d2f1a07b3e6c5d4e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1"';
  assert.ok(!maskSecrets(r2).includes('e4b8c9d2f1a07b3e6c5d4e2f1a0b9c8d'));
  const id = 'Access Key ID: 3f9a1c2b4d5e6f708192a3b4c5d6e7f8';
  assert.ok(!redact(id).includes('3f9a1c2b4d5e6f708192a3b4c5d6e7f8'));
});

test('ordinary text and short ids are left alone', () => {
  const plain = 'Repository settings · 42 commits · Commit 1a2b3c4 · Personal access tokens (classic)';
  assert.equal(maskSecrets(plain), plain);
  const url = 'URL: https://github.com/settings/personal-access-tokens/new';
  assert.equal(maskSecrets(url), url);
});
