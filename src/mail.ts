// fl_mail_code and fl_mail_link: a verification code or link sent to a mailbox the user has open in the same browser
// (Gmail, Outlook on the web) is read by Rocketwright itself, never by the agent. The code is typed into the form and
// masked in everything returned; the link is opened only when it leads to the sender's own organisation.
import type { Page } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { getDomain } from 'tldts';
import { adoptTab, agentRanJs, drivenPages, getTab, idOf, letGo, markSecretFilled, openOrigins, pageBrowser } from './engine.js';
import { fillProblem, siteOf } from './login.js';
import { hostOf } from './passwords.js';
import { recorder } from './recorder.js';
import { maskUrl, remember, rememberUrlTokens } from './secrets.js';

export type MailProvider = 'gmail' | 'outlook';

/** Webmail sites Rocketwright knows how to read. */
const KNOWN_MAIL_HOSTS: Record<string, MailProvider> = {
  'mail.google.com': 'gmail',
  'outlook.cloud.microsoft': 'outlook',
  'outlook.office.com': 'outlook',
  'outlook.office365.com': 'outlook',
  'outlook.live.com': 'outlook',
};

/**
 * ROCKETWRIGHT_MAIL_HOSTS adds webmail hosts of the user's own (an Outlook Web App on their company's server):
 * "mail.example.com=outlook,webmail.example.org=gmail". Set by the user, never by a tool.
 */
export function mailHosts(env: NodeJS.ProcessEnv = process.env): Record<string, MailProvider> {
  const out: Record<string, MailProvider> = { ...KNOWN_MAIL_HOSTS };
  for (const raw of (env.ROCKETWRIGHT_MAIL_HOSTS || '').split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const m = /^([a-z0-9.-]+)=(gmail|outlook)$/.exec(entry);
    if (!m) throw new Error(`ROCKETWRIGHT_MAIL_HOSTS: cannot read "${raw.trim()}". Write host=gmail or host=outlook, comma separated.`);
    out[m[1]!] = m[2] as MailProvider;
  }
  return out;
}

/** The webmail a page address belongs to, if Rocketwright can read it. */
export function mailProviderOf(url: string): MailProvider | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /(^|\.)localhost$/.test(u.hostname))) return null;
  return mailHosts()[u.hostname.toLowerCase()] ?? null;
}

// ---------- sites never served ----------

/** Payment, bank and crypto services: a code or link of theirs can approve a payment, so the user handles it. */
const MONEY_SITES = new Set([
  'paypal.com', 'paypal.me', 'stripe.com', 'wise.com', 'revolut.com', 'klarna.com', 'adyen.com', 'squareup.com', 'square.com',
  'braintreegateway.com', 'checkout.com', 'mollie.com', 'gocardless.com', 'payoneer.com', 'venmo.com', 'cash.app', 'zelle.com',
  'skrill.com', 'neteller.com', 'paysafecard.com', 'lydia-app.com', 'sumup.com', 'payplug.com', 'lemonway.com', 'qonto.com',
  'n26.com', 'monzo.com', 'starlingbank.com', 'bunq.com', 'boursorama.com', 'boursobank.com', 'fortuneo.fr', 'hellobank.fr',
  'labanquepostale.fr', 'credit-agricole.fr', 'ca-paris.fr', 'lcl.fr', 'bnpparibas', 'mabanque.bnpparibas', 'societegenerale.fr',
  'sg.fr', 'creditmutuel.fr', 'cic.fr', 'caisse-epargne.fr', 'banquepopulaire.fr', 'hsbc.com', 'hsbc.fr', 'barclays.co.uk',
  'lloydsbank.com', 'natwest.com', 'santander.com', 'ing.com', 'americanexpress.com', 'visa.com', 'mastercard.com',
  'coinbase.com', 'binance.com', 'kraken.com', 'bitstamp.net', 'crypto.com', 'gemini.com', 'bitpanda.com', 'blockchain.com',
  'metamask.io', 'ledger.com', 'etoro.com', 'degiro.com', 'tradingview.com', 'interactivebrokers.com', 'robinhood.com', 'trade-republic.com', 'traderepublic.com',
]);
const MONEY_WORDS = /(?:^|[.-])(?:bank|banks|banque|banca|banco|bancaire|bancaria|sparkasse|volksbank|pay|paiement|paiements|payment|payments|pago|pagos|card|cards|carte|credit|crypto|wallet|invest|broker|bourse|trading)(?:[.-]|$)/;

/** Why this site is never served by the mail tools, or null. */
export function moneySite(site: string): string | null {
  const s = site.toLowerCase();
  if (MONEY_SITES.has(s) || MONEY_WORDS.test(s.replace(/\.[a-z]+$/, ''))) {
    return `${s} looks like a payment, bank or crypto service: its codes and links can approve a payment, so Rocketwright never reads or uses them. The user does this step by hand`;
  }
  return null;
}

