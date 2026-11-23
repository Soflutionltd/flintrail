// A small multi-page site used by tests and benchmarks: a form, a client-rendered step and a JSON API.
import { createServer } from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:40px;max-width:640px}input,select,button{font:inherit;padding:6px;margin:4px 0;display:block}</style></head>
<body>${body}</body></html>`;

export function startFixture(port = 0) {
  const orders = [];
  const visits = { count: 0 };
  /** Requests worth checking afterwards, as "host path". */
  const hits = [];
  /** Tests flip this to make /switch lead to another site. */
  const state = { away: '' };
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
    if (url.pathname === '/login') return html('Sign in', `<h1>Sign in</h1>
      <form id="f">
        <label>Email <input name="email" type="email" autocomplete="username"></label>
        <label>Password <input name="password" type="password" autocomplete="current-password"></label>
        ${url.searchParams.get('otp') === '0' ? '' : '<label>Code <input name="otp" autocomplete="one-time-code" inputmode="numeric"></label>'}
        <button>Sign in</button>
      </form>
      <p id="out"></p>
      <script>
        f.onsubmit = async (e) => {
          e.preventDefault();
          const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: f.email.value, password: f.password.value, ...(f.otp ? { otp: f.otp.value } : {}) }) });
          const j = await r.json();
          out.textContent = j.ok ? 'Welcome ' + j.email : 'Wrong credentials';
        };
      </script>`);
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
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, orders, visits, hits, state, url: `http://127.0.0.1:${server.address().port}` })));
}
