// Signs in with a 1Password item. Flintrail reads the item through 1Password CLI and fills the form itself:
// the password and the one-time code never reach the agent, only the list of fields filled does.
import { execFile } from 'node:child_process';
import type { Frame, Locator, Page } from 'playwright-core';
import { config } from './config.js';
import { withNavigation } from './engine.js';

interface OpItem {
  id: string;
  title: string;
  vault: { id: string; name: string };
  urls?: { href: string }[];
  additional_information?: string;
}
interface Candidate extends OpItem { cli: string; hosts: string[]; sites: string[] }
interface OpField { type?: string; purpose?: string; value?: string; totp?: string }
interface Marked { user: boolean; pass: boolean; otp: 'one' | 'split' | null }

const LIST_TTL = 10 * 60_000;
const TIMEOUT = 8000;
const lists = new Map<string, { at: number; items: Candidate[] }>();
/** Secret -> time after which it is no longer masked. One-time codes expire fast and look like ordinary numbers. */
const secrets = new Map<string, number>();
const CODE_MASK_MS = 3 * 60_000;
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

const hostOf = (url: string) => {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** Registrable domain, close enough for matching a page to a vault item: accounts.google.com -> google.com. */
export function siteOf(host: string): string {
  const h = host.replace(/\.$/, '');
  if (!h.includes('.') || h.includes(':') || /^[\d.]+$/.test(h)) return h;
  const p = h.split('.');
  const twoPart = p.length > 2 && p.at(-1)!.length === 2 && /^(co|com|org|net|gov|gouv|ac|edu)$/.test(p.at(-2)!);
  return p.slice(twoPart ? -3 : -2).join('.');
}

function op(cli: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`1Password CLI (${cli}): ${(stderr || err.message).trim().split('\n')[0]}`));
      else resolve(stdout);
    });
  });
}

async function itemsOf(cli: string, fresh: boolean): Promise<Candidate[]> {
  const hit = lists.get(cli);
  if (hit && !fresh && Date.now() - hit.at < LIST_TTL) return hit.items;
  const raw = JSON.parse(await op(cli, ['item', 'list', '--categories', 'Login', '--format', 'json'])) as OpItem[];
  const items = raw.map((i) => {
    const hosts = (i.urls || []).map((u) => hostOf(u.href)).filter(Boolean);
    return { ...i, cli, hosts, sites: [...new Set(hosts.map(siteOf))] };
  });
  lists.set(cli, { at: Date.now(), items });
  return items;
}

const liveFrames = (page: Page) => page.frames().filter((f) => !f.isDetached() && /^https?:/.test(f.url()));
const label = (i: Candidate) => `"${i.title}" (${[i.additional_information, `vault ${i.vault.name}`, `id ${i.id}`].filter(Boolean).join(', ')})`;

/** The item to use: the one asked for, or the only Login whose website matches the page. Sources are tried in order. */
async function findItem(page: Page, wanted?: string): Promise<Candidate> {
  const frames = liveFrames(page);
  const pageHosts = new Set(frames.map((f) => hostOf(f.url())));
  const pageSites = new Set([...pageHosts].map(siteOf));
  const matchOf = (items: Candidate[]) => wanted
    ? items.filter((i) => i.id === wanted || i.title.toLowerCase() === wanted.toLowerCase())
    : items.filter((i) => i.sites.some((s) => pageSites.has(s)));
  for (const cli of config.opClis) {
    let found = matchOf(await itemsOf(cli, false));
    if (!found.length) found = matchOf(await itemsOf(cli, true));
    if (!found.length) continue;
    if (wanted) {
      const here = found.filter((i) => i.sites.some((s) => pageSites.has(s)));
      if (!here.length) {
        const where = found[0]!.sites.join(', ') || 'no website';
        throw new Error(`Refused: 1Password item ${label(found[0]!)} is for ${where}, this tab is on ${[...pageSites].join(', ')}. Add this website to the item in 1Password if it is really the same account.`);
      }
      found = here;
    } else {
      const exact = found.filter((i) => i.hosts.some((h) => pageHosts.has(h)));
      if (exact.length === 1) found = exact;
    }
    if (found.length > 1) throw new Error(`Several 1Password items match, pass item with one of these ids: ${found.map(label).join('; ')}`);
    return found[0]!;
  }
  throw new Error(wanted
    ? `No 1Password Login item "${wanted}" in the vaults Flintrail can read.`
    : `No 1Password Login item for ${[...pageSites].join(', ')}. Pass item, or add this website to the right item in 1Password.`);
}