/** An e-mail about a payment (3-D Secure, a transfer, a purchase): its code or link is for the user only. */
const PAYMENT_SUBJECT = /3-?d ?secure|payment|paiement|pago|zahlung|transaction|purchase|achat|virement|transfer|überweisung|card|carte|montant|amount|order total|checkout/i;

// ---------- the sender ----------

const ADDRESS = /^[\w.+-]+@([\w-]+(?:\.[\w-]+)+)$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$/;

/** The sender the agent expects: a whole address or a domain, never a display name (anyone can write "Cloudflare"). */
export function parseFrom(from: string): string {
  const f = from.trim().toLowerCase().replace(/^@/, '');
  if (ADDRESS.test(f) || DOMAIN.test(f)) return f;
  throw new Error(`from must be the sender's address or domain (e.g. "noreply@notify.cloudflare.com" or "cloudflare.com"), not "${from.slice(0, 60)}": a display name proves nothing.`);
}

/** The address is the expected one, or within the expected domain (notify.cloudflare.com is within cloudflare.com). */
export function senderMatches(address: string, from: string): boolean {
  const a = address.trim().toLowerCase();
  const m = ADDRESS.exec(a);
  if (!m) return false;
  if (from.includes('@')) return a === from;
  const domain = m[1]!;
  return domain === from || domain.endsWith(`.${from}`);
}

/** The organisation behind an address or a host: its registrable domain (notify.cloudflare.com -> cloudflare.com). */
export function orgOf(addressOrHost: string): string {
  const host = addressOrHost.includes('@') ? addressOrHost.split('@').pop()! : addressOrHost;
  const h = host.toLowerCase().replace(/\.$/, '');
  return getDomain(h, { allowPrivateDomains: true }) || h;
}

// ---------- when it arrived ----------

const MONTHS: string[][] = [
  ['january', 'janvier', 'januar', 'jän', 'enero', 'ene', 'gennaio', 'gen', 'januari', 'janeiro', 'jan', 'janv'],
  ['february', 'février', 'fevrier', 'februar', 'febrero', 'febbraio', 'februari', 'fevereiro', 'feb', 'fév', 'fev', 'févr'],
  ['march', 'mars', 'märz', 'marzo', 'maart', 'março', 'mar', 'mrt', 'mär'],
  ['april', 'avril', 'abril', 'aprile', 'apr', 'avr', 'abr'],
  ['may', 'mai', 'mayo', 'maggio', 'mei', 'maio', 'mag'],
  ['june', 'juin', 'juni', 'junio', 'giugno', 'junho', 'jun', 'giu'],
  ['july', 'juillet', 'juli', 'julio', 'luglio', 'julho', 'jul', 'juil', 'lug'],
  ['august', 'août', 'aout', 'agosto', 'augustus', 'aug', 'ago', 'aoû'],
  ['september', 'septembre', 'septiembre', 'settembre', 'setembro', 'sep', 'sept', 'set'],
  ['october', 'octobre', 'oktober', 'octubre', 'ottobre', 'outubro', 'oct', 'okt', 'ott', 'out'],
  ['november', 'novembre', 'noviembre', 'novembro', 'nov'],
  ['december', 'décembre', 'decembre', 'dezember', 'diciembre', 'dicembre', 'dezembro', 'dec', 'déc', 'dez', 'dic'],
];

/** The month a word names ("nov.", "décembre", "März"), by its longest known start, or -1. */
function monthOf(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return -1;
  let best = -1;
  let len = 0;
  MONTHS.forEach((names, i) => {
    for (const n of names) if (n.length > len && (w === n || (n.length >= 3 && w.startsWith(n) && names.some((full) => full.startsWith(w))))) { best = i; len = n.length; }
  });
  return best;
}

/**
 * When an e-mail arrived, from what a webmail shows: "10:42", "10:42 AM", "Fri, Nov 27, 2026, 10:42 AM",
 * "ven. 27 nov. 2026 10:42", "27/11/2026 10:42", "5 minutes ago", "il y a 5 min", "Yesterday 23:58"... in the
 * browser's local time, which is this computer's. null when it cannot be told: the e-mail is then not used.
 * lang ("en-US", "fr-FR") decides how 03/04 reads. Returns the time and whether a date was part of it.
 */
