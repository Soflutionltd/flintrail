// Signs in on the open sign-in form. Either the browser's own password manager has filled it (Flintrail only
// confirms with a real click), or Flintrail reads a password manager CLI and fills the form itself. Either way
// the agent only gets the list of fields filled: passwords and one-time codes are masked in every tool result.
import { lookup } from 'node:dns/promises';
import { getDomain } from 'tldts';
import { domainProblem } from './domains.js';
import type { Frame, Locator, Page } from 'playwright-core';
import { config } from './config.js';
import { randomBytes } from 'node:crypto';
import { agentRanJs, beforeSecret, elementByRef, loginRunning, markSecretFilled, pageBrowser, withNavigation } from './engine.js';
import { askFill, recordFill, vaultAllowed, vaultRules, type VaultRules } from './fill-policy.js';
import { hostOf, isLocalHost, parseSources, type Account, type CliSource, type SourceSpec } from './passwords.js';
import { remember } from './secrets.js';

export { redact } from './secrets.js';

interface Marked { user: boolean; pass: boolean; otp: 'one' | 'split' | null; autofilled: boolean }

const TIMEOUT = 8000;
const BROWSER_FILL_WAIT = 1500;
const CODE_MASK_MS = 3 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Registrable domain from the public suffix list, for matching a page to a saved login: accounts.google.com ->
 * google.com, but alice.github.io and bob.github.io stay two sites (a login for one is never filled on the other).
 */
export function siteOf(host: string): string {
  const h = host.replace(/\.$/, '').toLowerCase();
  // A saved local address with its port ("localhost:5191") is its own site: only that app fits.
  if (/:\d+$/.test(h)) return h;
  return getDomain(h, { allowPrivateDomains: true }) || h;
}

// Browsers send localhost, 127.x.x.x, [::1] and *.localhost to this computer whatever the DNS says.
const LOOPBACK = (host: string) => /^(localhost|127(\.\d+){3}|\[::1\])$/.test(host) || host.endsWith('.localhost');
/** *.test names last checked to point to this computer only (set by checkLocalNames before each sign-in). */
const loopbackTestNames = new Set<string>();

/** A secret is only ever sent over HTTPS (or to this computer). Plain HTTP would hand it to anyone on the network. */
export function fillProblem(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return `not a web page (${url.slice(0, 80)})`; }
  if (u.protocol === 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:' && (LOOPBACK(host) || loopbackTestNames.has(host))) return null;
  if (u.protocol === 'http:' && host.endsWith('.test')) return `${host} is served over plain HTTP and does not point to this computer only`;
  return u.protocol === 'http:' ? `${host} is served over plain HTTP` : `${u.protocol} pages are never filled`;
}

const isLoopbackAddress = (address: string) => /^127\./.test(address) || address === '::1' || address === '::ffff:127.0.0.1';

/**
 * A *.test name is a development address only when it points to this computer (hosts file, local DNS). Pointing
 * elsewhere, plain HTTP would send the secret over the network: it is then treated like any other website.
 */
export async function checkLocalNames(urls: string[], resolve: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((a) => a.address)): Promise<void> {
  const names = new Set(urls.map((url) => hostOf(url)).filter((host) => host.endsWith('.test')));
  await Promise.all([...names].map(async (host) => {
    const addresses = await resolve(host).catch(() => [] as string[]);
    if (addresses.length && addresses.every(isLoopbackAddress)) loopbackTestNames.add(host);
    else loopbackTestNames.delete(host);
  }));
}

/** What a page address is matched against: its site, and on a local development address also host:port. */
export function keysOf(url: string): Set<string> {
  let u: URL;
  try { u = new URL(url); } catch { return new Set(); }
  const host = u.hostname.toLowerCase();
  const keys = new Set([siteOf(host)]);
  if (isLocalHost(host)) keys.add(`${host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`);
  return keys;
}
const fits = (sites: Iterable<string>, url: string) => { const keys = keysOf(url); return [...sites].some((s) => keys.has(s)); };

/** The address to add to a saved login so that it fits this page, for the refusal messages. */
const addressToSave = (url: string) => { try { const u = new URL(url); return isLocalHost(u.hostname) ? u.origin : u.hostname; } catch { return url.slice(0, 80); } };

