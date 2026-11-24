// fl_session: save the signed-in state of one site from the dedicated browser (its cookies and local storage) to a
// file, and load it back later or on another machine. The file holds live session cookies, so it is written for
// the user only (0600) and its content is never returned to the agent. Only the dedicated browser: the user's own
// browsers keep their sessions themselves, and no agent copies them out.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT, getDriven } from './browser.js';
import { traceRunning } from './evidence.js';
import { config } from './config.js';
import { domainProblem } from './domains.js';
import { getDomain } from 'tldts';

interface Cookie { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' }
interface State { cookies: Cookie[]; origins: { origin: string; localStorage: { name: string; value: string }[] }[] }

const dir = () => join(config.home, 'sessions');
const fileOf = (name: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('name: letters, digits, "_" or "-", up to 64.');
  return join(dir(), `${name}.json`);
};
const siteOk = (site: string) => {
  const s = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$|^127\.0\.0\.1$/.test(s)) throw new Error('site: a domain such as github.com.');
  // A whole public suffix (co.uk, github.io) is not one site.
  const reg = getDomain(s, { allowPrivateDomains: true });
  if (!/^(localhost|127\.0\.0\.1)$/.test(s) && (!reg || !(s === reg || s.endsWith(`.${reg}`)))) throw new Error(`site: ${s} is not one site (a public suffix?).`);
  const away = domainProblem(`https://${s}/`);
  if (away) throw new Error(`Refused: ${away}`);
  return s;
};
const ofSite = (host: string, site: string) => {
  const h = host.replace(/^\./, '').toLowerCase();
  return h === site || h.endsWith(`.${site}`);
};

export async function saveSession(o: { site: string; name: string; replace?: boolean }): Promise<string> {
  const site = siteOk(o.site);
  const driven = await getDriven(AGENT);
  // A trace keeps what each call returns: the cookies would be in it.
  if (traceRunning(driven.ctx)) throw new Error('Refused while a trace records the dedicated browser: it would keep the cookies. fl_trace stop first.');
  const all = await driven.ctx.storageState() as State;
  const state: State = {
    cookies: all.cookies.filter((c) => ofSite(c.domain, site)),
    origins: all.origins.filter((x) => { try { return ofSite(new URL(x.origin).hostname, site); } catch { return false; } }),
  };
  if (!state.cookies.length && !state.origins.length) throw new Error(`Nothing to save: the dedicated browser holds no cookie or storage for ${site}. Sign in there first.`);
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  chmodSync(dir(), 0o700);
  const file = fileOf(o.name);
  let there: ReturnType<typeof lstatSync> | null = null;
  try { there = lstatSync(file); } catch { /* new name */ }
  if (there?.isSymbolicLink()) throw new Error(`Refused: ${file} is a link, not a session file.`);
  if (there && !o.replace) throw new Error(`A session "${o.name}" is already saved: pass replace:true to replace it.`);
  // Written beside it, then moved in place: a reader never sees half a file, and no link is followed.
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ site, savedAt: new Date().toISOString(), ...state }), { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  return `Saved the session of ${site} as "${o.name}" (${state.cookies.length} cookies, ${state.origins.length} storage origins) in ${file}, readable by the user only. It holds live sign-in cookies: its content is never shown to you.`;
}

export async function loadSession(o: { name: string }): Promise<string> {
  const file = fileOf(o.name);
  if (!existsSync(file)) throw new Error(`No saved session "${o.name}".`);
  let saved: State & { site?: string };
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Session "${o.name}" is not a file Flintrail wrote.`);
  }
  const site = siteOk(String(saved.site || ''));
  // Only what belongs to the site it was saved for: a file edited to carry other sites' cookies loads nothing more.
  const cookies = (saved.cookies || []).filter((c) => ofSite(String(c.domain || ''), site));
  const origins = (saved.origins || []).filter((x) => { try { return ofSite(new URL(x.origin).hostname, site); } catch { return false; } });
  const driven = await getDriven(AGENT);
  if (traceRunning(driven.ctx)) throw new Error('Refused while a trace records the dedicated browser: it would keep the cookies. fl_trace stop first.');
  if (cookies.length) await driven.ctx.addCookies(cookies);
  for (const { origin: raw, localStorage } of origins) {
    const origin = new URL(raw).origin;
    // The origin's storage is written from a blank page served locally: the site itself is not contacted.
    const page = await driven.ctx.newPage();
    try {
      await page.route(`${origin}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Flintrail</title>' }));
      await page.goto(`${origin}/`);
      await page.evaluate((items) => { for (const { name, value } of items) window.localStorage.setItem(name, value); }, localStorage);
    } finally {
      await page.close();
    }
  }
  return `Loaded the session "${o.name}" of ${site} into the dedicated browser (${cookies.length} cookies, ${origins.length} storage origins). Open ${site} with fl_open.`;
}
