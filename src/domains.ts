// The list of sites the agent may work on (FLINTRAIL_ALLOWED_DOMAINS). Empty: no restriction.
import { config } from './config.js';

export function hostAllowed(host: string, rules: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return rules.some((r) => (r.startsWith('*.') ? h === r.slice(2) || h.endsWith(r.slice(1)) : h === r));
}

/** Why this URL is off limits, or null when the agent may go there. A blank tab is always allowed. */
export function domainProblem(url: string, rules: string[] = config.allowedDomains): string | null {
  if (!rules.length || !url || url === 'about:blank') return null;
  let host = '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
  } catch { /* not a URL: refused below */ }
  if (host && hostAllowed(host, rules)) return null;
  return `${host || url.slice(0, 80)} is outside the sites the user allowed (FLINTRAIL_ALLOWED_DOMAINS: ${rules.join(', ')}). Only the user can change that list.`;
}

export function assertAllowed(url: string) {
  const why = domainProblem(url);
  if (why) throw new Error(`Blocked: ${why}`);
}
