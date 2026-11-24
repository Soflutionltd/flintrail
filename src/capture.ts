// fl_capture_secret: a secret a site shows once (a new GitHub or Cloudflare token, an API key) goes straight from
// the page into a vault, never to the agent. The page is read by the extension's own script in the page, which
// keeps working where another extension (a password manager) made the browser stop debugging the tab.
//
// The agent chooses little and learns little: the tab must be on the site that issues that kind of secret (and on
// the sites the user allows), the value must have that kind's exact form, a vault entry is never replaced without
// the user's click, and every failure reads the same, so trying again and again teaches nothing about the page.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { domainProblem } from './domains.js';
import { sealSite } from './engine.js';
import { getRelayClient } from './relay-client.js';
import { remember } from './secrets.js';

/** Each kind: the sites that issue it, its public prefix (shown to the agent) and its exact form. */
export const SECRET_KINDS = {
  github: { sites: ['github.com'], prefix: /^(?:github_pat_|gh[pousr]_)/, form: '(?:github_pat_[A-Za-z0-9_]{60,}|gh[pousr]_[A-Za-z0-9]{36,})' },
  // The 40-character form must hold a letter past f or a _ or -: never a commit hash.
  cloudflare: { sites: ['cloudflare.com'], prefix: /^cfut_/, form: '(?:cfut_[A-Za-z0-9_-]{20,}|(?=[A-Za-z0-9_-]{0,39}[G-Zg-z_-])[A-Za-z0-9_-]{40})' },
  stripe: { sites: ['stripe.com'], prefix: /^(?:sk|rk)_(?:live|test)_/, form: '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}' },
  npm: { sites: ['npmjs.com'], prefix: /^npm_/, form: 'npm_[A-Za-z0-9]{30,}' },
  openai: { sites: ['openai.com'], prefix: /^sk-(?:proj-)?/, form: 'sk-(?:proj-)?[A-Za-z0-9_-]{30,}' },
  anthropic: { sites: ['anthropic.com', 'claude.com'], prefix: /^sk-ant-/, form: 'sk-ant-[A-Za-z0-9_-]{30,}' },
  resend: { sites: ['resend.com'], prefix: /^re_/, form: 're_[A-Za-z0-9_]{20,}' },
} as const;
export type SecretKind = keyof typeof SECRET_KINDS | 'prefix';

// A value is only taken whole: nothing glued to it on either side.
const whole = (form: string) => `(?<![A-Za-z0-9_-])${form}(?![A-Za-z0-9_-])`;

/** The form searched: a known kind, or a literal prefix ending in "_" or "-" followed by a long token. Never free text. */
export function secretForm(kind: SecretKind, prefix?: string): string {
  if (kind !== 'prefix') return SECRET_KINDS[kind].form;
  const p = String(prefix || '');
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,15}[_-]$/.test(p)) throw new Error('prefix: the literal start of the secret, 3 to 17 letters, digits, "_" or "-", ending in "_" or "-", e.g. "pk_live_" or "pat-".');
  return `${p.replace(/-/g, '\\-')}[A-Za-z0-9_-]{16,}`;
}

export type Destination = { kind: 'mcphub'; tenant?: string; name: string } | { kind: '1password'; vault: string; title: string };

export function parseDestination(to: string): Destination {
  const t = to.trim();
  let m = /^mcphub:(?:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/)?([A-Za-z0-9_]{1,128})$/.exec(t);
  if (m) return { kind: 'mcphub', ...(m[1] ? { tenant: m[1] } : {}), name: m[2]! };
  m = /^1password:([A-Za-z0-9][^/]{0,99})\/([^\n]{1,200})$/.exec(t);
  if (m) return { kind: '1password', vault: m[1]!.trim(), title: m[2]!.trim() };
  throw new Error('to: "mcphub:NAME", "mcphub:tenant/NAME" or "1password:Vault/Item title". (No clipboard: an agent could paste it where it reads it.)');
}

const describe = (d: Destination) => d.kind === 'mcphub' ? `McpHub vault${d.tenant ? ` of ${d.tenant}` : ''} as ${d.name}` : `1Password vault "${d.vault}" as "${d.title}"`;

