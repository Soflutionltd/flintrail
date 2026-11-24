// What the relay daemon, its Flintrail clients and the browser extension agree on.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Bumped on any incompatible change of the /client protocol. */
export const RELAY_PROTOCOL = 1;

/** A browser connected to the relay, as clients see it. */
export interface BrowserInfo {
  /** Name to pass as browser: brave, brave-ideekdo, chrome ... */
  key: string;
  /** Name the user gave this browser in the extension, or "". */
  label: string;
  /** Name of the browser profile it runs in ("Soflution"), or "" when it could not be found. */
  profile: string;
  browser: string;
  /** Extension version. */
  version: string;
  /** Extension older than 1.4: it sends the token in clear and cannot release tabs one by one. */
  legacy: boolean;
}

/** HMAC-SHA256 of message with the shared token: proves knowledge of the token without sending it. */
export function macFor(token: string, message: string): string {
  return createHmac('sha256', token).update(message).digest('hex');
}

export function macMatches(token: string, message: string, mac: string): boolean {
  const expected = Buffer.from(macFor(token, message));
  const given = Buffer.from(mac);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** "IdéeKdo perso" -> ideekdo-perso. Names and labels are compared this way on both sides. */
export function slug(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * How a tab's address must match what an agent asked for: "contains" (fl_adopt, any part of the address),
 * "prefix" (fl_open, that page or one under it) or "origin" (fl_open, the same site exactly). The last two
 * never take a tab of another site whose address merely mentions the one asked for.
 */
export type MatchMode = 'contains' | 'prefix' | 'origin';

export function urlMatches(url: string, match: string, mode: MatchMode = 'contains'): boolean {
  if (mode === 'contains') return url.includes(match);
  if (mode === 'prefix') return url.startsWith(match) && /^($|[/?#])/.test(url.slice(match.length));
  try { return new URL(url).origin === match; } catch { return false; }
}
