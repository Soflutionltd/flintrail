// Signs in on the open sign-in form. Either the browser's own password manager has filled it (Flintrail only
// confirms with a real click), or Flintrail reads a password manager CLI and fills the form itself. Either way
// the agent only gets the list of fields filled: passwords and one-time codes are masked in every tool result.
import { domainProblem } from './domains.js';
import type { Frame, Locator, Page } from 'playwright-core';
import { config } from './config.js';
import { withNavigation } from './engine.js';
import { hostOf, parseSources, type Account, type CliSource, type SourceSpec } from './passwords.js';

interface Marked { user: boolean; pass: boolean; otp: 'one' | 'split' | null; autofilled: boolean }

const TIMEOUT = 8000;
const BROWSER_FILL_WAIT = 1500;
const CODE_MASK_MS = 3 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Secret -> time after which it is no longer masked. One-time codes expire fast and look like ordinary numbers. */
const secrets = new Map<string, number>();
const remember = (s: string, ttl: number) => {
  if (s.length >= 4) secrets.set(s, Date.now() + ttl);
};

/** Masks every password and one-time code fl_login filled, raw or encoded as a form, URL or JSON value would carry it. */
export function redact(text: string): string {
  let out = text;
  for (const [s, until] of secrets) {
    if (until < Date.now()) {
      secrets.delete(s);
      continue;
    }
    const forms = [s, encodeURIComponent(s), new URLSearchParams({ v: s }).toString().slice(2), JSON.stringify(s).slice(1, -1)];
    for (const f of new Set(forms)) out = out.split(f).join('•••');
  }
  return out;
}

/** Registrable domain, close enough for matching a page to a saved login: accounts.google.com -> google.com. */
export function siteOf(host: string): string {
  const h = host.replace(/\.$/, '');
  if (!h.includes('.') || h.includes(':') || /^[\d.]+$/.test(h)) return h;
  const p = h.split('.');
  const twoPart = p.length > 2 && p.at(-1)!.length === 2 && /^(co|com|org|net|gov|gouv|ac|edu)$/.test(p.at(-2)!);
  return p.slice(twoPart ? -3 : -2).join('.');
}

let sources: SourceSpec[] | null = null;
const getSources = () => (sources ??= parseSources(config.passwordSources));

// A sign-in form embedded from a site outside the user's list is never filled.
const liveFrames = (page: Page) => page.frames().filter((f) => !f.isDetached() && /^https?:/.test(f.url()) && !domainProblem(f.url()));
const label = (a: Account) => `"${a.title}" (${[a.username, a.where, `id ${a.ref}`].filter(Boolean).join(', ')})`;
const sitesOf = (a: Account) => [...new Set(a.hosts.map(siteOf))];

/** Runs in the page: tags the visible username, password and one-time-code inputs with data-fl-login. */
function markLoginFields(): Marked {
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
  const inputs = [...document.querySelectorAll('input')].filter(shown);
  const hint = (i: HTMLInputElement) =>
    [i.name, i.id, i.autocomplete, i.placeholder, i.getAttribute('aria-label'), i.labels?.[0]?.textContent].join(' ').toLowerCase();
  const textual = (i: HTMLInputElement) => ['text', 'email', 'tel', 'number', ''].includes(i.type);
  const pass = inputs.find((i) => i.type === 'password' && i.autocomplete !== 'new-password') ?? null;
  const singles = inputs.filter((i) => textual(i) && i.maxLength === 1);
  let otp: Marked['otp'] = null;
  if (singles.length >= 4) {
    singles[0]!.dataset.flLogin = 'otp';
    otp = 'split';
  } else {
    const box = inputs.find((i) => i.autocomplete === 'one-time-code' || (textual(i)
      && /otp|totp|2fa|mfa|one.?time|verification|security.?code|\bcode\b|c[oó]digo/.test(hint(i))
      && !/postal|zip|promo|coupon|voucher|gift|parrain|country|pays/.test(hint(i))));
    if (box) {
      box.dataset.flLogin = 'otp';
      otp = 'one';
    }
  }
  const users = inputs.filter((i) => ['text', 'email', 'tel', ''].includes(i.type) && !i.dataset.flLogin && !singles.includes(i));
  let user = users.find((i) => /username|email/.test(i.autocomplete) || i.type === 'email'
    || /user|e-?mail|login|identifier|identifiant|account|utilisateur|courriel/.test(hint(i))) ?? null;
  if (!user && pass) user = users.filter((i) => i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) ?? null;
  if (user) user.dataset.flLogin = 'user';
  if (pass) pass.dataset.flLogin = 'pass';
  const autofilled = [user, pass].some((el) => !!el && filledByBrowser(el) && el.value !== '');
  return { user: !!user, pass: !!pass, otp, autofilled };
}