export function parseMailTime(text: string, now: Date = new Date(), lang = 'en-US'): { at: Date; dated: boolean } | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  if (/^(just now|now|à l'instant|a l'instant|maintenant|gerade eben|jetzt|ahora|adesso|agora)$/.test(t)) return { at: new Date(now), dated: true };
  const rel = /(\d{1,3}) ?(?:min|mins|minute|minutes|minuten|minutos|minuti|mn)\b/.exec(t);
  if (rel && /ago|il y a|vor |hace|fa\b|há /.test(t)) return { at: new Date(now.getTime() - Number(rel[1]) * 60_000), dated: true };
  const hoursAgo = /(\d{1,2}) ?(?:h|hr|hrs|hour|hours|heure|heures|stunde|stunden|hora|horas|ore)\b/.exec(t);
  if (hoursAgo && /ago|il y a|vor |hace|fa\b|há /.test(t)) return { at: new Date(now.getTime() - Number(hoursAgo[1]) * 3_600_000), dated: true };

  const tm = /(\d{1,2}) ?[:h] ?(\d{2})(?!\d)(?: ?([ap])\.? ?m\.?)?/.exec(t);
  let hours = -1;
  let minutes = 0;
  if (tm) {
    hours = Number(tm[1]);
    minutes = Number(tm[2]);
    if (tm[3] === 'p' && hours < 12) hours += 12;
    if (tm[3] === 'a' && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
  }
  // The rest of the text, without the time: a date, if any.
  const rest = tm ? t.slice(0, tm.index) + ' ' + t.slice(tm.index + tm[0].length) : t;
  let year = -1;
  let month = -1;
  let day = -1;
  const iso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(rest);
  const numeric = /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/.exec(rest);
  const dayMonth = /\b(\d{1,2})\.? ([a-zäéèûôüç]{3,})\.?/.exec(rest);
  const monthDay = /\b([a-zäéèûôüç]{3,})\.? (\d{1,2})\b/.exec(rest);
  if (iso) {
    year = Number(iso[1]); month = Number(iso[2]) - 1; day = Number(iso[3]);
  } else if (dayMonth && monthOf(dayMonth[2]!) >= 0) {
    day = Number(dayMonth[1]); month = monthOf(dayMonth[2]!);
  } else if (monthDay && monthOf(monthDay[1]!) >= 0) {
    month = monthOf(monthDay[1]!); day = Number(monthDay[2]);
  } else if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const monthFirst = /^en-us\b|^en$/i.test(lang) ? a <= 12 : b > 12 && a <= 12;
    month = (monthFirst ? a : b) - 1;
    day = monthFirst ? b : a;
    if (numeric[3]) year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
  }
  const y4 = /\b(20\d{2})\b/.exec(rest);
  if (year < 0 && y4) year = Number(y4[1]);
  const yesterday = /\b(yesterday|hier|gestern|ayer|ieri|ontem|gisteren)\b/.test(rest);
  if (month < 0 && hours < 0) return null;
  if (month >= 0 && (month > 11 || day < 1 || day > 31)) return null;
  const at = new Date(now);
  at.setSeconds(0, 0);
  if (month >= 0) {
    at.setFullYear(year > 0 ? year : now.getFullYear(), month, day);
    at.setHours(hours >= 0 ? hours : 0, hours >= 0 ? minutes : 0);
    // "Dec 31" seen on January 1st, without a year: last year.
    if (year < 0 && at.getTime() - now.getTime() > 86_400_000) at.setFullYear(at.getFullYear() - 1);
  } else {
    at.setHours(hours, minutes);
    if (yesterday) at.setDate(at.getDate() - 1);
    // A time alone is today's; one that is still ahead (a list showing the last 24 hours) was yesterday's.
    else if (at.getTime() - now.getTime() > 5 * 60_000) at.setDate(at.getDate() - 1);
  }
  if (at.getTime() - now.getTime() > 5 * 60_000) return null;
  return { at, dated: month >= 0 || yesterday };
}

/** The best reading of several texts showing when an e-mail arrived: the one with both a date and a time first. */
export function bestTime(texts: string[], now: Date, lang: string): Date | null {
  let best: { at: Date; score: number } | null = null;
  for (const text of texts) {
    const p = parseMailTime(text, now, lang);
    if (!p) continue;
    const score = (p.dated ? 2 : 0) + (/\d{1,2} ?[:h] ?\d{2}|ago|il y a|vor |hace/.test(text.toLowerCase()) ? 1 : 0);
    if (!best || score > best.score) best = { at: p.at, score };
  }
  return best?.at ?? null;
}

// ---------- the code ----------

const YEAR = /^(19|20)\d{2}$/;

/**
 * The code an e-mail gives: with pattern, its first capture group (or whole match); else the one group of 4 to 8 digits
 * shown on its own (a big number in a box, in bold), else the first such group in the text that is not a year.
 */