let sources: SourceSpec[] | null = null;
const getSources = () => (sources ??= parseSources(config.passwordSources));

// A sign-in form embedded from a site outside the user's list, or served over plain HTTP, is never filled.
const liveFrames = (page: Page) => page.frames().filter((f) => !f.isDetached() && /^https?:/.test(f.url()) && !domainProblem(f.url()) && !fillProblem(f.url()));
const label = (a: Account) => `"${a.title}" (${[a.username, a.where, `id ${a.ref}`].filter(Boolean).join(', ')})`;
const sitesOf = (a: Account) => [...new Set(a.hosts.map(siteOf))];

/**
 * Runs in the page: tags the visible username, password and one-time-code inputs with data-fl-login. The tag
 * holds a random token of this call, so a page cannot prepare an input that would receive the secret.
 */
function markLoginFields(token: string): Marked {
  for (const el of document.querySelectorAll('[data-fl-login]')) el.removeAttribute('data-fl-login');
  const shown = (el: HTMLInputElement) => {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const filledByBrowser = (el: HTMLInputElement) => {
    try {
      return el.matches(':autofill');
    } catch {
      return el.matches(':-webkit-autofill');
    }
  };
  const hint = (i: HTMLInputElement) =>
    [i.name, i.id, i.autocomplete, i.placeholder, i.getAttribute('aria-label'), i.labels?.[0]?.textContent].join(' ').toLowerCase();
  // Payment and bank fields are never touched, even when they look like a code box.
  const payment = (i: HTMLInputElement) => /^cc-/.test(i.autocomplete) || /card|cvc|cvv|iban|\bbic\b|swift|expir|carte|cryptogram/.test(hint(i));
  const inputs = [...document.querySelectorAll('input')].filter((i) => shown(i) && !payment(i));
  const textual = (i: HTMLInputElement) => ['text', 'email', 'tel', 'number', ''].includes(i.type);
  const pass = inputs.find((i) => i.type === 'password' && i.autocomplete !== 'new-password') ?? null;
  const singles = inputs.filter((i) => textual(i) && i.maxLength === 1);
  let otp: Marked['otp'] = null;
  if (singles.length >= 4) {
    singles[0]!.dataset.flLogin = `${token}:otp`;
    otp = 'split';
  } else {
    const box = inputs.find((i) => i.autocomplete === 'one-time-code' || (textual(i)
      && /otp|totp|2fa|mfa|one.?time|verification|security.?code|\bcode\b|c[oó]digo/.test(hint(i))
      && !/postal|zip|promo|coupon|voucher|gift|parrain|country|pays/.test(hint(i))));
    if (box) {
      box.dataset.flLogin = `${token}:otp`;
      otp = 'one';
    }
  }
  const users = inputs.filter((i) => ['text', 'email', 'tel', ''].includes(i.type) && !i.dataset.flLogin && !singles.includes(i));
  let user = users.find((i) => /username|email/.test(i.autocomplete) || i.type === 'email'
    || /user|e-?mail|login|identifier|identifiant|account|utilisateur|courriel/.test(hint(i))) ?? null;
  if (!user && pass) user = users.filter((i) => i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) ?? null;
  if (user) user.dataset.flLogin = `${token}:user`;
  if (pass) pass.dataset.flLogin = `${token}:pass`;
  const autofilled = [user, pass].some((el) => !!el && filledByBrowser(el) && el.value !== '');
  return { user: !!user, pass: !!pass, otp, autofilled };
}

const markAll = (frames: Frame[], token: string) => Promise.all(frames.map((f) => f.evaluate(markLoginFields, token).catch(() => null)));
const field = (frame: Frame, token: string, k: string) => frame.locator(`[data-fl-login="${token}:${k}"]`).first();

/**
 * Just before a secret goes into a field: the field's frame must still be on the login's website, over HTTPS.
 * The user's confirmation or the password manager's unlock can take a while, and the page may have moved meanwhile.
 */
async function assertStillOn(loc: Locator, sites: string[]) {
  if (agentRanJs(loc.page())) throw new Error('Refused: a script of yours ran in this tab while filling. Nothing more was filled.');
  const where = await loc.evaluate(() => location.href, undefined, { timeout: TIMEOUT });
  const why = fillProblem(where) || domainProblem(where);
  const site = siteOf(hostOf(where));
  if (why || !fits(sites, where)) throw new Error(`Refused: the page moved to ${site || where.slice(0, 80)} before the fill${why ? ` (${why})` : ''}. Nothing more was filled.`);
}

/** A filled password or code: never shown in snapshots, drawn as dots, and the page is closed to the agent's scripts. */
async function sealSecret(page: Page, loc: Locator, splitBoxes = false) {
  await loc.evaluate((el, split) => {
    const boxes = split ? [...(el.ownerDocument.querySelectorAll('input[maxlength="1"]') as NodeListOf<HTMLInputElement>)] : [el as HTMLInputElement];
    const block = (e: Event) => e.preventDefault();
    for (const box of boxes) {
      box.setAttribute('data-fl-secret', '');
      box.style.setProperty('-webkit-text-security', 'disc');
      // No copy out of it either: pasted elsewhere, the value would escape masking.
      box.style.setProperty('user-select', 'none');
      box.addEventListener('copy', block, true);
      box.addEventListener('cut', block, true);
    }
  }, splitBoxes).catch(() => {});
  markSecretFilled(page);
}

/** The browser's password manager already filled the form: confirm with a real click so the page can read it. */
async function useBrowserFill(page: Page, token: string, expected?: string, skipped?: string[]): Promise<{ text: string; last: Locator; codeWanted: boolean } | null> {
  const frames = liveFrames(page);
  let marks = await markAll(frames, token);
  if (!marks.some((m) => m?.user || m?.pass)) return null;
  for (let waited = 0; !marks.some((m) => m?.autofilled) && waited < BROWSER_FILL_WAIT; waited += 250) {
    await sleep(250);
    marks = await markAll(frames, token);
  }
  const i = marks.findIndex((m) => m?.autofilled);
  if (i < 0) return null;
  const m = marks[i]!;
  const frame = frames[i]!;
  const host = hostOf(frame.url());
  const fields = [m.user && 'username', m.pass && 'password'].filter(Boolean) as string[];
  // The click hands the value to the page: the user's settings apply to the browser's own saved passwords too.
  const request = { ...pageBrowser(page), domain: siteOf(host), host, item: 'password saved in the browser', ref: '', source: 'browser', fields };
  const decision = await askFill(request);
  const last = field(frame, token, m.pass ? 'pass' : 'user');
  await assertStillOn(last, [siteOf(host)]);
  await last.click({ timeout: TIMEOUT });
  if (m.pass) {
    const pass = field(frame, token, 'pass');
    remember(await pass.inputValue({ timeout: TIMEOUT }), Infinity);
    await sealSecret(page, pass);
  }
  // The click already handed the values to the page: logged whatever follows.
  recordFill(request, decision, fields);
  if (expected) {
    // The browser chose the login by itself. Its values are readable now that a real click confirmed them:
    // unless they are shown to be the account the user asked for, this source is left aside and nothing is submitted.
    const typed = m.user ? (await field(frame, token, 'user').inputValue({ timeout: TIMEOUT })).trim().toLowerCase() : '';
    const id = typed ? null : await identityOnPage(page, new Set([siteOf(hostOf(frame.url()))]));
    const onlyExpected = !!id && !id.partial && namedOnPage(expected, id) && accountsOn(id).length === 1;
    if (typed ? typed !== expected : !onlyExpected) {
      skipped?.push(typed ? `the browser's own saved login (${typed.slice(0, 80)})` : "the browser's own saved login (the page does not show whose it is)");
      return null;
    }
  }
  return { text: `Browser password manager: filled ${fields.join(', ')}`, last, codeWanted: !!m.otp };
}

/**
 * Accounts a sign-in step shows: whole addresses, partly hidden ones, anything else that looks like an account but
 * cannot be read for sure (`unclear`), and what its fields hold. `partial`: the page was too large to read whole.
 */
interface Identity { emails: Set<string>; masked: { head: string; tail: string; domain: string; shown: string }[]; unclear: Set<string>; values: Set<string>; asksUsername: boolean; partial: boolean }

const ADDRESS = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;
/** An address shown partly hidden, as sign-in pages do: "a••••@example.com", "jo***n@example.com". */
const HIDDEN = /^([\p{L}\p{N}._%+-]+)[•●·*]+([\p{L}\p{N}._%+-]*)@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)$/u;