async function credentials(item: Candidate) {
  const raw = await op(item.cli, ['item', 'get', item.id, '--vault', item.vault.id, '--reveal', '--format', 'json']);
  const fields = (JSON.parse(raw) as { fields?: OpField[] }).fields || [];
  const password = fields.find((f) => f.purpose === 'PASSWORD')?.value || '';
  const totp = fields.find((f) => f.type === 'OTP')?.totp || '';
  remember(password, Infinity);
  remember(totp, CODE_MASK_MS);
  return { username: fields.find((f) => f.purpose === 'USERNAME')?.value || '', password, totp };
}

/** Runs in the page: tags the visible username, password and one-time-code inputs with data-fl-login. */
function markLoginFields(): Marked {
  for (const el of document.querySelectorAll('[data-fl-login]')) el.removeAttribute('data-fl-login');
  const shown = (el: HTMLInputElement) => {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
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
  return { user: !!user, pass: !!pass, otp };
}

/**
 * Fills the sign-in fields visible on the page (username, password, one-time code) from a 1Password item,
 * only in frames whose domain matches the item's website. Call it again on each step of a multi-step sign-in.
 */
export async function signIn(page: Page, opts: { item?: string; submit?: boolean }): Promise<{ item: string; text: string }> {
  if (!config.opClis.length) throw new Error('fl_login is off: set FLINTRAIL_OP to the 1Password CLI command to use.');
  const item = await findItem(page, opts.item);
  const frames = liveFrames(page).filter((f) => item.sites.includes(siteOf(hostOf(f.url()))));
  const marks = await Promise.all(frames.map((f) => f.evaluate(markLoginFields).catch(() => null)));
  if (!marks.some((m) => m && (m.user || m.pass || m.otp))) {
    throw new Error(`No sign-in field visible on ${page.url()}. Open the sign-in form first (often a "Sign in" button).`);
  }
  const creds = await credentials(item);
  const filled: string[] = [];
  let last: Locator | null = null;
  let codeWanted = false;
  for (let i = 0; i < frames.length; i++) {
    const m = marks[i];
    if (!m) continue;
    const field = (k: string) => (frames[i] as Frame).locator(`[data-fl-login="${k}"]`).first();
    if (m.user && creds.username) {
      await field('user').fill(creds.username, { timeout: TIMEOUT });
      filled.push('username');
      last = field('user');
    }
    if (m.pass) {
      if (!creds.password) throw new Error(`1Password item ${label(item)} has no password.`);
      await field('pass').fill(creds.password, { timeout: TIMEOUT });
      filled.push('password');
      last = field('pass');
    }
    if (m.otp && !creds.totp) codeWanted = true;
    if (m.otp && creds.totp) {
      const box = field('otp');
      if (m.otp === 'split') {
        await box.click({ timeout: TIMEOUT });
        await page.keyboard.type(creds.totp, { delay: 40 });
      } else await box.fill(creds.totp, { timeout: TIMEOUT });
      filled.push('one-time code');
      last = box;
    }
  }
  if (!last) {
    throw new Error(codeWanted
      ? `The page asks for a code that 1Password does not hold for ${label(item)} (SMS, e-mail or phone prompt): ask the user for it.`
      : `Nothing to fill: item ${label(item)} has no username for this field.`);
  }
  const submit = opts.submit !== false;
  if (submit) await withNavigation(page, () => last!.press('Enter', { timeout: TIMEOUT }));
  const extra = codeWanted ? ' The page also asks for a code 1Password does not hold: ask the user for it.' : '';
  return { item: item.id, text: `1Password item ${label(item)}: filled ${filled.join(', ')}${submit ? ', submitted' : ''}.${extra}` };
}