export function extractCode(body: string, emphasized: string[], pattern?: string): string {
  if (pattern !== undefined) {
    if (pattern.length > 200) throw new Error('pattern is too long (200 characters at most).');
    let re: RegExp;
    try { re = new RegExp(pattern, 'u'); } catch (e) { throw new Error(`pattern is not a valid regular expression: ${(e as Error).message}`); }
    const m = re.exec(body);
    const value = (m?.[1] ?? m?.[0] ?? '').trim();
    if (!value) throw new Error('The e-mail has no text matching pattern. Nothing was typed.');
    if (!/^\S{3,32}$/.test(value)) throw new Error('What pattern matched is not a code (3 to 32 characters, no spaces). Nothing was typed.');
    return value;
  }
  const shown = [...new Set(emphasized.map((e) => e.replace(/[\s-]/g, '')).filter((e) => /^\d{4,8}$/.test(e) && !YEAR.test(e)))];
  if (shown.length === 1) return shown[0]!;
  if (shown.length > 1) throw new Error(`The e-mail shows ${shown.length} different numbers that could be the code: pass pattern to say which. Nothing was typed.`);
  for (const m of body.matchAll(/(?<![\d.,:/+©-])(\d{4,8})(?![\d.,:/-]|\s?(?:€|\$|£|%))/g)) {
    if (!YEAR.test(m[1]!)) return m[1]!;
  }
  throw new Error('No code of 4 to 8 digits found in the e-mail: pass pattern if it is made otherwise. Nothing was typed.');
}

// ---------- reading a webmail (run in its page) ----------

interface ListedMail { i: number; senders: string[]; times: string[]; subject: string }
interface ReadMail { ready: boolean; sender: string; subject: string; times: string[]; body: string; emphasized: string[]; links: { text: string; href: string }[] }

/** Runs in the webmail: the message list as shown (newest first), each row tagged with this call's token to click it. */
function listMail(a: { provider: MailProvider; token: string; max: number }): { lang: string; rows: ListedMail[] } {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  };
  const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
  const timeLike = /\d{1,2} ?[:h] ?\d{2}|\d{1,2}[/.]\d{1,2}|\b\d{1,2}\.? ?[a-zäéû]{3,}|[a-zäéû]{3,}\.? \d{1,2}\b|ago|il y a|yesterday|hier/i;
  for (const el of document.querySelectorAll('[data-fl-mail]')) el.removeAttribute('data-fl-mail');
  const selectors = a.provider === 'gmail' ? ['tr.zA'] : ['[role="listbox"] [role="option"]', 'div[data-convid]'];
  let rows: Element[] = [];
  for (const sel of selectors) {
    rows = [...document.querySelectorAll(sel)].filter(visible);
    if (rows.length) break;
  }
  return {
    lang: document.documentElement.lang || navigator.language,
    rows: rows.slice(0, a.max).map((row, i) => {
      row.setAttribute('data-fl-mail', `${a.token}:${i}`);
      const senders = new Set<string>();
      for (const el of row.querySelectorAll('[email]')) senders.add(String(el.getAttribute('email')).trim().toLowerCase());
      for (const el of row.querySelectorAll('[title]')) for (const m of (el.getAttribute('title') || '').match(EMAIL) || []) senders.add(m.toLowerCase());
      const times: string[] = [];
      for (const el of row.querySelectorAll('[title], time, [datetime]')) {
        const v = el.getAttribute('datetime') || el.getAttribute('title') || '';
        if (v && !v.includes('@') && timeLike.test(v) && v.length < 80) times.push(v);
      }
      for (const el of row.querySelectorAll('*')) {
        const own = (el.textContent || '').trim();
        if (el.childElementCount === 0 && own.length <= 24 && !own.includes('@') && timeLike.test(own)) times.push(own);
      }
      const subject = (row.querySelector('.bog, [data-subject]')?.textContent || '').trim().slice(0, 200);
      return { i, senders: [...senders], times, subject };
    }),
  };
}

