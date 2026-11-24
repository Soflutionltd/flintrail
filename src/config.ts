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
  if (bad.length) throw new Error(`FLINTRAIL_ALLOWED_DOMAINS: cannot read ${bad.map((b) => `"${b}"`).join(', ')}. Use host names such as example.com or *.example.com, comma separated.`);
  if (list.trim() && !rules.length) throw new Error('FLINTRAIL_ALLOWED_DOMAINS is set but lists no site.');
  return rules;
}

const env = process.env;

/** A list that cannot be read stops Flintrail with one clear line, never with every site open. */
function allowedDomainsOrExit(): string[] {
  try {
    return parseDomains(env.FLINTRAIL_ALLOWED_DOMAINS || '');
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
const port = Number(env.FLINTRAIL_PORT || 9222);
const home = env.FLINTRAIL_HOME || join(homedir(), '.flintrail');

export const config = {
  /** attach: drive a running Chrome over CDP. launch: start a dedicated Chromium. extension: drive the browser where the Flintrail extension is installed. */
  mode: (['launch', 'extension'].includes(env.FLINTRAIL_MODE || '') ? env.FLINTRAIL_MODE : 'attach') as 'attach' | 'launch' | 'extension',
  port,
  cdpUrl: env.FLINTRAIL_CDP_URL || `http://127.0.0.1:${port}`,
  cdpUrlExplicit: !!env.FLINTRAIL_CDP_URL,
  chromePath: env.FLINTRAIL_CHROME || '',
  headless: env.FLINTRAIL_HEADLESS !== '0',
  allowAnyBrowser: env.FLINTRAIL_ALLOW_ANY_BROWSER === '1',
  /** user-data-dir of a dedicated automation profile in a regular Chrome (e.g. one 1Password can connect to). */
  dedicatedProfile: env.FLINTRAIL_DEDICATED_PROFILE || '',
  /** Sites the agent may open, read and send requests to. Empty: any site. */
  allowedDomains: allowedDomainsOrExit(),
  home,
  flowsDir: join(home, 'flows'),
  profileDir: env.FLINTRAIL_PROFILE || join(home, 'profile'),
  relayPort: Number(env.FLINTRAIL_RELAY_PORT || 8932),
  /** How long a call waits for a browser to connect. Above 30 s: after Flintrail restarts, the extension
   * only notices on its next reconnect alarm, which fires every 30 s. */
  extensionWaitMs: Number(env.FLINTRAIL_EXTENSION_WAIT || 35000),
  downloadsDir: env.FLINTRAIL_DOWNLOADS || join(homedir(), 'Downloads', 'Flintrail'),
  /** Password sources fl_login tries in order: browser, 1password[:bin], bitwarden[:bin], command:bin. "off" disables it. */
  passwordSources: (env.FLINTRAIL_PASSWORDS ?? 'browser').trim().toLowerCase() === 'off'
    ? []
    : (env.FLINTRAIL_PASSWORDS || 'browser').split(',').map((c) => c.trim()).filter(Boolean),
  /** Password manager vaults (1Password) searched in the dedicated browser: only these, and never those. Empty: every vault. */
  vaultsAllow: (env.FLINTRAIL_VAULTS || '').split(',').map((c) => c.trim()).filter(Boolean),
  vaultsDeny: (env.FLINTRAIL_EXCLUDE_VAULTS || '').split(',').map((c) => c.trim()).filter(Boolean),
};
