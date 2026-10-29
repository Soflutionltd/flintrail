// A small multi-page site used by tests and benchmarks: a form, a client-rendered step and a JSON API.
import { createServer } from 'node:http';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:40px;max-width:640px}input,select,button{font:inherit;padding:6px;margin:4px 0;display:block}</style></head>
<body>${body}</body></html>`;

export function startFixture(port = 0) {
  const orders = [];
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
        <label>Code <input name="otp" autocomplete="one-time-code" inputmode="numeric"></label>
        <button>Sign in</button>
      </form>
      <p id="out"></p>
      <script>
        f.onsubmit = async (e) => {
          e.preventDefault();
          const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: f.email.value, password: f.password.value, otp: f.otp.value }) });
          const j = await r.json();
          out.textContent = j.ok ? 'Welcome ' + j.email : 'Wrong credentials';
        };
      </script>`);
    if (url.pathname === '/api/login' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const o = JSON.parse(b || '{}');
        const ok = o.email === 'ann@example.com' && o.password === 'S3cret pass&"42' && o.otp === '123456';
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
        const ticket = 'T' + (1000 + orders.length);
        orders.push({ ...o, ticket });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ticket, plate: o.plate }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, orders, url: `http://127.0.0.1:${server.address().port}` })));
}