/** Runs in the webmail: the message open now, its sender, date, subject, text, numbers shown on their own, and links. */
function readMail(a: { provider: MailProvider }): ReadMail & { lang: string } {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  };
  const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
  const timeLike = /\d{1,2} ?[:h] ?\d{2}|ago|il y a/i;
  const lang = document.documentElement.lang || navigator.language;
  const none = { ready: false, sender: '', subject: '', times: [], body: '', emphasized: [], links: [], lang };
  let body: Element | undefined;
  let sender = '';
  let subject = '';
  const times: string[] = [];
  if (a.provider === 'gmail') {
    body = [...document.querySelectorAll('div.a3s')].filter(visible).at(-1);
    if (!body) return none;
    // The last message of the conversation, the one just received: its own header.
    const box = body.closest('.gs') || body.closest('.adn') || body.parentElement || body;
    sender = (box.querySelector('span.gD[email]')?.getAttribute('email') || '').trim().toLowerCase();
    for (const el of box.querySelectorAll('span.g3')) times.push(el.getAttribute('title') || '', (el.textContent || '').trim());
    subject = ([...document.querySelectorAll('h2.hP')].find(visible)?.textContent || '').trim();
  } else {
    const labels = ['Message body', 'Corps du message', 'Nachrichtentext', 'Cuerpo del mensaje', 'Corpo del messaggio', 'Corpo da mensagem', 'Berichttekst'];
    body = [...document.querySelectorAll(`${labels.map((l) => `[aria-label="${l}"]`).join(',')}, div[role="document"]`)].filter(visible).at(-1);
    if (!body) return none;
    const found = body;
    const pane = body.closest('[role="main"]') || body.parentElement?.parentElement?.parentElement || document.body;
    // The header is what comes before the body: the sender is the first address there (the recipients follow it).
    const before = (el: Element) => !found.contains(el) && !!(el.compareDocumentPosition(found) & Node.DOCUMENT_POSITION_FOLLOWING);
    // Never the message list (its rows name other senders), the top bar (the user's own account) or the folder list.
    const elsewhere = '[role="listbox"], [role="option"], [data-convid], [role="banner"], [role="navigation"], header';
    for (const el of pane.querySelectorAll('*')) {
      if (!before(el) || !visible(el) || el.closest(elsewhere)) continue;
      const own = el.childElementCount === 0 ? (el.textContent || '').trim() : '';
      if (!sender) {
        const m = EMAIL.exec(el.getAttribute('title') || '') || EMAIL.exec(own);
        if (m) sender = m[0].toLowerCase();
      }
      if (!subject && el.getAttribute('role') === 'heading') subject = (el.textContent || '').trim();
      if (el.getAttribute('data-testid') === 'SentReceivedSavedTime') times.push((el.textContent || '').trim());
      else if (own && own.length <= 40 && !own.includes('@') && timeLike.test(own)) times.push(own);
    }
  }
  const text = ((body as HTMLElement).innerText || '').slice(0, 20000);
  const emphasized = [...body.querySelectorAll('*')]
    .filter((el) => visible(el) && [...el.children].every((c) => !(c.textContent || '').trim()))
    .map((el) => (el.textContent || '').trim())
    .filter((v) => /^[0-9][0-9 -]{2,10}[0-9]$/.test(v));
  const links = [...body.querySelectorAll('a[href]')].slice(0, 200)
    .map((el) => ({ text: ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 200), href: (el as HTMLAnchorElement).href }))
    .filter((l) => /^https?:/i.test(l.href));
  return { ready: true, sender, subject: subject.slice(0, 300), times: times.filter(Boolean), body: text, emphasized, links, lang };
}

// ---------- finding the e-mail ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MailQuery {
  from: string;
  maxAgeMinutes?: number;
  waitSeconds?: number;
}

export interface FoundMail {
  sender: string;
  subject: string;
  receivedAt: Date;
  body: string;
  emphasized: string[];
  links: { text: string; href: string }[];
  /** The mailbox page, and whether this conversation drove it before (else it is let go). */
  mailbox: Page;
  wasDriven: boolean;
}

interface Missed { tooOld?: { sender: string; at: Date }; unreadable: number; otherSender: number }

/** Clicks the row, waits until the reading view shows a message (another one than before, if one was open). */
async function openRow(page: Page, provider: MailProvider, token: string, i: number): Promise<ReadMail & { lang: string }> {
  const before = await page.evaluate(readMail, { provider }).catch(() => null);
  await page.locator(`[data-fl-mail="${token}:${i}"]`).first().click({ timeout: 5000 });
  const t0 = Date.now();
  for (;;) {
    const r = await page.evaluate(readMail, { provider }).catch(() => null);
    if (r?.ready && (!before?.ready || r.body !== before.body || Date.now() - t0 > 2500)) return r;
    if (Date.now() - t0 > 8000) throw new Error('the message did not open');
    await sleep(150);
  }
}

/** The webmail back where it was: the agent and the user find their mailbox as they left it. */
async function restoreView(page: Page, original: string) {
  for (let i = 0; i < 4 && page.url() !== original; i++) {
    await page.goBack({ waitUntil: 'commit', timeout: 4000 }).catch(() => null);
  }
}

