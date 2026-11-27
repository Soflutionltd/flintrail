import { resolveHome } from './legacy.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** "example.com" is that host only, "*.example.com" is example.com and all its subdomains. Ports are ignored. */
export function parseDomains(list: string): string[] {
  const rules: string[] = [];
  const bad: string[] = [];
  for (const raw of list.split(',')) {
    const rule = raw.trim().toLowerCase();
    if (!rule) continue;
    const wildcard = rule.startsWith('*.');
    // Accept a pasted URL or host:port, keep the host.
    const host = (wildcard ? rule.slice(2) : rule).replace(/^https?:\/\//, '').replace(/[/:?#].*$/, '').replace(/\.$/, '');
    // A name with a dot, an IPv4 address or "localhost": anything else is a typo, and a typo must not open every site.
    if (/^(localhost|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/.test(host)) rules.push(wildcard ? `*.${host}` : host);
    else bad.push(raw.trim());
  }
  if (bad.length) throw new Error(`ROCKETWRIGHT_ALLOWED_DOMAINS: cannot read ${bad.map((b) => `"${b}"`).join(', ')}. Use host names such as example.com or *.example.com, comma separated.`);
  if (list.trim() && !rules.length) throw new Error('ROCKETWRIGHT_ALLOWED_DOMAINS is set but lists no site.');
  return rules;
}

const env = process.env;

/** A list that cannot be read stops Rocketwright with one clear line, never with every site open. */
function allowedDomainsOrExit(): string[] {
  try {
    return parseDomains(env.ROCKETWRIGHT_ALLOWED_DOMAINS || '');
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
const port = Number(env.ROCKETWRIGHT_PORT || 9222);
const home = resolveHome(homedir(), env);

export const config = {
  /** attach: drive a running Chrome over CDP. launch: start a dedicated Chromium. extension: drive the browser where the Rocketwright extension is installed. */
  mode: (['launch', 'extension'].includes(env.ROCKETWRIGHT_MODE || '') ? env.ROCKETWRIGHT_MODE : 'attach') as 'attach' | 'launch' | 'extension',
  port,
  cdpUrl: env.ROCKETWRIGHT_CDP_URL || `http://127.0.0.1:${port}`,
  cdpUrlExplicit: !!env.ROCKETWRIGHT_CDP_URL,
  chromePath: env.ROCKETWRIGHT_CHROME || '',
  headless: env.ROCKETWRIGHT_HEADLESS !== '0',
  allowAnyBrowser: env.ROCKETWRIGHT_ALLOW_ANY_BROWSER === '1',
  /** user-data-dir of a dedicated automation profile in a regular Chrome (e.g. one 1Password can connect to). */
  dedicatedProfile: env.ROCKETWRIGHT_DEDICATED_PROFILE || '',
  /** Sites the agent may open, read and send requests to. Empty: any site. */
  allowedDomains: allowedDomainsOrExit(),
  home,
  flowsDir: join(home, 'flows'),
  profileDir: env.ROCKETWRIGHT_PROFILE || join(home, 'profile'),
  relayPort: Number(env.ROCKETWRIGHT_RELAY_PORT || 8932),
  /** How long a call waits for a browser to connect. Above 30 s: after Rocketwright restarts, the extension
   * only notices on its next reconnect alarm, which fires every 30 s. */
  extensionWaitMs: Number(env.ROCKETWRIGHT_EXTENSION_WAIT || 35000),
  downloadsDir: env.ROCKETWRIGHT_DOWNLOADS || join(homedir(), 'Downloads', 'Rocketwright'),
  /** Password sources fl_login tries in order: browser, 1password[:bin], bitwarden[:bin], command:bin. "off" disables it. */
  passwordSources: (env.ROCKETWRIGHT_PASSWORDS ?? 'browser').trim().toLowerCase() === 'off'
    ? []
    : (env.ROCKETWRIGHT_PASSWORDS || 'browser').split(',').map((c) => c.trim()).filter(Boolean),
  /** Password manager vaults (1Password) searched in the dedicated browser: only these, and never those. Empty: every vault. */
  vaultsAllow: (env.ROCKETWRIGHT_VAULTS || '').split(',').map((c) => c.trim()).filter(Boolean),
  vaultsDeny: (env.ROCKETWRIGHT_EXCLUDE_VAULTS || '').split(',').map((c) => c.trim()).filter(Boolean),
};