/** Runs in the page: the visible text, labels and field values of a sign-in step, without footers and contact links. */
function readIdentity(): { text: string; values: string[]; partial: boolean } {
  const MAX_NODES = 40000;
  const MAX_CHARS = 300000;
  const skip = 'footer, a[href^="mailto:"], script, style, noscript, template, option, select, textarea, [aria-hidden="true"], [hidden]';
  const seenEl = new Map<Element, boolean>();
  // Only what the user can see: an account kept in a hidden part of the page (another signed-in account, a chooser
  // that is closed) is not the account this step is about.
  const visible = (el: Element): boolean => {
    let v = seenEl.get(el);
    if (v !== undefined) return v;
    const r = el.getBoundingClientRect();
    v = !el.closest(skip)
      && r.width > 0 && r.height > 0 && r.bottom > -2000 && r.right > -2000 && r.left < innerWidth + 4000
      && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    seenEl.set(el, v);
    return v;
  };
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let size = 0;
  let nodes = 0;
  let partial = false;
  let lastBlock: Element | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (++nodes > MAX_NODES || size > MAX_CHARS) { partial = true; break; }
    const el = n.parentElement;
    const t = n.nodeValue || '';
    if (!el || !t.trim() || !visible(el)) continue;
    // Text nodes of one line are joined as they read ("<b>ann</b>@example.com"), separate blocks get a space.
    const block = el.closest('p, div, li, td, th, h1, h2, h3, h4, h5, h6, label, button, section, form, header, main') || el;
    parts.push(block === lastBlock ? t : ` ${t}`);
    lastBlock = block;
    size += t.length;
  }
  const inputs = [...document.querySelectorAll('input')];
  const values = [
    ...inputs.filter((i) => ['email', 'text', ''].includes(i.type) && visible(i)),
    // The account chosen on an earlier step is often carried in a hidden field.
    ...inputs.filter((i) => i.type === 'hidden' && /identifier|e-?mail|user|login|account/i.test(`${i.name} ${i.id}`)),
  ].filter((i) => i.value && i.value.length < 200).map((i) => i.value.trim());
  // Some sites name the account in a label rather than in the text (avatar button, account chip).
  const labels = [...document.querySelectorAll('[aria-label],[title],[data-email],[data-identifier]')].slice(0, 2000)
    .filter(visible)
    .map((e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('data-email'), e.getAttribute('data-identifier')].join(' ').slice(0, 400));
  return { text: `${parts.join('')} ${labels.join(' ')}`, values, partial };
}