/** The newest e-mail from the sender in one mailbox, within the age; what was seen otherwise goes into missed. */
async function searchBox(page: Page, provider: MailProvider, from: string, maxAgeMs: number, round: number, missed: Missed): Promise<Omit<FoundMail, 'mailbox' | 'wasDriven'> | null> {
  const original = page.url();
  try {
    if (provider === 'gmail') {
      // Gmail's own search reaches every category (Updates, Promotions), not only the inbox shown. Its query changes a
      // little each round, so Gmail runs it again and finds what arrived meanwhile.
      const q = `from:(${from}) newer_than:${round % 2 ? 2 : 1}d`;
      await page.evaluate((hash) => { location.hash = hash; }, `#search/${encodeURIComponent(q).replace(/%20/g, '+')}`);
      await sleep(600);
    }
    const token = randomBytes(8).toString('hex');
    let listed: { lang: string; rows: ListedMail[] } = { lang: 'en-US', rows: [] };
    for (let t0 = Date.now(); Date.now() - t0 < 4000; await sleep(200)) {
      listed = await page.evaluate(listMail, { provider, token, max: 25 });
      if (listed.rows.length) break;
    }
    const now = new Date();
    let opened = 0;
    for (const row of listed.rows) {
      // A row that names its sender, and not the one expected, is not opened.
      if (row.senders.length && !row.senders.some((s) => senderMatches(s, from))) continue;
      const rowAt = bestTime(row.times, now, listed.lang);
      if (rowAt && now.getTime() - rowAt.getTime() > maxAgeMs) {
        if (row.senders.length && !missed.tooOld) missed.tooOld = { sender: row.senders.find((s) => senderMatches(s, from))!, at: rowAt };
        continue;
      }
      // Rows that do not name their sender are opened, the newest first, three at most.
      if (++opened > 3) break;
      const mail = await openRow(page, provider, token, row.i);
      if (!mail.sender || !senderMatches(mail.sender, from)) {
        if (mail.sender) missed.otherSender++;
        else missed.unreadable++;
        continue;
      }
      const at = bestTime(mail.times, now, mail.lang) ?? rowAt;
      if (!at) { missed.unreadable++; continue; }
      if (now.getTime() - at.getTime() > maxAgeMs) {
        if (!missed.tooOld) missed.tooOld = { sender: mail.sender, at };
        continue;
      }
      return { sender: mail.sender, subject: mail.subject || row.subject, receivedAt: at, body: mail.body, emphasized: mail.emphasized, links: mail.links };
    }
    return null;
  } finally {
    await restoreView(page, original);
  }
}

/** "10:42, 3 min ago" in this computer's time. */
export function describeTime(at: Date, now = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}, ${mins} min ago`;
}

/**
 * The newest e-mail from the sender, received within maxAgeMinutes, in a webmail tab open in this browser (driven
 * already, or taken over for the time of the search and let go after). Waits up to waitSeconds for it to arrive.
 */
export async function findMail(browserName: string, q: MailQuery): Promise<FoundMail> {
  if (recorder.active) throw new Error('Refused while recording a flow: a code or link sent by e-mail is new each time and cannot be replayed. Stop the recording first.');
  const from = parseFrom(q.from);
  const maxAge = q.maxAgeMinutes ?? 10;
  if (!(maxAge > 0 && maxAge <= 24 * 60)) throw new Error('maxAgeMinutes must be between 1 and 1440.');
  const wait = q.waitSeconds ?? 30;
  if (!(wait >= 0 && wait <= 180)) throw new Error('waitSeconds must be between 0 and 180.');
  const senderMoney = moneySite(orgOf(from));
  if (senderMoney) throw new Error(`Refused: ${senderMoney}.`);

  const driven = drivenPages(browserName).filter(({ page }) => mailProviderOf(page.url()));
  const drivenSites = new Set(driven.map(({ page }) => new URL(page.url()).origin));
  const others = [...new Set((await openOrigins(browserName)).filter((o) => mailProviderOf(o) && !drivenSites.has(o)))];
  const boxes: { id: string; page: Page; wasDriven: boolean }[] = driven.map((d) => ({ ...d, wasDriven: true }));
  const adopted: string[] = [];
  const refusals: string[] = [];
  for (const origin of others) {
    try {
      const id = await adoptTab(origin, browserName, 'origin');
      adopted.push(id);
      boxes.push({ id, page: getTab(id), wasDriven: false });
    } catch (e) {
      refusals.push(`${origin}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (!boxes.length) {
    throw new Error(`No webmail tab Rocketwright can read is open in ${browserName} (Gmail: mail.google.com; Outlook: outlook.cloud.microsoft, outlook.office.com, outlook.live.com)` +
      `${refusals.length ? `; ${refusals.join('; ')}` : ''}. Ask the user to open their mailbox in that browser, or open it with fl_open if they agree, then call this again.`);
  }
  const missed: Missed = { unreadable: 0, otherSender: 0 };
  let found: Omit<FoundMail, 'mailbox' | 'wasDriven'> | null = null;
  let where: { page: Page; wasDriven: boolean } | null = null;
  try {
    const deadline = Date.now() + wait * 1000;
    for (let round = 0; !found; round++) {
      for (const box of boxes) {
        found = await searchBox(box.page, mailProviderOf(box.page.url())!, from, maxAge * 60_000, round, missed);
        if (found) { where = box; break; }
      }
      if (found || Date.now() > deadline) break;
      await sleep(Math.min(3000, Math.max(0, deadline - Date.now())));
    }
  } finally {
    // A mailbox taken over only for this search is given back, as it was.
    for (const id of adopted) if (!where || idOf(where.page) !== id) await letGo(id).catch(() => {});
  }
  if (!found || !where) {
    const why = missed.tooOld
      ? `the newest one from ${missed.tooOld.sender} arrived at ${describeTime(missed.tooOld.at)}, older than ${maxAge} min`
      : missed.otherSender ? `the newest messages there came from other senders` : missed.unreadable ? `${missed.unreadable} message(s) could not be read (sender or date)` : 'none in the message list';
    throw new Error(`No e-mail from ${from} received in the last ${maxAge} min in ${boxes.map((b) => new URL(b.page.url()).hostname).join(', ')} (waited ${wait} s: ${why}). Nothing was used. If the site has not sent it yet, ask it to send again and call this again.`);
  }
  return { ...found, mailbox: where.page, wasDriven: where.wasDriven };
}

