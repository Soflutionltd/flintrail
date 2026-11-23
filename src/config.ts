import { homedir } from 'node:os';
import { join } from 'node:path';

/** "example.com" is that host only, "*.example.com" is example.com and all its subdomains. Ports are ignored. */
export function parseDomains(list: string): string[] {
  return list.split(',').map((raw) => {
    const rule = raw.trim().toLowerCase();
    if (!rule) return '';
    const wildcard = rule.startsWith('*.');
    // Accept a pasted URL or host:port, keep the host.
    const host = (wildcard ? rule.slice(2) : rule).replace(/^[a-z]+:\/\//, '').replace(/[/:?#].*$/, '').replace(/\.$/, '');
    return host ? (wildcard ? `*.${host}` : host) : '';
  }).filter(Boolean);
}

const env = process.env;
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
  allowedDomains: parseDomains(env.FLINTRAIL_ALLOWED_DOMAINS || ''),
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
};
