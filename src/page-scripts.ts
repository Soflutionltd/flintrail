// Functions in this file are serialized and executed inside the page.
// They must be fully self-contained: no imports, no outer variables.

export interface SnapshotOptions {
  max: number;
  text: number;
  prefix: string;
}

export interface SnapshotResult {
  title: string;
  url: string;
  heads: string[];
  lines: string[];
  body: string;
  more: boolean;
}

export function snapshotScript(opts: SnapshotOptions): SnapshotResult {
  const sel =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],' +
    '[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],' +
    '[contenteditable=""],[contenteditable=true],[onclick]';
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const nameOf = (el: HTMLElement) => {
    const input = el as HTMLInputElement;
    return clean(
      el.getAttribute('aria-label') ||
        (input.labels && input.labels[0] && input.labels[0].innerText) ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        (el.tagName === 'INPUT' || el.tagName === 'SELECT' ? '' : el.innerText) ||
        el.getAttribute('name') ||
        '',
    ).slice(0, 70);
  };
  const all: HTMLElement[] = [];
  const walk = (root: Document | ShadowRoot) => {
    root.querySelectorAll<HTMLElement>(sel).forEach((e) => all.push(e));
    root.querySelectorAll('*').forEach((e) => {
      if (e.shadowRoot) walk(e.shadowRoot);
    });
  };
  walk(document);
  const w = window as unknown as { __flN?: number };
  let n = w.__flN || 0;
  const lines: string[] = [];
  for (const el of all) {
    if (lines.length >= opts.max) break;
    if (!visible(el)) continue;
    if (!el.dataset.fl) el.dataset.fl = 'e' + ++n;
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? input.type || 'text' : tag);
    let line = `[${opts.prefix}${el.dataset.fl}] ${role} "${nameOf(el)}"`;
    if (tag === 'input' || tag === 'textarea') {
      if (input.type === 'checkbox' || input.type === 'radio') line += input.checked ? ' (checked)' : ' (unchecked)';
      else if (input.type !== 'password' && input.value) line += ` = "${clean(input.value).slice(0, 40)}"`;
    }
    const select = el as HTMLSelectElement;
    if (tag === 'select' && select.selectedOptions[0]) line += ` = "${clean(select.selectedOptions[0].text).slice(0, 40)}"`;
    if (input.disabled) line += ' (disabled)';
    lines.push(line);
  }
  w.__flN = n;
  const heads = [...document.querySelectorAll<HTMLElement>('h1,h2,h3')]
    .filter(visible)
    .slice(0, 8)
    .map((h) => '# ' + clean(h.innerText).slice(0, 80));
  const body = opts.text > 0 ? clean(document.body ? document.body.innerText : '').slice(0, opts.text) : '';
  return { title: document.title, url: location.href, heads, lines, body, more: all.length > opts.max };
}

export interface TargetDescriptor {
  tag: string;
  role: string | null;
  name: string;
  id: string | null;
  nameAttr: string | null;
  type: string | null;
  placeholder: string | null;
  testid: string | null;
  href: string | null;
  text: string;
  css: string;
  frameUrl?: string;
}

export function describeScript(el: Element): TargetDescriptor {
  const h = el as HTMLElement;
  const input = el as HTMLInputElement;
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const tag = el.tagName.toLowerCase();
  const implicit: Record<string, string | null> = {
    a: el.hasAttribute('href') ? 'link' : null,
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    summary: 'button',
  };
  let role: string | null = el.getAttribute('role') || implicit[tag] || null;
  if (!role && tag === 'input') {
    const map: Record<string, string | null> = {
      checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button',
      search: 'searchbox', range: 'slider', number: 'spinbutton', password: null,
    };
    const t = input.type || 'text';
    role = t in map ? (map[t] ?? null) : 'textbox';
  }
  const label = el.getAttribute('aria-label') || (input.labels && input.labels[0] && input.labels[0].innerText) || '';
  const own =
    tag === 'input'
      ? input.value && ['submit', 'button'].includes(input.type)
        ? input.value
        : el.getAttribute('placeholder')
      : h.innerText;
  const name = clean(label || own || el.getAttribute('title') || el.getAttribute('alt'));
  const cssPath = (start: Element) => {
    const parts: string[] = [];
    let node: Element | null = start;
    while (node && parts.length < 5) {
      if (node.id && !/\d{3,}|[a-f0-9]{8,}|:/.test(node.id)) {
        parts.unshift(`[id="${node.id}"]`);
        break;
      }
      let p = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const tagName = node.tagName;
        const same = [...parent.children].filter((c) => c.tagName === tagName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(p);
      node = parent;
    }
    return parts.join(' > ');
  };
  return {
    tag,
    role,
    name,
    id: el.id || null,
    nameAttr: el.getAttribute('name'),
    type: el.getAttribute('type'),
    placeholder: el.getAttribute('placeholder'),
    testid: el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa'),
    href: tag === 'a' ? el.getAttribute('href') : null,
    text: clean(h.innerText),
    css: cssPath(el),
  };
}

/**
 * Resolves as soon as the page is visually settled: immediately if nothing changes within `idle` ms,
 * otherwise once the DOM has been quiet for `quiet` ms, and never later than `max` ms.
 */
export function domQuietScript(args: { idle: number; quiet: number; max: number }): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, args.idle);
    const cap = setTimeout(done, args.max);
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, args.quiet);
    });
    obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    function done() {
      obs.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve();
    }
  });
}

/** Runs a request from inside the page: same origin, same cookies, same session as the site itself. */
export async function fetchScript(args: {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
  max: number;
}): Promise<{ status: number; contentType: string; body: string }> {
  const r = await fetch(args.url, {
    method: args.method,
    headers: args.headers,
    body: args.body,
    credentials: 'include',
  });
  const text = await r.text();
  return { status: r.status, contentType: r.headers.get('content-type') || '', body: text.slice(0, args.max) };
}