/** Reads what the visible sign-in step says about the account, in the frames of the given websites only. */
async function identityOnPage(page: Page, sites: Set<string>): Promise<Identity> {
  // An embedded frame of another website (advert, chat widget) says nothing about the account of this sign-in.
  const frames = liveFrames(page).filter((f) => fits(sites, f.url()));
  // Its own token: only tells whether a username field is shown (the fill marks its fields again afterwards).
  const marks = await markAll(frames, randomBytes(8).toString('hex'));
  const read = await Promise.all(frames.map((f) => f.evaluate(readIdentity).catch(() => ({ text: '', values: [] as string[], partial: true }))));
  const id: Identity = { emails: new Set(), masked: [], unclear: new Set(), values: new Set(), asksUsername: marks.some((m) => !!m?.user), partial: read.some((r) => r.partial) };
  for (const r of read) {
    for (const v of r.values) id.values.add(v.toLowerCase());
    // Word by word, each word read whole: linear on a long page, and "x#ann@example.com" is not "ann@example.com".
    for (const raw of `${r.text} ${r.values.join(' ')}`.toLowerCase().split(/\s+/)) {
      if (!raw.includes('@')) continue;
      const word = raw.replace(/^[(<\["'«:,;=]+/, '').replace(/[)>\]"'».,;:!?]+$/, '');
      if (word.length > 200) { id.unclear.add(`${word.slice(0, 40)}...`); continue; }
      const hidden = HIDDEN.exec(word);
      if (ADDRESS.test(word)) id.emails.add(word);
      else if (hidden) id.masked.push({ head: hidden[1]!, tail: hidden[2]!, domain: hidden[3]!, shown: word });
      else if (word.length > 2) id.unclear.add(word);
    }
  }
  return id;
}

/** True when the step names this account: the whole address, a partly hidden one that fits it, or a field holding the username. */
function namedOnPage(username: string, id: Identity): boolean {
  const u = username.trim().toLowerCase();
  if (!u) return false;
  // A plain username ("admin", "support") is a common word: only a field holding exactly it counts, never the page text.
  if (id.values.has(u)) return true;
  const at = u.lastIndexOf('@');
  if (at < 1) return false;
  if (id.emails.has(u)) return true;
  const local = u.slice(0, at);
  const domain = u.slice(at + 1);
  return id.masked.some((m) => m.domain === domain && local.length > m.head.length + m.tail.length && local.startsWith(m.head) && local.endsWith(m.tail));
}

/** Every account the step shows, for the checks and the messages. */
const accountsOn = (id: Identity) => [...new Set([...id.emails, ...id.masked.map((m) => m.shown), ...id.unclear])];
const cut = (list: string[]) => list.slice(0, 3).map((e) => (e.length > 80 ? `${e.slice(0, 77)}...` : e)).join(', ');

/** The account to use from one CLI source: the one asked for, or the only one whose website matches the page. */
/** What a search went through, for the message when nothing is found: vaults searched, logins the user's rules left out. */
interface Searched { vaults: Set<string>; excluded: Set<string> }

async function findAccount(page: Page, source: CliSource, wanted?: string, expected?: string, others: string[] = [], rules: VaultRules = { allow: [], deny: [] }, searched?: Searched): Promise<Account | null> {
  const pageHosts = new Set(liveFrames(page).map((f) => hostOf(f.url())));
  const pageSites = new Set(liveFrames(page).flatMap((f) => [...keysOf(f.url())]));
  const w = wanted?.toLowerCase();
  const matchOf = (all: Account[]) => {
    // Only the vaults the user lets Flintrail use are named: an excluded vault says nothing of what it holds.
    for (const a of all) if (a.vault && vaultAllowed(a.vault, rules)) searched?.vaults.add(a.vault);
    const hits = w
      ? all.filter((a) => a.ref === wanted || a.title.toLowerCase() === w || a.username.toLowerCase() === w)
      : all.filter((a) => sitesOf(a).some((s) => pageSites.has(s)));
    // A vault the user left out is never used, even for the only matching login.
    for (const a of hits) if (!vaultAllowed(a.vault, rules)) searched?.excluded.add(`${a.source}:${a.ref}`);
    return hits.filter((a) => vaultAllowed(a.vault, rules));
  };
  let found = matchOf(await source.accounts(page.url(), false));
  if (!found.length) found = matchOf(await source.accounts(page.url(), true));
  if (!found.length) return null;
  if (expected) {
    // The user said whose account this is: a saved login for anyone else is never used, even if it is the only one.
    const same = found.filter((a) => a.username.trim().toLowerCase() === expected);
    if (!same.length) {
      others.push(...found.filter((a) => sitesOf(a).some((s) => pageSites.has(s))).map(label));
      return null;
    }
    found = same;
  }
  if (w) {
    const here = found.filter((a) => sitesOf(a).some((s) => pageSites.has(s)));
    if (!here.length) {
      const where = sitesOf(found[0]!).join(', ') || 'no website';
      throw new Error(`Refused: login ${label(found[0]!)} is for ${where}, this tab is on ${addressToSave(page.url())}. If it is really the same account, the user adds ${addressToSave(page.url())} to that saved login.`);
    }
    found = here;
  } else {
    // A step that already names the account (password page after the e-mail page, account chooser) decides
    // which saved login to use: a password for another account is a failed attempt on the user's account.
    const id = await identityOnPage(page, new Set(found.flatMap(sitesOf).filter((x) => pageSites.has(x))));
    if (!id.asksUsername) {
      // The account is already chosen (password page after the e-mail page): only the saved login of the account
      // the step shows may be used. In any doubt nothing is filled and the agent has to name the login.
      const shown = accountsOn(id);
      const named = found.filter((a) => namedOnPage(a.username, id));
      const choose = `pass item with one of these ids: ${found.map(label).join('; ')}`;
      if (id.partial) throw new Error(`Refused: this page is too large to tell which account it asks the password of. Nothing was filled; ${choose}`);
      if (shown.length > 1) throw new Error(`Refused: the page shows several accounts (${cut(shown)}), it is not clear which one it asks the password of. Nothing was filled; ${choose}`);
      if (named.length > 1) throw new Error(`Several saved logins match the account the page shows (${cut(shown)}): ${choose}`);
      if (named.length === 1) found = named;
      else if (shown.length) throw new Error(`Refused: the page asks for the password of ${cut(shown)}, ${found.length > 1 ? 'none of the saved logins is for that account' : `the saved login ${label(found[0]!)} is another account`}. Nothing was filled. Pass item to use one anyway: ${found.map(label).join('; ')}`);
      else if (found.length > 1) throw new Error(`Several saved logins match and the page does not say which account it is: ${choose}`);
    }
    const exact = found.filter((a) => a.hosts.some((h) => pageHosts.has(h)));
    if (exact.length === 1) found = exact;
  }
  if (found.length > 1) throw new Error(`Several saved logins match, pass item with one of these ids: ${found.map(label).join('; ')}`);
  return found[0]!;
}

/** Runs in the page: what kind of secret this input takes, or null when it is not a password or code field. */
function secretKind(el: Element): 'pass' | 'otp' | null {
  if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return null;
  const hint = [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label'), el.labels?.[0]?.textContent].join(' ').toLowerCase();
  if (/^cc-/.test(el.autocomplete) || /card|cvc|cvv|iban|\bbic\b|swift|expir|carte|cryptogram/.test(hint)) return null;
  if (el.type === 'password') return 'pass';
  if (['text', 'tel', 'number', ''].includes(el.type)
    && (el.autocomplete === 'one-time-code' || /otp|totp|2fa|mfa|one.?time|verification|security.?code|\bcode\b|c[oó]digo/.test(hint))) return 'otp';
  return null;
}

/** Asks the user's settings, then fills from a CLI source, only in frames whose domain matches the account's website. */
async function useAccount(page: Page, account: Account, token: string, ref?: string, expected?: string) {
  const sites = sitesOf(account);
  // The tab itself must be on the login's website: a login form framed by another site is not filled.
  const tabSite = siteOf(hostOf(page.url()));
  if (!fits(sites, page.url())) throw new Error(`Refused: this tab is on ${addressToSave(page.url())}, login ${label(account)} is for ${sites.join(', ') || 'no website'}.`);
  const frames = liveFrames(page).filter((f) => fits(sites, f.url()));
  let targets: { frame: Frame | null; m: Marked; field?: Locator; kind?: 'pass' | 'otp' }[];
  if (ref) {
    // The agent named the field: it must be a password or code input, on the account's website.
    const loc = elementByRef(page, ref);
    await assertStillOn(loc, sites);
    const kind = await loc.evaluate(secretKind, undefined, { timeout: TIMEOUT });
    if (!kind) throw new Error(`Refused: field ${ref} is not a password or one-time code field. Flintrail only fills secrets there, never in a free text field.`);
    targets = [{ frame: null, m: { user: false, pass: kind === 'pass', otp: kind === 'otp' ? 'one' : null, autofilled: false }, field: loc, kind }];
  } else {
    const marks = await markAll(frames, token);
    if (!marks.some((m) => m && (m.user || m.pass || m.otp))) {
      throw new Error(`No sign-in field visible on ${page.url()}. Open the sign-in form first (often a "Sign in" button).`);
    }
    targets = frames.map((frame, i) => ({ frame, m: marks[i]! })).filter((t) => t.m);
  }
  const wanted = [...new Set(targets.flatMap(({ m }) => [m.user && 'username', m.pass && 'password', m.otp && 'one-time code'].filter(Boolean) as string[]))];
  const request = { ...pageBrowser(page), domain: tabSite, host: hostOf(page.url()), item: account.title, ref: account.ref, source: account.source, fields: wanted, ...(account.vault ? { vault: account.vault } : {}) };
  // Nothing is revealed before the user's settings (and the user, when they asked to confirm each fill) said yes.
  const decision = await askFill(request);
  const creds = await account.reveal();
  // The list of logins and the login itself may disagree on the username: the one about to be typed decides.
  if (expected && (creds.username || '').trim().toLowerCase() !== expected) {
    throw new Error(`Refused: login ${label(account)} holds another username than ${expected}. Nothing was filled.`);
  }
  remember(creds.password, Infinity);
  remember(creds.totp, CODE_MASK_MS);
  const totp = decision.totp ? creds.totp : '';
  const filled: string[] = [];
  let last: Locator | null = null;
  let codeWanted = false;
  try {
    for (const { frame, m, field: named, kind } of targets) {
      const at = (k: string) => named ?? field(frame!, token, k);
      if (m.user && creds.username) {
        last = at('user');
        await assertStillOn(last, sites);
        await last.fill(creds.username, { timeout: TIMEOUT });
        filled.push('username');
      }
      if (m.pass) {
        if (!creds.password) throw new Error(`Login ${label(account)} has no password.`);
        last = at('pass');
        await assertStillOn(last, sites);
        await last.fill(creds.password, { timeout: TIMEOUT });
        filled.push('password');
        await sealSecret(page, last);
      }
      if (m.otp && !totp) codeWanted = true;
      if (m.otp && totp) {
        last = at('otp');
        await assertStillOn(last, sites);
        const split = m.otp === 'split' && !kind;
        if (split) {
          await last.click({ timeout: TIMEOUT });
          await page.keyboard.type(totp, { delay: 40 });
        } else await last.fill(totp, { timeout: TIMEOUT });
        filled.push('one-time code');
        await sealSecret(page, last, split);
      }
    }
  } finally {
    // Logged even when the fill stopped halfway: what did reach the page is what matters.
    if (filled.length) recordFill(request, decision, filled);
  }
  if (!last) {
    throw new Error(codeWanted
      ? `The page asks for a code that ${account.source} does not hold for ${label(account)}${decision.totp ? '' : ' (one-time codes are turned off in the Flintrail extension settings)'}: ask the user for it.`
      : `Nothing to fill: login ${label(account)} has no username for this field.`);
  }
  const how = decision.approval === 'confirmed by the user' ? ', confirmed by the user' : '';
  return { text: `${account.source} login ${label(account)}: filled ${filled.join(', ')}${how}`, last, codeWanted };
}

/**
 * Signs in on the visible step of a sign-in form. Sources are tried in the configured order; item (an ID, title or
 * username) or source restrict the choice. Returns what to record in a flow: the source and the account ref, never a secret.
 */
export async function signIn(page: Page, opts: { item?: string; source?: string; submit?: boolean; account?: string; field?: string }): Promise<{ text: string; source: string; item?: string }> {
  const expected = opts.account?.trim().toLowerCase() || undefined;
  if (opts.account !== undefined && !expected) throw new Error('account is empty: give the username or e-mail of the account the user asked for, or leave it out.');
  const all = getSources().filter((s) => !opts.source || s.kind === opts.source).filter((s) => !opts.field || s.kind !== 'browser');
  if (!all.length) {
    throw new Error(opts.source ? `Password source "${opts.source}" is not configured in FLINTRAIL_PASSWORDS${opts.field ? ', or cannot fill a named field (browser)' : ''}.`
      : opts.field ? 'Filling a named field needs a password manager CLI in FLINTRAIL_PASSWORDS (1password, bitwarden, command).' : 'fl_login is off (FLINTRAIL_PASSWORDS=off).');
  }
  await checkLocalNames(page.frames().map((f) => f.url()));
  const unsafe = fillProblem(page.url());
  if (unsafe) throw new Error(`Refused: ${unsafe}. Flintrail fills passwords and codes over HTTPS only, or on this computer (localhost, *.localhost, a *.test name pointing here).`);
  if (agentRanJs(page)) {
    throw new Error('Refused: you ran JavaScript in this tab (eval, extract or request), which could catch what gets filled. Open the sign-in page in a new tab (fl_open) and call fl_login there before running any script.');
  }
  loginRunning(page, true);
  try {
    // A trace or video of this tab is dropped before anything is typed: it would hold the password.
    await beforeSecret(page);
    return await fillAndSubmit(page, opts, all, expected);
  } finally {
    loginRunning(page, false);
  }
}

/** Where a 1Password search looked, and why a login may be out of its reach. */
function vaultNote(all: SourceSpec[], searched: Searched, rules: VaultRules): string {
  if (!all.some((s) => s.kind === '1password')) return '';
  const none = rules.allow.length || rules.deny.length ? 'none the settings allow' : 'none (is 1Password unlocked?)';
  const parts = [`1Password vaults searched: ${[...searched.vaults].sort().join(', ') || none}`];
  if (rules.allow.length || rules.deny.length) parts.push(`the user's vault settings: ${rules.allow.length ? `only ${rules.allow.join(', ')}` : 'every vault'}${rules.deny.length ? `, never ${rules.deny.join(', ')}` : ''}`);
  if (searched.excluded.size) parts.push(`${searched.excluded.size} matching login(s) left out by those settings`);
  // A service account only opens the shared vaults it was given when created: never Private, never a later vault.
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) parts.push('a 1Password service account only opens the shared vaults it was given (never Private, not a vault created after it); the 1Password app integration opens every vault');
  return `; ${parts.join('; ')}`;
}

async function fillAndSubmit(page: Page, opts: { item?: string; submit?: boolean; field?: string }, all: SourceSpec[], expected?: string): Promise<{ text: string; source: string; item?: string }> {
  const others: string[] = [];
  // A fresh token for this call's field tags: a page cannot prepare an input to receive the secret.
  const token = randomBytes(8).toString('hex');
  let done: { text: string; last: Locator; codeWanted: boolean } | null = null;
  let source = '';
  let item: string | undefined;
  const rules = all.some((s) => s.kind === '1password') ? await vaultRules(pageBrowser(page)) : { allow: [], deny: [] };
  const searched: Searched = { vaults: new Set(), excluded: new Set() };
  for (const s of all) {
    if (s.kind === 'browser') {
      if (opts.item) continue;
      done = await useBrowserFill(page, token, expected, others);
      source = 'browser';
    } else {
      const account = await findAccount(page, s, opts.item, expected, others, rules, searched);
      if (!account) continue;
      done = await useAccount(page, account, token, opts.field, expected);
      source = account.source;
      item = account.ref;
    }
    if (done) break;
  }
  if (!done) {
    const tried = all.map((s) => s.kind).join(', ') + vaultNote(all, searched, rules);
    const sites = [...new Set(liveFrames(page).map((f) => siteOf(hostOf(f.url()))))].join(', ');
    // On a development address no saved login fits by itself: say exactly what the user adds, whatever the manager.
    const local = isLocalHost(hostOf(page.url()))
      ? ` This is a local development address: a saved login only fits it once ${addressToSave(page.url())} is in it. Ask the user to add that address to the login in their password manager, or, with no password manager, to sign in by hand once and let the browser save the password.`
      : '';
    if (expected) {
      throw new Error(`Refused: no saved login for ${expected.slice(0, 80)} on ${sites} (tried ${tried}).${others.length ? ` Found for this site, for other accounts: ${[...new Set(others)].slice(0, 5).join('; ')}.` : ''} Nothing was filled: ask the user, do not sign in with another account.${local}`);
    }
    throw new Error(opts.item
      ? `No saved login "${opts.item}" in ${tried}.`
      : `No saved login for ${sites} (tried ${tried}), or no sign-in field visible yet.${local} Open the sign-in form first; for the browser source, sign in by hand once and let the browser save the password; or add a password manager to FLINTRAIL_PASSWORDS (1password, bitwarden, command).`);
  }
  // A form marked to send by GET would put the password in the address, where the history, the server logs and the
  // site's own scripts keep it: it is filled, not sent. (A form with no method is usually sent by the site's script.)
  const byGet = await done.last.evaluate((el) => {
    const form = (el as HTMLInputElement).form;
    return !!form && (form.getAttribute('method') || '').trim().toLowerCase() === 'get';
  }, undefined, { timeout: TIMEOUT }).catch(() => false);
  if (byGet) {
    return { text: `${done.text}, NOT submitted: this form sends what it holds in the page address (GET), the password included. Ask the user before sending it.`, source, item };
  }
  const submit = opts.submit !== false;
  if (submit) await withNavigation(page, () => done!.last.press('Enter', { timeout: TIMEOUT }));
  const extra = done.codeWanted && source === 'browser' ? ' The page also asks for a one-time code: ask the user for it.'
    : done.codeWanted ? ' The page also asks for a code the password manager does not hold: ask the user for it.' : '';
  return { text: `${done.text}${submit ? ', submitted' : ''}.${extra}`, source, item };
}
