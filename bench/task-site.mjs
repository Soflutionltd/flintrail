// Local copies of four everyday agent tasks, for the benchmark: a GitHub-style fine-grained token, a
// Cloudflare-style API token with several permission rows, and a 30-field form (the sign-in task uses the test
// fixture's /login). Each page checks what it received, so "done" means done right.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

/** What each task must enter: the same values for every tool. */
export const GH = { name: 'ci-deploy', expiration: '30', description: 'Deploys from CI', access: 'all',
  permissions: { contents: 'read', metadata: 'read', pulls: 'write' } };
export const CF = { name: 'workers-deploy', rows: [['account', 'workers', 'edit'], ['zone', 'dns', 'edit'], ['account', 'settings', 'read']],
  zone: 'example.com', start: '2026-12-01', end: '2026-12-31' };
export const FORM = {
  first: 'Ada', last: 'Martin', email: 'ada@example.com', phone: '+33 6 12 34 56 78', birth: '1990-04-12',
  company: 'Example Studio', title: 'Product lead', website: 'https://example.com', street: '12 rue de la Paix',
  street2: 'Bâtiment B', city: 'Lyon', region: 'Rhône', postal: '69002', country: 'FR', language: 'fr',
  timezone: 'Europe/Paris', size: '11-50', industry: 'software', contact: 'email', budget: '10k-50k',
  start: '2027-01-15', referral: 'friend', hours: 'morning', linkedin: 'https://linkedin.com/in/ada',
  github: 'adamartin', vat: 'FR12345678901', message: 'We would like a demo for our team.',
  notes: 'Prefers French.', newsletter: true, terms: true,
};

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px system-ui;margin:24px;max-width:760px}label{display:block;margin:8px 0}fieldset{margin:12px 0}
[role=dialog]{position:fixed;inset:20% 25%;background:#fff;border:1px solid #888;padding:20px}</style></head><body>${body}</body></html>`;

const option = (v, label = v) => `<option value="${v}">${label}</option>`;
const access = ['No access', 'Read-only', 'Read and write'];
const levelOf = { 'No access': 'none', 'Read-only': 'read', 'Read and write': 'write' };

function githubPage() {
  const perm = (key, label) => `<label>${label} <select name="perm-${key}" aria-label="${label}">${access.map((a) => option(levelOf[a], a)).join('')}</select></label>`;
  return page('New fine-grained personal access token', `<h1>New fine-grained personal access token</h1>
  <form id="f">
    <label>Token name <input name="name" required></label>
    <label>Expiration <select name="expiration">${['7', '30', '60', '90'].map((d) => option(d, `${d} days`)).join('')}</select></label>
    <label>Description <textarea name="description"></textarea></label>
    <fieldset><legend>Repository access</legend>
      <label><input type="radio" name="access" value="public" checked> Public repositories</label>
      <label><input type="radio" name="access" value="all"> All repositories</label>
      <label><input type="radio" name="access" value="select"> Only select repositories</label>
    </fieldset>
    <fieldset><legend>Repository permissions</legend>
      ${perm('actions', 'Actions')}${perm('contents', 'Contents')}${perm('issues', 'Issues')}${perm('metadata', 'Metadata')}${perm('pulls', 'Pull requests')}
    </fieldset>
    <button type="button" id="generate-token">Generate token</button>
  </form>
  <div role="dialog" aria-label="Generate token?" hidden><p>This token will expire. Generate it now?</p><button type="button" id="confirm-token">Generate token</button></div>
  <section id="out"></section>
  <script>
    const $ = (id) => document.getElementById(id);
    $('generate-token').onclick = () => { document.querySelector('[role=dialog]').hidden = false; };
    $('confirm-token').onclick = async () => {
      document.querySelector('[role=dialog]').hidden = true;
      const r = await fetch('/api/github-token', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData($('f')))) });
      const j = await r.json();
      $('out').innerHTML = j.ok ? '<h2>Token created</h2><p>Make sure to copy your token now.</p><code>' + j.token + '</code>' : '<h2>Wrong settings</h2>';
    };
  </script>`);
}

function cloudflarePage() {
  return page('Create Custom Token', `<h1>Create Custom Token</h1>
  <div id="form">
    <label>Token name <input id="name"></label>
    <fieldset><legend>Permissions</legend><div id="rows"></div><button type="button" id="add">+ Add more</button></fieldset>
    <fieldset><legend>Zone Resources</legend>
      <label>Zone resources <select id="zone"><option value="all">All zones</option><option value="example.com">Specific zone: example.com</option><option value="example.org">Specific zone: example.org</option></select></label>
    </fieldset>
    <fieldset><legend>TTL</legend><label>Start date <input id="start" type="date"></label><label>End date <input id="end" type="date"></label></fieldset>
    <button type="button" id="summary">Continue to summary</button>
  </div>
  <div id="review" hidden><h2>Summary</h2><ul id="list"></ul><button type="button" id="create">Create Token</button></div>
  <section id="out"></section>
  <script>
    const $ = (id) => document.getElementById(id);
    const items = { account: ['settings', 'workers'], zone: ['dns', 'cache'] };
    const names = { settings: 'Account Settings', workers: 'Workers Scripts', dns: 'DNS', cache: 'Cache Purge' };
    let n = 0;
    function addRow() {
      n++;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<select aria-label="Permission ' + n + ' scope"><option value="account">Account</option><option value="zone">Zone</option></select>' +
        '<select aria-label="Permission ' + n + ' item"></select>' +
        '<select aria-label="Permission ' + n + ' level"><option value="read">Read</option><option value="edit">Edit</option></select>';
      const [scope, item] = row.querySelectorAll('select');
      const fill = () => { item.innerHTML = items[scope.value].map((i) => '<option value="' + i + '">' + names[i] + '</option>').join(''); };
      scope.onchange = fill; fill();
      $('rows').append(row);
    }
    addRow();
    $('add').onclick = addRow;
    const state = () => ({ name: $('name').value, zone: $('zone').value, start: $('start').value, end: $('end').value,
      rows: [...$('rows').children].map((r) => [...r.querySelectorAll('select')].map((s) => s.value)) });
    $('summary').onclick = () => {
      const s = state();
      $('list').innerHTML = s.rows.map((r) => '<li>' + r.join(' / ') + '</li>').join('');
      $('form').hidden = true; $('review').hidden = false;
    };
    $('create').onclick = async () => {
      const r = await fetch('/api/cloudflare-token', { method: 'POST', body: JSON.stringify(state()) });
      const j = await r.json();
      $('review').hidden = true;
      $('out').innerHTML = j.ok ? '<h2>Token created</h2><code>' + j.token + '</code>' : '<h2>Wrong settings</h2>';
    };
  </script>`);
}

function formPage() {
  const text = (name, label, type = 'text') => `<label>${label} <input name="${name}" type="${type}"></label>`;
  const select = (name, label, opts) => `<label>${label} <select name="${name}"><option value="">Choose…</option>${opts.map(([v, l]) => option(v, l)).join('')}</select></label>`;
  const radios = (name, label, opts) => `<fieldset><legend>${label}</legend>${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}"> ${l}</label>`).join('')}</fieldset>`;
  return page('Request a demo', `<h1>Request a demo</h1><form id="f">
    ${text('first', 'First name')}${text('last', 'Last name')}${text('email', 'Email', 'email')}${text('phone', 'Phone', 'tel')}${text('birth', 'Date of birth', 'date')}
    ${text('company', 'Company')}${text('title', 'Job title')}${text('website', 'Website', 'url')}${text('street', 'Street')}${text('street2', 'Address line 2')}
    ${text('city', 'City')}${text('region', 'State or region')}${text('postal', 'Postal code')}
    ${select('country', 'Country', [['FR', 'France'], ['BE', 'Belgium'], ['CH', 'Switzerland'], ['GB', 'United Kingdom']])}
    ${select('language', 'Language', [['fr', 'French'], ['en', 'English'], ['de', 'German']])}
    ${select('timezone', 'Time zone', [['Europe/Paris', 'Paris'], ['Europe/London', 'London'], ['America/New_York', 'New York']])}
    ${radios('size', 'Team size', [['1-10', '1 to 10'], ['11-50', '11 to 50'], ['51-200', '51 to 200']])}
    ${select('industry', 'Industry', [['software', 'Software'], ['retail', 'Retail'], ['health', 'Health']])}
    ${radios('contact', 'Preferred contact', [['email', 'Email'], ['phone', 'Phone']])}
    ${select('budget', 'Budget', [['lt10k', 'Under 10k'], ['10k-50k', '10k to 50k'], ['gt50k', 'Over 50k']])}
    ${text('start', 'Desired start date', 'date')}
    ${select('referral', 'How did you hear about us?', [['search', 'Search engine'], ['friend', 'A friend'], ['event', 'An event']])}
    ${select('hours', 'Best time to call', [['morning', 'Morning'], ['afternoon', 'Afternoon']])}
    ${text('linkedin', 'LinkedIn profile', 'url')}${text('github', 'GitHub username')}${text('vat', 'VAT number')}
    <label>Message <textarea name="message"></textarea></label><label>Notes <textarea name="notes"></textarea></label>
    <label><input type="checkbox" name="newsletter"> Send me the newsletter</label>
    <label><input type="checkbox" name="terms"> I accept the terms</label>
    <button>Send request</button></form><p id="out"></p>
  <script>
    const form = document.getElementById('f');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      d.newsletter = !!d.newsletter; d.terms = !!d.terms;
      const r = await fetch('/api/form', { method: 'POST', body: JSON.stringify(d) });
      document.getElementById('out').textContent = (await r.json()).ok ? 'Thanks, request received' : 'Some answers are wrong';
    };
  </script>`);
}

const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(JSON.parse(b || '{}'))); });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function startTaskSite() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (type, text) => { res.writeHead(200, { 'content-type': type }); res.end(text); };
    if (url.pathname === '/github-token') return send('text/html', githubPage());
    if (url.pathname === '/cloudflare-token') return send('text/html', cloudflarePage());
    if (url.pathname === '/form') return send('text/html', formPage());
    if (req.method === 'POST' && url.pathname === '/api/github-token') {
      const d = await body(req);
      const ok = d.name === GH.name && d.expiration === GH.expiration && d.description === GH.description && d.access === GH.access
        && d['perm-contents'] === 'read' && d['perm-metadata'] === 'read' && d['perm-pulls'] === 'write' && d['perm-actions'] === 'none' && d['perm-issues'] === 'none';
      return send('application/json', JSON.stringify({ ok, token: ok ? `github_pat_${randomBytes(30).toString('base64url')}` : '' }));
    }
    if (req.method === 'POST' && url.pathname === '/api/cloudflare-token') {
      const d = await body(req);
      const ok = d.name === CF.name && same(d.rows, CF.rows) && d.zone === CF.zone && d.start === CF.start && d.end === CF.end;
      return send('application/json', JSON.stringify({ ok, token: ok ? randomBytes(30).toString('base64url').slice(0, 40) : '' }));
    }
    if (req.method === 'POST' && url.pathname === '/api/form') {
      const d = await body(req);
      return send('application/json', JSON.stringify({ ok: same(Object.keys(FORM).sort().map((k) => d[k]), Object.keys(FORM).sort().map((k) => FORM[k])) }));
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