/** Runs a program with the secret on its standard input only: never in its arguments or environment (ps). */
function feed(bin: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('error', (e) => reject(new Error(`${bin}: ${e.message}`)));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${bin} failed: ${err.trim().split('\n')[0] || `exit ${code}`}`)));
    child.stdin.end(input);
  });
}

const mcphub = () => process.env.FLINTRAIL_MCPHUB || 'McpHub';

/** Whether this McpHub vault already holds that name: replacing it needs the user's click. */
function mcphubHas(d: Extract<Destination, { kind: 'mcphub' }>): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(mcphub(), ['vault', 'list', ...(d.tenant ? ['--tenant', d.tenant] : [])], { timeout: 20_000 }, (err, stdout) => {
      // Unknown: treated as existing, so the user decides.
      resolve(err ? true : String(stdout).split('\n').some((l) => l.trim().split(/\s+/)[0] === d.name));
    });
  });
}

function onePasswordBin(): string {
  const entry = config.passwordSources.find((s) => s === '1password' || s.startsWith('1password:'));
  return entry && entry.includes(':') ? entry.slice(entry.indexOf(':') + 1) : 'op';
}

async function store(value: string, d: Destination) {
  if (d.kind === 'mcphub') {
    await feed(mcphub(), ['vault', 'set', ...(d.tenant ? ['--tenant', d.tenant] : []), d.name], value);
  } else {
    const item = { title: d.title, category: 'API_CREDENTIAL', fields: [{ id: 'credential', label: 'credential', type: 'CONCEALED', value }] };
    await feed(onePasswordBin(), ['item', 'create', '--vault', d.vault, '-'], JSON.stringify(item));
  }
}

// A few captures a minute at most: an agent trying page after page learns nothing quickly.
const recent: number[] = [];
const RATE = { max: 10, perMs: 60_000 };

/**
 * Finds the secret in the user's open tab whose address (site and path) contains match, and stores it. Returns
 * what the agent may know: the kind, the length, the kind's public prefix and where it went.
 */
export async function captureSecret(o: { browser: string; match: string; kind: SecretKind; prefix?: string; to: string }): Promise<string> {
  const relay = getRelayClient();
  if (!relay) throw new Error('fl_capture_secret reads a tab of the user\'s browser: the extension relay is off.');
  const match = o.match.trim().replace(/[?#].*$/, '');
  if (match.length < 3) throw new Error('url: at least 3 characters of the tab address (site and path).');
  const destination = parseDestination(o.to);
  const form = secretForm(o.kind, o.prefix);
  const sites = o.kind === 'prefix' ? [] : [...SECRET_KINDS[o.kind].sites];
  // Only the reads of a page count, not a call refused for its arguments.
  const now = Date.now();
  while (recent.length && now - recent[0]! > RATE.perMs) recent.shift();
  if (recent.length >= RATE.max) throw new Error('Too many captures in the last minute: wait a moment.');
  recent.push(now);
  // The user clicks for an unknown kind, a 1Password vault, or a name the McpHub vault already holds.
  const replaces = destination.kind === 'mcphub' && await mcphubHas(destination);
  const confirm = o.kind === 'prefix' || destination.kind === '1password' || replaces;
  const found = await relay.request('captureSecret', {
    key: o.browser, match, source: whole(form), sites, confirm,
    what: `${o.kind === 'prefix' ? `secret starting with ${o.prefix}` : `${o.kind} secret`}`,
    to: `${replaces ? 'replacing ' : ''}${describe(destination)}`,
  }, 130_000) as { refused?: string; value?: string; host?: string };
  if (found.refused) throw new Error(`Refused by the Flintrail extension in ${o.browser}: ${found.refused}.`);
  const value = String(found.value || '');
  const host = String(found.host || '');
  // One message for every miss: no tab, no value, several values, a site outside the user's list.
  const miss = `Nothing captured (or not confirmed by the user): no single ${o.kind === 'prefix' ? 'such' : o.kind} secret on an open ${sites.length ? sites.join(' or ') + ' ' : ''}page matching that address.`;
  if (!value || !new RegExp(`^${form}$`).test(value) || domainProblem(`https://${host}/`)) throw new Error(miss);
  // Masked from now on wherever it might show up again, and the pages of that site are closed to the agent's
  // scripts and screenshots until they change page.
  remember(value, Infinity);
  sealSite(host);
  await store(value, destination);
  const entry = { at: new Date().toISOString(), browser: o.browser, domain: host, captured: o.kind, to: describe(destination), approval: confirm ? 'confirmed by the user' : 'silent' };
  try {
    mkdirSync(config.home, { recursive: true });
    appendFileSync(join(config.home, 'fill-audit.log'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error(`flintrail: could not write the audit log: ${(e as Error).message}`);
  }
  const shown = o.kind === 'prefix' ? String(o.prefix) : SECRET_KINDS[o.kind].prefix.exec(value)?.[0] || '';
  return `Captured a ${o.kind === 'prefix' ? 'secret' : `${o.kind} secret`} from ${host} (${value.length} characters${shown ? `, starts with ${shown}` : ''}) into ${describe(destination)}. Its value is never shown to you.`;
}