/** After use: a mailbox this conversation drives is closed to scripts and screenshots (the code is on screen); one taken over only for the search is let go. */
export async function doneWithMailbox(mail: FoundMail) {
  if (mail.wasDriven) {
    markSecretFilled(mail.mailbox);
    return;
  }
  const id = idOf(mail.mailbox);
  if (id) await letGo(id).catch(() => {});
}

// ---------- fl_mail_code ----------

/** Checks that the sender's organisation is the form's (or the one the agent named), and that neither handles money. */
function assertSameOrg(senderAddress: string, targetHost: string, what: string, site?: string): string {
  const senderOrg = orgOf(senderAddress);
  const targetOrg = siteOf(targetHost);
  for (const s of [senderOrg, targetOrg]) {
    const money = moneySite(s);
    if (money) throw new Error(`Refused: ${money}.`);
  }
  if (senderOrg === targetOrg) return targetOrg;
  if (site === undefined) {
    throw new Error(`Refused: the e-mail comes from ${senderOrg}, ${what} is on ${targetOrg}. If the user confirmed that ${senderOrg} sends the codes or links of ${targetOrg}, pass site:"${targetOrg}". Nothing was used.`);
  }
  if (site.trim().toLowerCase() !== targetOrg) throw new Error(`Refused: site must be the registrable domain of ${what} (${targetOrg}), not "${site.slice(0, 60)}". Nothing was used.`);
  return targetOrg;
}

export interface MailCodeOptions extends MailQuery {
  field?: string;
  pattern?: string;
  submit?: boolean;
  site?: string;
}

/** fl_mail_code: the code of the newest e-mail from the sender, typed into the form of this tab. */
export async function mailCode(form: Page, o: MailCodeOptions, type: (code: string, item: string) => Promise<{ text: string }>): Promise<string> {
  const url = form.url();
  const unsafe = fillProblem(url);
  if (unsafe) throw new Error(`Refused: ${unsafe}. Rocketwright types codes over HTTPS only, or on this computer.`);
  if (agentRanJs(form)) throw new Error('Refused: you ran JavaScript in this tab (eval, extract or request), which could catch the code. Open the form in a new tab (fl_open) and call fl_mail_code there before running any script.');
  const formMoney = moneySite(siteOf(hostOf(url)));
  if (formMoney) throw new Error(`Refused: ${formMoney}.`);
  if (o.site !== undefined) parseSite(o.site);
  const mail = await findMail(pageBrowser(form).browser, o);
  try {
    if (PAYMENT_SUBJECT.test(mail.subject)) throw new Error('Refused: this e-mail is about a payment (its subject says so): its code is for the user only. Nothing was typed.');
    assertSameOrg(mail.sender, hostOf(url), 'the form', o.site);
    const code = extractCode(mail.body, mail.emphasized, o.pattern);
    // Masked from now on, in everything returned: the mailbox's snapshot, the form's, any error.
    remember(code, 60 * 60_000);
    const done = await type(code, `e-mail from ${mail.sender}`);
    return `Code from ${mail.sender} ("${mail.subject || 'no subject'}", received ${describeTime(mail.receivedAt)}): ${code.length} characters, ${done.text}. The code itself is never shown to you.`;
  } finally {
    await doneWithMailbox(mail);
  }
}

/** A registrable domain the agent passes as site. */
function parseSite(site: string): string {
  const s = site.trim().toLowerCase();
  if (!DOMAIN.test(s) || orgOf(s) !== s) throw new Error(`site must be a registrable domain such as example.com, not "${site.slice(0, 60)}".`);
  return s;
}

// ---------- fl_mail_link ----------

const VERIFY_WORDS = /verif|confirm|activat|validat|magic|sign.?in|log.?in|connexion|se connecter|valider|vérifi|confirmer|activer|bestätig|anmelden|verifica|accedi|continue|continuer/i;

