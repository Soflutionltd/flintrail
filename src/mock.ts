// fl_mock: what the network answers a tab, to test how a site behaves when its API fails, is slow, or says something
// else: block a request, make it fail, delay it, or answer it with a status and body the agent writes. Per tab, until
// cleared, released or closed. What the page sends is never shown to the agent (a form may carry a password), only
// how many requests each rule caught.
import type { Page, Route } from 'playwright-core';
import { config } from './config.js';
import { domainProblem } from './domains.js';
import { assertNoSecret, markAgentJs, secretInTab } from './engine.js';
import { redact } from './secrets.js';

export interface MockOptions {
  action: 'block' | 'fail' | 'delay' | 'respond' | 'list' | 'clear';
  url?: string;
  regex?: boolean;
  method?: string;
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  ms?: number;
  times?: number;
}

interface Rule {
  id: number;
  url: string;
  regex: boolean;
  match: (u: string) => boolean;
  method?: string;
  action: 'block' | 'fail' | 'delay' | 'respond';
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  ms?: number;
  times?: number;
  hits: number;
}

const rules = new WeakMap<Page, Rule[]>();
const routed = new WeakSet<Page>();
let nextRule = 1;
const BODY_MAX = 1024 * 1024;
const RULES_MAX = 50;

/** A part of the address, or with regex a regular expression. */
function matcher(url: string, regex: boolean): (u: string) => boolean {
  if (!regex) return (u) => u.includes(url);
  // Run on every request of the tab: kept short, so a pattern cannot hold the server up.
  if (url.length > 200) throw new Error('url: a regular expression of 200 characters at most.');
  let r: RegExp;
  try { r = new RegExp(url); } catch (e) { throw new Error(`url: not a valid regular expression (${(e as Error).message}).`); }
  return (u) => r.test(u);
}

const describe = (r: Rule) => {
  const what = r.action === 'respond' ? `answer ${r.status ?? 200}${r.contentType ? ` ${r.contentType}` : ''} (${Buffer.byteLength(r.body || '')} bytes)`
    : r.action === 'delay' ? `delay ${r.ms} ms` : r.action === 'fail' ? 'fail (network error)' : 'block';
  const left = r.times !== undefined ? `, ${Math.max(0, r.times - r.hits)} use(s) left` : '';
  return `#${r.id} ${r.method ? `${r.method} ` : ''}${r.regex ? `/${r.url}/` : r.url} -> ${what}, caught ${r.hits}${left}`;
};

async function handle(page: Page, route: Route) {
  const req = route.request();
  // Matched on the masked address: a password or code in it (a form sent by GET) can never be guessed rule by rule
  // from what the rules catch.
  const url = redact(req.url());
  const list = rules.get(page) || [];
  // While Rocketwright fills a secret in the tab, or the tab shows one, the page talks to the real network, untouched
  // and uncounted. A request to a site outside the user's list goes through too: the agent may not act on that site.
  if (!list.length || secretInTab(page) || (config.allowedDomains.length && domainProblem(req.url()))) return route.fallback().catch(() => {});
  const rule = list.find((r) => (!r.method || r.method === req.method()) && (r.times === undefined || r.hits < r.times) && r.match(url));
  if (!rule) return route.fallback().catch(() => {});
  rule.hits++;
  switch (rule.action) {
    case 'block': return route.abort('blockedbyclient').catch(() => {});
    case 'fail': return route.abort('failed').catch(() => {});
    case 'delay':
      await new Promise((r) => setTimeout(r, rule.ms));
      return route.fallback().catch(() => {});
    case 'respond':
      return route.fulfill({
        status: rule.status ?? 200,
        body: rule.body ?? '',
        contentType: rule.contentType || (/^\s*[[{]/.test(rule.body || '') ? 'application/json' : 'text/plain'),
        headers: rule.headers,
      }).catch(() => {});
  }
}

export async function mock(page: Page, o: MockOptions): Promise<string> {
  const list = rules.get(page) || [];
  if (o.action === 'list') return list.length ? list.map(describe).join('\n') : 'No network rule on this tab.';
  if (o.action === 'clear') {
    await clearMocks(page);
    return list.length ? `${list.length} network rule(s) removed: the tab talks to the real network again.` : 'No network rule on this tab.';
  }
  if (!o.url) throw new Error('url is needed: a part of the address ("/api/orders"), or a regular expression with regex:true.');
  if (o.url.length > 500) throw new Error('url: 500 characters at most.');
  if (list.length >= RULES_MAX) throw new Error(`${RULES_MAX} rules at most on a tab: clear them first.`);
  // The same rule as for scripts and screenshots: a page holding a filled secret is left alone.
  assertNoSecret(page, 'A network rule');
  const rule: Rule = { id: nextRule++, url: o.url, regex: !!o.regex, match: matcher(o.url, !!o.regex), action: o.action, hits: 0 };
  if (o.method) rule.method = o.method.toUpperCase();
  if (o.times !== undefined) rule.times = o.times;
  if (o.action === 'delay') {
    if (!o.ms || o.ms < 1 || o.ms > 60_000) throw new Error('delay needs ms, between 1 and 60000.');
    rule.ms = o.ms;
  }
  if (o.action === 'respond') {
    if (o.status !== undefined && (o.status < 100 || o.status > 599)) throw new Error('status: between 100 and 599.');
    if (o.body && Buffer.byteLength(o.body) > BODY_MAX) throw new Error('body: 1 MB at most.');
    if (o.headers) {
      // Cookies set by a fake answer would land in the user's browser for that site.
      // Cookies or site data a fake answer sets or clears would stay in the user's browser for that site.
      const bad = Object.keys(o.headers).find((h) => /^(set-cookie|clear-site-data)$/i.test(h.trim()));
      if (bad) throw new Error(`headers: ${bad} is refused, a header that changes the browser's cookies or site data.`);
    }
    Object.assign(rule, { status: o.status, body: o.body ?? '', contentType: o.contentType, headers: o.headers });
  }
  // The page runs what a fake answer holds (a script, a page), and a blocked or failed script changes what its
  // sign-in form does: from now on the tab counts as one the agent ran JavaScript in, where Rocketwright never fills a
  // password or pastes a secret.
  markAgentJs(page);
  list.push(rule);
  rules.set(page, list);
  if (!routed.has(page)) {
    routed.add(page);
    try {
      await page.route(() => true, (route) => handle(page, route));
    } catch (e) {
      // No interception: no rule either, rather than one listed that does nothing.
      routed.delete(page);
      rules.delete(page);
      throw e;
    }
  }
  const outside = config.allowedDomains.length ? ' Requests to sites outside the allowed list are never touched.' : '';
  const reload = rule.action === 'respond' || rule.action === 'block' ? ' Requests already made are not changed: reload the page (goto) if the site loads this only once.' : '';
  return `Rule ${describe(rule)}.${outside}${reload} fl_mock list shows what each rule caught; clear, fl_release or fl_close removes them.`;
}

/** Every rule of the tab removed: the tab talks to the real network again. */
export async function clearMocks(page: Page) {
  rules.delete(page);
  if (!routed.has(page)) return;
  routed.delete(page);
  if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
}
