// Functions in this file are serialized and executed inside the page.
// They must be fully self-contained: no imports, no outer variables.

export interface SnapshotOptions {
  max: number;
  text: number;
  prefix: string;
  /** Only the part of the page around this text, "dialog" for the open dialog, "page" for the whole page. */
  within?: string;
  /** No field value at all: a secret was filled in this page. */
  hideValues?: boolean;
}

export interface SnapshotResult {
  title: string;
  url: string;
  heads: string[];
  lines: string[];
  body: string;
  more: boolean;
  /** What the listing was limited to, said to the agent (an open dialog, the part around a text). */
  scope?: string;
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
  // The part of the page to list. An open modal dialog by itself (the page behind it cannot be used anyway),
  // unless the agent asks for the whole page; or the part around a text the agent names.
  const DIALOGS = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]';
  const isModal = (d: Element) => d.getAttribute('aria-modal') === 'true' || (() => { try { return d.matches(':modal'); } catch { return false; } })();
  const wanted = clean(opts.within).toLowerCase();
  let roots: Element[] | null = null;
  let scope = '';
  if (wanted !== 'page') {
    const open = [...document.querySelectorAll(DIALOGS)].filter(visible);
    const top = wanted === 'dialog' ? open.at(-1) : !wanted ? open.filter(isModal).at(-1) : undefined;
    if (top) {
      roots = [top];
      const title = clean(top.getAttribute('aria-label') || top.querySelector('h1,h2,h3,[role=heading]')?.textContent).slice(0, 60);
      scope = `Dialog open${title ? ` "${title}"` : ''}: only its elements are listed${wanted === 'dialog' ? '' : ' (within: "page" lists the whole page)'}.`;
    } else if (wanted === 'dialog') {
      scope = 'No dialog is open: the whole page is listed.';
    } else if (wanted) {
      // Each place the text shows, widened to the smallest block that also holds something to click or fill.
      const found: Element[] = [];
      const texts = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      for (let t = texts.nextNode(); t && found.length < 20; t = texts.nextNode()) {
        if (!(t.textContent || '').toLowerCase().includes(wanted)) continue;
        let block = t.parentElement;
        while (block && block !== document.body && !block.querySelector(sel)) block = block.parentElement;
        if (block && !found.some((f) => f.contains(block!))) found.push(block);
      }
      roots = found;
      scope = found.length ? `Only the part of the page around "${opts.within}" is listed (${found.length} place${found.length > 1 ? 's' : ''}).` : `"${opts.within}" is not on the page: nothing listed.`;
    }
  }
  const inScope = (el: Element) => !roots || roots.some((r) => r.contains(el));
  const w = window as unknown as { __flN?: number };
  let n = w.__flN || 0;
  const lines: string[] = [];
  for (const el of all) {
    if (lines.length >= opts.max) break;
    if (!inScope(el) || !visible(el)) continue;
    if (!el.dataset.fl) el.dataset.fl = 'e' + ++n;
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? input.type || 'text' : tag);
    let line = `[${opts.prefix}${el.dataset.fl}] ${role} "${nameOf(el)}"`;
    if (tag === 'input' || tag === 'textarea') {
      if (input.type === 'checkbox' || input.type === 'radio') line += input.checked ? ' (checked)' : ' (unchecked)';
      // A field Flintrail filled with a password or code never shows its value, even turned into plain text.
      else if (!opts.hideValues && input.type !== 'password' && input.value && !el.hasAttribute('data-fl-secret')) line += ` = "${clean(input.value).slice(0, 40)}"`;
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
  const shownText = roots ? roots.map((r) => (r as HTMLElement).innerText || '').join(' / ') : document.body ? document.body.innerText : '';
  const body = opts.text > 0 ? clean(shownText).slice(0, opts.text) : '';
  return { title: document.title, url: location.href, heads, lines, body, more: lines.length >= opts.max && all.length > opts.max, ...(scope ? { scope } : {}) };
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
  /** Do not follow a redirect: report it instead. */
  manualRedirect?: boolean;
}): Promise<{ status: number; contentType: string; body: string; redirectedTo?: string }> {
  const r = await fetch(args.url, {
    method: args.method,
    headers: args.headers,
    body: args.body,
    credentials: 'include',
    ...(args.manualRedirect ? { redirect: 'manual' as const } : {}),
  });
  if (r.type === 'opaqueredirect') return { status: 0, contentType: '', body: '', redirectedTo: '' };
  const text = await r.text();
  return {
    status: r.status,
    contentType: r.headers.get('content-type') || '',
    body: text.slice(0, args.max),
    ...(r.redirected ? { redirectedTo: r.url } : {}),
  };
}

/** Answers the next alert / confirm / prompt of the page itself, then restores the native functions. */
export function dialogOverrideScript(policy: { accept: boolean; value?: string }): void {
  const w = window as unknown as Record<'alert' | 'confirm' | 'prompt', (...args: unknown[]) => unknown>;
  const native = { alert: w.alert, confirm: w.confirm, prompt: w.prompt };
  const restore = () => Object.assign(w, native);
  w.alert = () => { restore(); };
  w.confirm = () => { restore(); return policy.accept; };
  w.prompt = (_message: unknown, initial: unknown) => {
    restore();
    return policy.accept ? (policy.value ?? (typeof initial === 'string' ? initial : '')) : null;
  };
}