const markAll = (frames: Frame[]) => Promise.all(frames.map((f) => f.evaluate(markLoginFields).catch(() => null)));
const field = (frame: Frame, k: string) => frame.locator(`[data-fl-login="${k}"]`).first();

/** The browser's password manager already filled the form: confirm with a real click so the page can read it. */
async function useBrowserFill(page: Page, expected?: string, skipped?: string[]): Promise<{ text: string; last: Locator; codeWanted: boolean } | null> {
  const frames = liveFrames(page);
  let marks = await markAll(frames);
  if (!marks.some((m) => m?.user || m?.pass)) return null;
  for (let waited = 0; !marks.some((m) => m?.autofilled) && waited < BROWSER_FILL_WAIT; waited += 250) {
    await sleep(250);
    marks = await markAll(frames);
  }
  const i = marks.findIndex((m) => m?.autofilled);
  if (i < 0) return null;
  const m = marks[i]!;
  const frame = frames[i]!;
  const last = field(frame, m.pass ? 'pass' : 'user');
  await last.click({ timeout: TIMEOUT });
  if (m.pass) remember(await field(frame, 'pass').inputValue({ timeout: TIMEOUT }), Infinity);
  if (expected) {
    // The browser chose the login by itself. Its values are readable now that a real click confirmed them:
    // unless they are shown to be the account the user asked for, this source is left aside and nothing is submitted.
    const typed = m.user ? (await field(frame, 'user').inputValue({ timeout: TIMEOUT })).trim().toLowerCase() : '';
    const id = typed ? null : await identityOnPage(page, new Set([siteOf(hostOf(frame.url()))]));
    const onlyExpected = !!id && !id.partial && namedOnPage(expected, id) && accountsOn(id).length === 1;
    if (typed ? typed !== expected : !onlyExpected) {
      skipped?.push(typed ? `the browser's own saved login (${typed.slice(0, 80)})` : "the browser's own saved login (the page does not show whose it is)");
      return null;
    }
  }
  const filled = [m.user && 'username', m.pass && 'password'].filter(Boolean).join(', ');
  return { text: `Browser password manager: filled ${filled}`, last, codeWanted: !!m.otp };
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
  const frames = liveFrames(page).filter((f) => sites.has(siteOf(hostOf(f.url()))));
  const marks = await markAll(frames);
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
async function findAccount(page: Page, source: CliSource, wanted?: string, expected?: string, others: string[] = []): Promise<Account | null> {
  const pageHosts = new Set(liveFrames(page).map((f) => hostOf(f.url())));
  const pageSites = new Set([...pageHosts].map(siteOf));
  const w = wanted?.toLowerCase();
  const matchOf = (all: Account[]) => w
    ? all.filter((a) => a.ref === wanted || a.title.toLowerCase() === w || a.username.toLowerCase() === w)
    : all.filter((a) => sitesOf(a).some((s) => pageSites.has(s)));
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
      throw new Error(`Refused: login ${label(found[0]!)} is for ${where}, this tab is on ${[...pageSites].join(', ')}. Add this website to the saved login if it is really the same account.`);
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

/** Fills the form from a CLI source, only in frames whose domain matches the account's website. */
async function useAccount(page: Page, account: Account, expected?: string) {
  const sites = sitesOf(account);
  const frames = liveFrames(page).filter((f) => sites.includes(siteOf(hostOf(f.url()))));
  const marks = await markAll(frames);
  if (!marks.some((m) => m && (m.user || m.pass || m.otp))) {
    throw new Error(`No sign-in field visible on ${page.url()}. Open the sign-in form first (often a "Sign in" button).`);
  }
  const creds = await account.reveal();
  // The list of logins and the login itself may disagree on the username: the one about to be typed decides.
  if (expected && (creds.username || '').trim().toLowerCase() !== expected) {
    throw new Error(`Refused: login ${label(account)} holds another username than ${expected}. Nothing was filled.`);
  }
  remember(creds.password, Infinity);
  remember(creds.totp, CODE_MASK_MS);
  const filled: string[] = [];
  let last: Locator | null = null;
  let codeWanted = false;
  for (let i = 0; i < frames.length; i++) {
    const m = marks[i];
    if (!m) continue;
    const frame = frames[i]!;
    if (m.user && creds.username) {
      last = field(frame, 'user');
      await last.fill(creds.username, { timeout: TIMEOUT });
      filled.push('username');
    }
    if (m.pass) {
      if (!creds.password) throw new Error(`Login ${label(account)} has no password.`);
      last = field(frame, 'pass');
      await last.fill(creds.password, { timeout: TIMEOUT });
      filled.push('password');
    }
    if (m.otp && !creds.totp) codeWanted = true;
    if (m.otp && creds.totp) {
      last = field(frame, 'otp');
      if (m.otp === 'split') {
        await last.click({ timeout: TIMEOUT });
        await page.keyboard.type(creds.totp, { delay: 40 });
      } else await last.fill(creds.totp, { timeout: TIMEOUT });
      filled.push('one-time code');
    }
  }
  if (!last) {
    throw new Error(codeWanted
      ? `The page asks for a code that ${account.source} does not hold for ${label(account)} (SMS, e-mail or phone prompt): ask the user for it.`
      : `Nothing to fill: login ${label(account)} has no username for this field.`);
  }
  return { text: `${account.source} login ${label(account)}: filled ${filled.join(', ')}`, last, codeWanted };
}

/**
 * Signs in on the visible step of a sign-in form. Sources are tried in the configured order; item (an ID, title or
 * username) or source restrict the choice. Returns what to record in a flow: the source and the account ref, never a secret.
 */
export async function signIn(page: Page, opts: { item?: string; source?: string; submit?: boolean; account?: string }): Promise<{ text: string; source: string; item?: string }> {
  const expected = opts.account?.trim().toLowerCase() || undefined;
  if (opts.account !== undefined && !expected) throw new Error('account is empty: give the username or e-mail of the account the user asked for, or leave it out.');
  const others: string[] = [];
  const all = getSources().filter((s) => !opts.source || s.kind === opts.source);
  if (!all.length) throw new Error(opts.source ? `Password source "${opts.source}" is not configured in FLINTRAIL_PASSWORDS.` : 'fl_login is off (FLINTRAIL_PASSWORDS=off).');
  let done: { text: string; last: Locator; codeWanted: boolean } | null = null;
  let source = '';
  let item: string | undefined;
  for (const s of all) {
    if (s.kind === 'browser') {
      if (opts.item) continue;
      done = await useBrowserFill(page, expected, others);
      source = 'browser';
    } else {
      const account = await findAccount(page, s, opts.item, expected, others);
      if (!account) continue;
      done = await useAccount(page, account, expected);
      source = account.source;
      item = account.ref;
    }
    if (done) break;
  }
  if (!done) {
    const tried = all.map((s) => s.kind).join(', ');
    const sites = [...new Set(liveFrames(page).map((f) => siteOf(hostOf(f.url()))))].join(', ');
    if (expected) {
      throw new Error(`Refused: no saved login for ${expected.slice(0, 80)} on ${sites} (tried ${tried}).${others.length ? ` Found for this site, for other accounts: ${[...new Set(others)].slice(0, 5).join('; ')}.` : ''} Nothing was filled: ask the user, do not sign in with another account.`);
    }
    throw new Error(opts.item
      ? `No saved login "${opts.item}" in ${tried}.`
      : `No saved login for ${sites} (tried ${tried}), or no sign-in field visible yet. Open the sign-in form first; for the browser source, sign in by hand once and let the browser save the password; or add a password manager to FLINTRAIL_PASSWORDS (1password, bitwarden, command).`);
  }
  const submit = opts.submit !== false;
  if (submit) await withNavigation(page, () => done!.last.press('Enter', { timeout: TIMEOUT }));
  const extra = done.codeWanted && source === 'browser' ? ' The page also asks for a one-time code: ask the user for it.'
    : done.codeWanted ? ' The page also asks for a code the password manager does not hold: ask the user for it.' : '';
  return { text: `${done.text}${submit ? ', submitted' : ''}.${extra}`, source, item };
}
