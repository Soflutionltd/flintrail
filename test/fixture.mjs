// A small multi-page site used by tests and benchmarks: a form, a client-rendered step and a JSON API.
import { createServer } from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:40px;max-width:640px}input,select,button{font:inherit;padding:6px;margin:4px 0;display:block}</style></head>
<body>${body}</body></html>`;

export function startFixture(port = 0) {
  const orders = [];
  const visits = { count: 0 };
  /** Passwords posted to the two-step sign-in, to check which account's password was sent. */
  const attempts = [];
  /** Requests worth checking afterwards, as "host path". */
  const hits = [];
  /** Tests flip this to make /switch lead to another site. */
  const state = { away: '' };
  /** E-mails the fake webmails show, newest first once sorted: { id, from, name, subject, at (ms), html }. */
  const mails = [];
  /** Codes posted to the verification form. */
  const codes = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = (t, b) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(t, b)); };
    if (url.pathname === '/') return html('Shop', `<h1>Parking permit</h1>
      <form action="/details" method="get">
        <label>Plate <input name="plate" placeholder="AB-123-CD"></label>
        <label>Zone <select name="zone"><option value="7">Paris 7</option><option value="15">Paris 15</option></select></label>
        <label><input type="checkbox" name="handi" value="1"> Disabled badge</label>
        <button type="submit">Continue</button>
      </form>`);
    if (url.pathname === '/details') return html('Details', `<h1>Confirm</h1>
      <p id="summary">Plate ${url.searchParams.get('plate')} zone ${url.searchParams.get('zone')} handi ${url.searchParams.get('handi') || 0}</p>
      <div id="app">Loading…</div>
      <script>
        setTimeout(() => {
          document.getElementById('app').innerHTML = '<button data-testid="confirm">Confirm 24h</button>';
          document.querySelector('[data-testid=confirm]').onclick = async () => {
            const r = await fetch('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ plate: ${JSON.stringify(url.searchParams.get('plate'))}, zone: ${JSON.stringify(url.searchParams.get('zone'))} }) });
            const j = await r.json();
            document.getElementById('app').innerHTML = '<h2 id="done">Ticket ' + j.ticket + ' active</h2>';
          };
        }, 300);
      </script>`);
    if (url.pathname === '/search') return html('Search', `<h1>Search</h1>
      <div id="box"><input name="q" placeholder="Search the shop"></div><p id="out"></p>
      <script>
        // Like many real sites, the input is re-created after the first keystroke.
        const bind = (el) => el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') document.getElementById('out').textContent = 'Results for ' + el.value;
        });
        const first = document.querySelector('input');
        bind(first);
        first.addEventListener('input', () => {
          const clone = first.cloneNode(); clone.value = first.value;
          first.replaceWith(clone); bind(clone); clone.focus();
        }, { once: true });
      </script>`);
    if (url.pathname === '/upload') return html('Upload', `<h1>Import</h1>
      <input type="file" id="file" multiple hidden>
      <button type="button" onclick="document.getElementById('file').click()">Choose files</button>
      <p id="got"></p>
      <script>
        document.getElementById('file').onchange = (e) => {
          document.getElementById('got').textContent = 'Got ' + [...e.target.files].map((f) => f.name + ':' + f.size).join(',');
        };
      </script>`);
    if (url.pathname === '/dialogs') return html('Dialogs', `<h1>Dialogs</h1>
      <button type="button" onclick="out.textContent = confirm('Really delete?') ? 'Deleted' : 'Kept'">Delete</button>
      <button type="button" onclick="out.textContent = 'Hello ' + prompt('Your name?')">Greet</button>
      <p id="out"></p>`);
    if (url.pathname === '/canvas') return html('Canvas', `<h1>Canvas</h1>
      <div id="zone" style="position:fixed;left:100px;top:200px;width:120px;height:60px;background:#eee"></div>
      <p id="hit"></p>
      <script>
        document.getElementById('zone').onclick = (e) => { document.getElementById('hit').textContent = 'Hit ' + e.clientX + ',' + e.clientY; };
        console.error('boom from the page');
        console.warn('careful');
        setTimeout(() => { throw new Error('uncaught kaboom'); }, 0);
      </script>`);
    // A page showing a freshly created token once, as GitHub or Cloudflare do (the value comes from the test).
    if (url.pathname === '/rows') return html('Tokens', `<h1>API tokens</h1>
      <table><tr><td>alpha-token</td><td>Created today</td><td><button>Delete</button></td></tr>
        <tr><td>beta-token</td><td>Created yesterday</td><td><button>Delete</button></td></tr></table>
      <button id="removeAll">Remove all</button><p id="out"></p>
      <div id="modal" role="dialog" aria-modal="true" aria-label="Remove all tokens?" hidden><p>This cannot be undone.</p><button id="no">Cancel</button><button>Delete</button></div>
      <div id="busy" hidden>Working…</div>
      <script>
        for (const b of document.querySelectorAll('td button')) b.onclick = () => { out.textContent = 'deleted ' + b.closest('tr').cells[0].textContent; };
        removeAll.onclick = () => { modal.hidden = false; };
        no.onclick = () => { modal.hidden = true; };
        modal.querySelector('button:last-child').onclick = () => {
          modal.hidden = true; busy.hidden = false;
          setTimeout(() => { busy.hidden = true; out.textContent = 'all deleted'; }, 700);
        };
      </script>`);
    if (url.pathname === '/drag') return html('Board', `<h1>Board</h1>
      <div id="todo" class="col" style="min-height:80px;border:1px solid #999"><div id="card" draggable="true" style="padding:8px;background:#eee">Write tests</div></div>
      <div id="done" class="col" style="min-height:80px;border:1px solid #999;margin-top:20px">Done</div>
      <script>
        card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'card'));
        for (const col of document.querySelectorAll('.col')) {
          col.addEventListener('dragover', (e) => e.preventDefault());
          col.addEventListener('drop', (e) => { e.preventDefault(); col.append(card); });
        }
      </script>`);
    if (url.pathname === '/stock') return html('Stock level', `<h1>Stock level</h1><button type="button" id="load">Load</button><p id="out"></p>
      <script>
        document.getElementById('load').onclick = async () => {
          const out = document.getElementById('out');
          const t0 = Date.now();
          try {
            const r = await fetch('/api/stock');
            out.textContent = r.status + ' ' + (await r.text()) + ' in ' + (Date.now() - t0) + ' ms';
          } catch (e) { out.textContent = 'network error'; }
        };
      </script>`);
    if (url.pathname === '/api/stock') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"left":12}'); }
    if (url.pathname === '/env') return html('Environment', `<h1>Environment</h1><p id="out"></p>
      <script>
        const read = () => JSON.stringify({ width: screen.width, touch: navigator.maxTouchPoints, ua: navigator.userAgent, lang: navigator.language,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone, dark: matchMedia('(prefers-color-scheme: dark)').matches, online: navigator.onLine });
        window.env = read;
      </script>`);
    if (url.pathname === '/paste-form') return html('Deploy settings', `<h1>Deploy settings</h1>
      <form id="f" method="post"><label>API key <input type="password" name="key"></label><label>Note <input name="note"></label><label>Email <input type="email" name="mail"></label><button>Save</button></form>
      <form action="/search"><label>Search <input name="q"></label></form>
      <form method="post" action="https://elsewhere.example/collect"><label>Other site <input name="o"></label></form>
      <p id="out"></p>
      <script>f.onsubmit = (e) => { e.preventDefault(); out.textContent = 'saved ' + f.key.value.length + ' characters'; window.savedKey = f.key.value; };</script>`);
    if (url.pathname === '/token-created') {
      const shown = (url.searchParams.getAll('t')).map((t) => `<p>Make sure to copy it now.</p><code>${t}</code><button aria-label="Copy">Copy</button>`).join('')
        // Values the page does not show: a hidden field, a password field, a hidden element's attribute.
        + (url.searchParams.getAll('h')).map((h) => `<input type="hidden" value="${h}"><input type="password" value="${h}"><span hidden title="${h}">x</span>`).join('');
      return html('Token created', `<h1>Token created</h1>${shown}`);
    }
    if (url.pathname === '/login') return html('Sign in', `<h1>Sign in</h1>
      <form id="f"${url.searchParams.get('get') === '1' ? ' method="get"' : ''}>
        <label>Email <input name="email" type="email" autocomplete="username"></label>
        <label>Password <input name="password" type="password" autocomplete="current-password"></label>
        ${url.searchParams.get('otp') === '0' ? '' : '<label>Code <input name="otp" autocomplete="one-time-code" inputmode="numeric"></label>'}
        <button>Sign in</button>
      </form>
      <p id="out"></p>
      <script>
        f.onsubmit = async (e) => {
          e.preventDefault();
          // A careless site logs what was typed: the console Rocketwright returns must still mask it.
          console.log('signing in with', f.password.value, f.otp ? f.otp.value : '');
          const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: f.email.value, password: f.password.value, ...(f.otp ? { otp: f.otp.value } : {}) }) });
          const j = await r.json();
          out.textContent = j.ok ? 'Welcome ' + j.email : 'Wrong credentials';
        };
      </script>`);
    // Second step of a sign-in in two pages: the account is already chosen and shown, only the password is asked.
    if (url.pathname === '/login-step') return html('Password', `<h1>Welcome</h1>
      ${url.searchParams.get('pad') ? Array.from({ length: Number(url.searchParams.get('pad')) }, () => '<i>.</i>').join('') : ''}
      <p id="who">${url.searchParams.get('as') || ''}</p>
      ${url.searchParams.get('label') ? `<button type="button" aria-label="Account: ${url.searchParams.get('label')}">A</button>` : ''}
      ${url.searchParams.get('note') ? `<p>${url.searchParams.get('note')}</p>` : ''}
      ${url.searchParams.get('long') ? `<p>${'lorem ipsum '.repeat(Number(url.searchParams.get('long')))}</p>` : ''}
      ${url.searchParams.get('hidden') ? `<p style="display:none">${url.searchParams.get('hidden')}</p><p hidden>${url.searchParams.get('hidden')}</p>
        <p style="position:absolute;left:-9999px">${url.searchParams.get('hidden')}</p><select><option>${url.searchParams.get('hidden')}</option></select>
        <span aria-hidden="true">${url.searchParams.get('hidden')}</span><i style="display:none" title="${url.searchParams.get('hidden')}"></i>` : ''}
      ${url.searchParams.get('frame') ? `<iframe src="${url.searchParams.get('frame')}" width="300" height="120"></iframe>` : ''}
      ${url.searchParams.get('support') ? '<footer>Need help? <a href="mailto:help@example.com">help@example.com</a></footer>' : ''}
      <form id="f"><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Next</button></form>
      <p id="out"></p>
      <script>
        f.onsubmit = async (e) => {
          e.preventDefault();
          await fetch('/api/login-step', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: who.textContent, password: f.password.value }) });
          out.textContent = 'Step done';
        };
      </script>`);
    if (url.pathname === '/api/login-step' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { attempts.push(JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
      return;
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const o = JSON.parse(b || '{}');
        hits.push(`${(req.headers.host || '').split(':')[0]} /api/login`);
        const ok = o.email === 'ann@example.com' && o.password === 'S3cret pass&"42' && (o.otp === undefined || o.otp === '123456');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok, email: o.email }));
      });
      return;
    }
    if (url.pathname === '/api/order' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const o = JSON.parse(b || '{}');
        // A plate the server chokes on: the request arrived, the answer is an error.
        // A session that expired: like many sites, the API sends the caller to the sign-in page.
        if (o.plate === 'EXPIRED') { res.writeHead(302, { location: '/login' }); return res.end(); }
        if (o.plate === 'BOOM') { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('server error'); }
        const ticket = 'T' + (1000 + orders.length);
        orders.push({ ...o, ticket });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ticket, plate: o.plate }));
      });
      return;
    }
    // A site whose API wants a token only its own page script knows: a direct call without it is refused.
    if (url.pathname === '/guarded') return html('Guarded', `<h1>Guarded order</h1>
      <label>Plate <input name="plate"></label>
      <button type="button" id="go">Order</button><p id="out"></p>
      <script>
        go.onclick = async () => {
          const r = await fetch('/api/guarded', { method: 'POST', headers: { 'content-type': 'application/json', 'x-page-token': 'tok-' + Date.now() },
            body: JSON.stringify({ plate: document.querySelector('input').value }) });
          out.textContent = r.ok ? 'Guarded order done' : 'Refused';
        };
      </script>`);
    if (url.pathname === '/api/guarded' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        if (!req.headers['x-page-token']) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":"token"}'); }
        orders.push({ ...JSON.parse(b || '{}'), guarded: true });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    // A classic form posted by page navigation, then a button that calls the API.
    if (url.pathname === '/native') return html('Native', `<h1>Basket</h1>
      <form method="post" action="/native-step"><button>Add to basket</button></form>`);
    if (url.pathname === '/native-step' && req.method === 'POST') {
      req.resume();
      return html('Pay', `<h1>Pay</h1><button type="button" id="pay">Pay</button><p id="out"></p>
        <script>
          pay.onclick = async () => {
            await fetch('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plate: 'NATIVE' }) });
            out.textContent = 'Paid';
          };
        </script>`);
    }
    // An API with the record ID in its path, a query string and a number in its body.
    if (url.pathname === '/items') return html('Items', `<h1>Stock</h1>
      <label>Item <input name="item"></label><label>Quantity <input name="qty"></label>
      <button type="button" id="save">Save</button><p id="out"></p>
      <script>
        save.onclick = async () => {
          const [item, qty] = [...document.querySelectorAll('input')].map((i) => i.value);
          await fetch('/api/items/' + encodeURIComponent(item) + '?mode=fast', { method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ qty: Number(qty), unit: 'box' }) });
          out.textContent = 'Stock saved';
        };
      </script>`);
    if (url.pathname.startsWith('/api/items/') && req.method === 'PUT') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        orders.push({ item: decodeURIComponent(url.pathname.slice('/api/items/'.length)), mode: url.searchParams.get('mode'), ...JSON.parse(b || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    // A request that carries a session token next to its data.
    if (url.pathname === '/tokened') return html('Tokened', `<h1>Tokened</h1><button type="button" id="send">Send</button><p id="out"></p>
      <script>
        send.onclick = async () => {
          await fetch('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plate: 'TK-1', csrf: 'abc123' }) });
          out.textContent = 'Sent';
        };
      </script>`);
    // Ways off the site: a link and a redirect to the address given in ?to=.
    if (url.pathname === '/away') return html('Away', `<h1>Leaving</h1><a id="out" href="${url.searchParams.get('to')}">Partner site</a>`);
    if (url.pathname === '/bounce') { res.writeHead(302, { location: url.searchParams.get('to') }); return res.end(); }
    if (url.pathname === '/secret') return html('Secret', `<h1>Other site secret</h1><a href="/x">Private link one</a>
      <button type="button" id="ob" onclick="fetch('/clicked')">Other button</button>
      <script>fetch('/api/secret.json')</script>`);
    if (url.pathname === '/api/secret.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"secret":"TOPSECRET-JSON"}'); }
    if (['/clicked', '/inner-clicked', '/sink'].includes(url.pathname)) { req.resume(); hits.push(`${(req.headers.host || '').split(':')[0]} ${url.pathname}`); res.writeHead(204, { 'access-control-allow-origin': '*' }); return res.end(); }
    // A page that embeds another site first, then a frame of its own.
    if (url.pathname === '/embed') return html('Embed', `<h1>Embedding</h1>
      <iframe id="foreign" src="${url.searchParams.get('to')}" width="400" height="200"></iframe>
      <iframe id="own" src="/inner" width="400" height="120"></iframe>`);
    if (url.pathname === '/inner') return html('Inner', `<button type="button" onclick="fetch('/inner-clicked')">Inner button</button>`);
    // A link whose destination the test changes between recording and replay.
    if (url.pathname === '/hop') return html('Hop', '<h1>Hop</h1><a id="next" href="/switch">Next</a>');
    if (url.pathname === '/switch') { res.writeHead(302, { location: state.away || '/landing' }); return res.end(); }
    if (url.pathname === '/landing') return html('Landing', '<h1>Landed here</h1>');
    // Links and scripts that open another tab.
    if (url.pathname === '/opener') return html('Opener', `<h1>Opener</h1><a id="link" href="/landing?k=abcdefgh12345678" target="_blank">Open landing</a>
      <button type="button" id="pop" onclick="window.open('/search')">Pop search</button>`);
    if (url.pathname === '/dl') return html('Files', `<a id="get" href="${url.searchParams.get('to')}">Get the file</a>`);
    if (url.pathname === '/file') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.bin"' }); return res.end('FILE-CONTENT'); }
    if (url.pathname === '/based') return html('Based', `<base href="${url.searchParams.get('to')}"><h1>Based</h1>`);
    if (url.pathname === '/redir307') { req.resume(); res.writeHead(307, { location: url.searchParams.get('to') }); return res.end(); }
    // A long list where one action changes little: one row is edited, one is added, one is removed.
    if (url.pathname === '/board') return html('Board', `<h1>Board</h1><p id="status">Idle</p>
      <ul id="rows">${Array.from({ length: 40 }, (_, i) => `<li><button type="button" class="row">Task ${i + 1}</button></li>`).join('')}</ul>
      <button type="button" id="rename">Rename first</button><button type="button" id="add">Add task</button>
      <button type="button" id="drop">Drop last</button><button type="button" id="reset">Replace all</button>
      <script>
        const rows = document.getElementById('rows');
        const say = document.getElementById('status');
        document.getElementById('rename').onclick = () => { rows.querySelector('.row').textContent = 'Task renamed'; };
        document.getElementById('add').onclick = () => { rows.insertAdjacentHTML('beforeend', '<li><button type="button" class="row">Task new</button></li>'); say.textContent = 'Added'; };
        document.getElementById('drop').onclick = () => { rows.lastElementChild.remove(); };
        document.getElementById('reset').onclick = () => { rows.innerHTML = Array.from({ length: 40 }, (_, i) => '<li><button type="button" class="row">Other ' + i + '</button></li>').join(''); };
      </script>`);
    // Changes a difference by ref cannot tell: a list sorted the other way, a heading or a message that goes away.
    if (url.pathname === '/sorted') return html('Sorted', `<h2 id="alert">Error: card declined</h2><p id="note">Payment refused by the bank</p>
      <ul id="fruits"><li><button type="button">Apple</button></li><li><button type="button">Banana</button></li><li><button type="button">Cherry</button></li></ul>
      <button type="button" id="sort">Sort desc</button><button type="button" id="dismiss">Dismiss</button><button type="button" id="clear">Clear note</button>
      <script>
        document.getElementById('sort').onclick = () => { const l = document.getElementById('fruits'); [...l.children].reverse().forEach((c) => l.appendChild(c)); };
        document.getElementById('dismiss').onclick = () => document.getElementById('alert').remove();
        document.getElementById('clear').onclick = () => document.getElementById('note').remove();
      </script>`);
    // A page that reports the visit as soon as it loads, like most sites with audience measurement.
    if (url.pathname === '/measured') return html('Measured', `<h1>Measured</h1>
      <label>Plate <input name="plate"></label><button type="button" id="go">Order</button><p id="out"></p>
      <script>
        fetch('/stats/visit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"page":"measured"}' });
        go.onclick = async () => {
          await fetch('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ plate: document.querySelector('input').value }) });
          out.textContent = 'Measured order done';
        };
      </script>`);
    if (url.pathname === '/stats/visit' && req.method === 'POST') {
      req.resume();
      visits.count++;
      res.writeHead(204);
      return res.end();
    }
    // Fake webmails (served on gmail.localhost and outlook.localhost by the mail tests), built like the real ones.
    if (url.pathname === '/api/mails') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([...mails].sort((a, b) => b.at - a.at)));
    }
    const mailHelpers = `
      const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const sameDay = (d) => d.toDateString() === new Date().toDateString();
      const shortTime = (d) => sameDay(d) ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const load = async () => (await fetch('/api/mails')).json();`;
    if (url.pathname === '/mail/u/0/') return html('Inbox - Gmail', `<div role="main"><table><tbody id="list"></tbody></table></div>
      <div id="view" hidden><h2 class="hP"></h2><div class="gs"><span class="gD"></span> <span class="g2" email="you@acme.localhost">to me</span> <span class="g3"></span><div class="a3s"></div></div></div>
      <script>${mailHelpers}
        const list = document.getElementById('list'), view = document.getElementById('view');
        async function render() {
          const all = await load();
          const h = decodeURIComponent(location.hash.replace(/\\+/g, ' '));
          const m = /^#search\\/(.*?)(?:\\/(m\\d+))?$/.exec(h) || /^#inbox(?:\\/(m\\d+))?$/.exec(h);
          const q = h.startsWith('#search/') ? m[1] : '';
          const open = h.startsWith('#search/') ? m && m[2] : m && m[1];
          const from = (/from:\\(([^)]+)\\)/.exec(q) || [])[1];
          const shown = all.filter((x) => !from || x.from === from || x.from.endsWith('.' + from) || x.from.endsWith('@' + from));
          list.innerHTML = shown.map((x) => '<tr class="zA" data-id="' + x.id + '"><td class="yX"><span class="yP" email="' + esc(x.from) + '" name="' + esc(x.name) + '">' + esc(x.name) + '</span></td>'
            + '<td><span class="bog">' + esc(x.subject) + '</span> <span class="y2">' + esc(x.preview || '') + '</span></td>'
            + '<td class="xW"><span title="' + esc(new Date(x.at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })) + '">' + esc(shortTime(new Date(x.at))) + '</span></td></tr>').join('');
          const mail = open && all.find((x) => x.id === open);
          list.parentElement.hidden = !!mail;
          view.hidden = !mail;
          if (mail) {
            view.querySelector('.hP').textContent = mail.subject;
            const who = view.querySelector('.gD');
            who.setAttribute('email', mail.from);
            who.textContent = mail.name;
            const when = view.querySelector('.g3');
            when.setAttribute('title', new Date(mail.at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
            when.textContent = shortTime(new Date(mail.at));
            view.querySelector('.a3s').innerHTML = mail.html;
          }
        }
        list.onclick = (e) => { const row = e.target.closest('tr.zA'); if (row) location.hash = (location.hash || '#inbox') + '/' + row.dataset.id; };
        addEventListener('hashchange', render);
        if (!location.hash) history.replaceState(null, '', '#inbox');
        render();
      </script>`);
    if (url.pathname.startsWith('/mail/') && !url.pathname.startsWith('/mail/u/')) return html('Mail - Outlook', `<div role="banner"><button aria-label="Account manager for you@acme.localhost">Y</button></div>
      <div role="navigation"><a href="#">Inbox</a></div>
      <div role="main"><div role="listbox" aria-label="Message list" id="list"></div><div id="pane"></div></div>
      <script>${mailHelpers}
        const list = document.getElementById('list'), pane = document.getElementById('pane');
        let all = [];
        async function refresh() {
          all = await load();
          list.innerHTML = all.map((x) => '<div role="option" data-id="' + x.id + '" aria-label="' + esc(x.name + ' ' + x.subject) + '"><span>' + esc(x.name) + '</span> <span>' + esc(x.subject) + '</span> '
            + '<span title="' + esc(new Date(x.at).toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + '">' + esc(shortTime(new Date(x.at))) + '</span> <span>' + esc(x.preview || '') + '</span></div>').join('');
          show();
        }
        function show() {
          const id = (/\\/id\\/(m\\d+)/.exec(location.pathname) || [])[1];
          const mail = all.find((x) => x.id === id);
          pane.innerHTML = mail ? '<div role="heading">' + esc(mail.subject) + '</div><div><span>' + esc(mail.name) + '</span> <span>&lt;' + esc(mail.from) + '&gt;</span></div>'
            + '<div>To: <span>you@acme.localhost</span></div><div data-testid="SentReceivedSavedTime">' + esc(new Date(mail.at).toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + '</div>'
            + '<div aria-label="Message body">' + mail.html + '</div>' : '';
        }
        list.onclick = (e) => { const row = e.target.closest('[role=option]'); if (row) { history.pushState(null, '', '/mail/inbox/id/' + row.dataset.id); show(); } };
        addEventListener('popstate', show);
        refresh();
        setInterval(refresh, 1000);
      </script>`);
    // A form waiting for the code sent by e-mail.
    if (url.pathname === '/code') return html('Verify', `<h1>Check your e-mail</h1>
      <form id="f"><label>Verification code <input name="code" autocomplete="one-time-code" inputmode="numeric"></label><button>Verify</button></form>
      <p id="out"></p>
      <script>
        f.onsubmit = async (e) => {
          e.preventDefault();
          await fetch('/api/code', { method: 'POST', body: f.code.value });
          out.textContent = 'Verified';
        };
      </script>`);
    if (url.pathname === '/api/code' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { codes.push(b); res.writeHead(204); res.end(); });
      return;
    }
    if (url.pathname === '/verify') return html('Verified', `<h1>Your e-mail is verified</h1><p>Welcome aboard.</p>`);
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, orders, visits, hits, state, attempts, mails, codes, url: `http://127.0.0.1:${server.address().port}` })));
}
