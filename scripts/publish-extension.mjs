// Publishes the extension to the Chrome Web Store through its API (v2), with a Google Cloud service account.
//   node scripts/publish-extension.mjs status
//   node scripts/publish-extension.mjs release [zip]   (default: the store zip of the manifest's version)
// The service account key (JSON) comes on standard input with --key -, or in CWS_SERVICE_ACCOUNT_KEY; the publisher
// ID in CWS_PUBLISHER_ID (Soflution's by default). The key is never written to disk or printed. Release cancels a submission still under
// review (the store accepts only one at a time), uploads the zip, waits for it, then submits it for review.
// Doc: https://developer.chrome.com/docs/webstore/using-api and .../service-accounts
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITEM_ID = 'amgonogobcfmneginonbkfjlbbnecchp';
const API = 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const args = process.argv.slice(2);
const command = args[0];
if (!['status', 'release'].includes(command)) {
  console.error('Usage: node scripts/publish-extension.mjs status|release [zip] [--key -]');
  process.exit(2);
}
// Soflution's publisher ID (public: Developer Dashboard, Settings); another publisher sets CWS_PUBLISHER_ID.
const publisher = process.env.CWS_PUBLISHER_ID || '52065e0a-2cb7-451b-9fa7-7c6379e931e9';

async function readKey() {
  let text = process.env.CWS_SERVICE_ACCOUNT_KEY || '';
  if (args.includes('--key') && args[args.indexOf('--key') + 1] === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (!text) throw new Error('No service account key: pass it on standard input with --key -, or in CWS_SERVICE_ACCOUNT_KEY.');
  let key;
  try { key = JSON.parse(text); } catch { throw new Error('The service account key is not valid JSON.'); }
  if (!key.client_email || !key.private_key) throw new Error('The service account key has no client_email or private_key.');
  return key;
}

const b64url = (data) => Buffer.from(data).toString('base64url');

/** An access token for the service account: a signed JWT exchanged at Google's token endpoint. */
async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: key.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`Google refused the service account (${r.status}): ${j.error_description || j.error || 'no access token'}.`);
  return j.access_token;
}

async function call(token, method, path, body, headers = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 300) }; }
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.error?.message || j.raw || ''}`.trim());
  return j;
}

const item = `/v2/publishers/${publisher}/items/${ITEM_ID}`;
const describe = (s) => {
  const rev = (r) => (r ? `${r.state || '?'}${(r.distributionChannels || []).map((c) => ` ${c.crxVersion || ''}`).join('')}` : 'none');
  return `published: ${rev(s.publishedItemRevisionStatus)} | submitted: ${rev(s.submittedItemRevisionStatus)} | last upload: ${s.lastAsyncUploadState || 'none'}`;
};

const key = await readKey();
const token = await accessToken(key);
const status = await call(token, 'GET', `${item}:fetchStatus`);
console.log(`Chrome Web Store, ${ITEM_ID}: ${describe(status)}`);
if (command === 'status') process.exit(0);

const version = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8')).version;
const zip = args[1] && args[1] !== '--key' ? args[1] : join(root, `flintrail-extension-${version}-store.zip`);
if (!existsSync(zip)) throw new Error(`No package at ${zip}: run npm run pack:extension first.`);

// One submission at a time: an older one still under review is withdrawn first.
if (status.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
  await call(token, 'POST', `${item}:cancelSubmission`);
  console.log('Cancelled the submission still under review.');
}
const uploaded = await call(token, 'POST', `/upload${item}:upload`, readFileSync(zip), { 'content-type': 'application/zip' });
let state = uploaded.uploadState;
for (let i = 0; state === 'IN_PROGRESS' && i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  state = (await call(token, 'GET', `${item}:fetchStatus`)).lastAsyncUploadState;
}
if (state !== 'SUCCEEDED') throw new Error(`Upload of ${zip} ended as ${state}.`);
console.log(`Uploaded ${zip} (version ${uploaded.crxVersion || version}).`);
await call(token, 'POST', `${item}:publish`);
console.log(`Submitted for review. ${describe(await call(token, 'GET', `${item}:fetchStatus`))}`);