export interface MailLinkOptions extends MailQuery {
  link?: string;
  urlContains?: string;
  site?: string;
}

/** The link to open in the e-mail: by its text, by part of its address, or the one verification link to the sender's site. */
export function pickLink(links: { text: string; href: string }[], allowedOrg: string, o: { link?: string; urlContains?: string }): { text: string; href: string } {
  // Before anything can be said about them: every address the links carry, and every address written as their text,
  // is masked from now on (an error listing the links must not hand a token over).
  for (const l of links) {
    rememberUrlTokens(l.href);
    for (const u of l.text.match(URL_IN_TEXT) || []) rememberUrlTokens(u);
  }
  const own = links.filter((l) => { try { return siteOf(new URL(l.href).hostname) === allowedOrg; } catch { return false; } });
  let hits: { text: string; href: string }[];
  if (o.link !== undefined || o.urlContains !== undefined) {
    const t = o.link?.trim().toLowerCase();
    const u = o.urlContains?.trim();
    hits = links.filter((l) => (!t || l.text.toLowerCase().includes(t)) && (!u || l.href.includes(u)));
    if (!hits.length) throw new Error(`No link in the e-mail matches${t ? ` the text "${o.link}"` : ''}${u ? ` the address part "${u}"` : ''}. Links there: ${describeLinks(links)}. Nothing was opened.`);
  } else {
    hits = own.filter((l) => VERIFY_WORDS.test(l.text) || VERIFY_WORDS.test(new URL(l.href).pathname));
    if (!hits.length) throw new Error(`No verification link to ${allowedOrg} found in the e-mail: pass link (its text) or urlContains. Links there: ${describeLinks(links)}. Nothing was opened.`);
  }
  const distinct = [...new Map(hits.map((l) => [l.href, l])).values()];
  if (distinct.length > 1) throw new Error(`${distinct.length} different links match: ${describeLinks(distinct)}. Pass a longer link text or urlContains. Nothing was opened.`);
  return distinct[0]!;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** A link's text as it may be shown: an address written as text is masked like any address. */
export function linkLabel(text: string): string {
  return (text || '(no text)').replace(URL_IN_TEXT, (u) => maskUrl(u));
}

/** Links for a message: their text and site only, never the address (it may hold a token). */
function describeLinks(links: { text: string; href: string }[]): string {
  if (!links.length) return 'none';
  return links.slice(0, 8).map((l) => { let host = ''; try { host = new URL(l.href).hostname; } catch { /* listed without */ } return `"${linkLabel(l.text)}" -> ${host}`; }).join('; ') + (links.length > 8 ? `; ${links.length - 8} more` : '');
}

/** fl_mail_link: the verification link of the newest e-mail from the sender, opened in a new tab of the same browser. */
export async function mailLink(browserName: string, o: MailLinkOptions, open: (url: string) => Promise<{ id: string; page: Page }>): Promise<{ id: string; text: string }> {
  if (o.site !== undefined) parseSite(o.site);
  const mail = await findMail(browserName, o);
  try {
    if (PAYMENT_SUBJECT.test(mail.subject)) throw new Error('Refused: this e-mail is about a payment (its subject says so): its links are for the user only. Nothing was opened.');
    const senderOrg = orgOf(mail.sender);
    const allowedOrg = o.site?.trim().toLowerCase() ?? senderOrg;
    for (const s of [senderOrg, allowedOrg]) {
      const money = moneySite(s);
      if (money) throw new Error(`Refused: ${money}.`);
    }
    const link = pickLink(mail.links, allowedOrg, o);
    const target = new URL(link.href);
    rememberUrlTokens(link.href);
    if (target.protocol !== 'https:' && !/(^|\.)localhost$/.test(target.hostname)) throw new Error(`Refused: the link is not HTTPS (${maskUrl(link.href)}). Nothing was opened.`);
    assertSameOrg(mail.sender, target.hostname, 'the link', o.site);
    const tab = await open(link.href);
    // Where it led, once its redirects are done: still the sender's organisation, or the tab is closed again.
    const landed = tab.page.url();
    rememberUrlTokens(landed);
    const landedOrg = (() => { try { return siteOf(new URL(landed).hostname); } catch { return ''; } })();
    if (landedOrg !== allowedOrg) {
      await tab.page.close().catch(() => {});
      throw new Error(`Refused: the link led to ${landedOrg || 'another kind of page'}, not ${allowedOrg}. The tab was closed.`);
    }
    return { id: tab.id, text: `Link "${linkLabel(link.text)}" from ${mail.sender} ("${mail.subject || 'no subject'}", received ${describeTime(mail.receivedAt)}) opened in tab ${tab.id}: ${maskUrl(landed)} (one-time parts of the address masked).` };
  } finally {
    await doneWithMailbox(mail);
  }
}
