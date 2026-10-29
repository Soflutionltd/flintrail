// Signs in on the open sign-in form. Either the browser's own password manager has filled it (Flintrail only
// confirms with a real click), or Flintrail reads a password manager CLI and fills the form itself. Either way
// the agent only gets the list of fields filled: passwords and one-time codes are masked in every tool result.
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

const liveFrames = (page: Page) => page.frames().filter((f) => !f.isDetached() && /^https?:/.test(f.url()));
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
async function useBrowserFill(page: Page): Promise<{ text: string; last: Locator; codeWanted: boolean } | null> {
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
  const filled = [m.user && 'username', m.pass && 'password'].filter(Boolean).join(', ');
  return { text: `Browser password manager: filled ${filled}`, last, codeWanted: !!m.otp };
}

/** The account to use from one CLI source: the one asked for, or the only one whose website matches the page. */
async function findAccount(page: Page, source: CliSource, wanted?: string): Promise<Account | null> {
  const pageHosts = new Set(liveFrames(page).map((f) => hostOf(f.url())));
  const pageSites = new Set([...pageHosts].map(siteOf));
  const w = wanted?.toLowerCase();
  const matchOf = (all: Account[]) => w
    ? all.filter((a) => a.ref === wanted || a.title.toLowerCase() === w || a.username.toLowerCase() === w)
    : all.filter((a) => sitesOf(a).some((s) => pageSites.has(s)));
  let found = matchOf(await source.accounts(page.url(), false));
  if (!found.length) found = matchOf(await source.accounts(page.url(), true));
  if (!found.length) return null;
  if (w) {
    const here = found.filter((a) => sitesOf(a).some((s) => pageSites.has(s)));
    if (!here.length) {
      const where = sitesOf(found[0]!).join(', ') || 'no website';
      throw new Error(`Refused: login ${label(found[0]!)} is for ${where}, this tab is on ${[...pageSites].join(', ')}. Add this website to the saved login if it is really the same account.`);
    }
    found = here;
  } else {
    const exact = found.filter((a) => a.hosts.some((h) => pageHosts.has(h)));
    if (exact.length === 1) found = exact;
  }
  if (found.length > 1) throw new Error(`Several saved logins match, pass item with one of these ids: ${found.map(label).join('; ')}`);
  return found[0]!;
}

/** Fills the form from a CLI source, only in frames whose domain matches the account's website. */
async function useAccount(page: Page, account: Account) {
  const sites = sitesOf(account);
  const frames = liveFrames(page).filter((f) => sites.includes(siteOf(hostOf(f.url()))));
  const marks = await markAll(frames);
  if (!marks.some((m) => m && (m.user || m.pass || m.otp))) {
    throw new Error(`No sign-in field visible on ${page.url()}. Open the sign-in form first (often a "Sign in" button).`);
  }
  const creds = await account.reveal();
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
export async function signIn(page: Page, opts: { item?: string; source?: string; submit?: boolean }): Promise<{ text: string; source: string; item?: string }> {
  const all = getSources().filter((s) => !opts.source || s.kind === opts.source);
  if (!all.length) throw new Error(opts.source ? `Password source "${opts.source}" is not configured in FLINTRAIL_PASSWORDS.` : 'fl_login is off (FLINTRAIL_PASSWORDS=off).');
  let done: { text: string; last: Locator; codeWanted: boolean } | null = null;
  let source = '';
  let item: string | undefined;
  for (const s of all) {
    if (s.kind === 'browser') {
      if (opts.item) continue;
      done = await useBrowserFill(page);
      source = 'browser';
    } else {
      const account = await findAccount(page, s, opts.item);
      if (!account) continue;
      done = await useAccount(page, account);
      source = account.source;
      item = account.ref;
    }
    if (done) break;
  }
  if (!done) {
    const tried = all.map((s) => s.kind).join(', ');
    const sites = [...new Set(liveFrames(page).map((f) => siteOf(hostOf(f.url()))))].join(', ');
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
