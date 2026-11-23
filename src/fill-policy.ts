// Who may fill a saved password, and the record of each fill. In one of the user's own browsers, the settings
// of the Flintrail extension decide (on or off, domains, a confirmation each time, one-time codes): only the
// user changes them, in the extension, never an agent through a tool. Every fill is logged without any value.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { getRelayClient } from './relay-client.js';

export interface FillRequest {
  /** Browser the tab lives in ("agent", "brave-soflution"...), and whether its extension holds the settings. */
  browser: string;
  viaExtension: boolean;
  /** Registrable domain (github.com), shown to the user, and the page's own host (gist.github.com), matched against their list. */
  domain: string;
  host: string;
  item: string;
  ref: string;
  source: string;
  /** What is about to be filled: username, password, one-time code. */
  fields: string[];
}

export interface FillDecision {
  totp: boolean;
  approval: 'silent' | 'confirmed by the user' | 'dedicated browser';
}

/** Longer than the extension's own wait for the user's answer (2 minutes). */
const CONFIRM_WAIT_MS = 130_000;

/** Throws when the user's settings refuse this fill; waits for the user's answer when they asked to confirm each one. */
export async function askFill(r: FillRequest): Promise<FillDecision> {
  // The dedicated browser has no extension: FLINTRAIL_PASSWORDS, set by the user, is the setting.
  if (!r.viaExtension) return { totp: true, approval: 'dedicated browser' };
  const relay = getRelayClient();
  if (!relay) throw new Error('Refused: the extension relay is off, so the extension settings cannot be checked.');
  let answer: { refused?: string; totp?: boolean; confirmed?: boolean; noSettings?: boolean };
  try {
    answer = await relay.request('fillPolicy', { key: r.browser, domain: r.domain, host: r.host, item: r.item, source: r.source, fields: r.fields }, CONFIRM_WAIT_MS);
  } catch (e) {
    // An older relay cannot ask the extension: its settings (a confirmation, say) would be skipped.
    if (/Unknown method fillPolicy/.test((e as Error).message)) {
      throw new Error(`Refused: the running Flintrail relay is too old to check the extension settings in ${r.browser}. Close the other conversations so the relay is updated, then try again.`);
    }
    throw e;
  }
  // Extension 1.4.0 and older have no settings: the defaults apply (on, every domain, no confirmation).
  if (answer.noSettings) return { totp: true, approval: 'silent' };
  if (answer.refused) throw new Error(`Refused by the Flintrail extension settings in ${r.browser}: ${answer.refused}.`);
  return { totp: answer.totp !== false, approval: answer.confirmed ? 'confirmed by the user' : 'silent' };
}

/** Appends the fill to ~/.flintrail/fill-audit.log and to the extension's history: which login, where, when, how approved. */
export function recordFill(r: FillRequest, d: FillDecision, filled: string[]) {
  const entry = { at: new Date().toISOString(), browser: r.browser, domain: r.domain, item: r.item, ref: r.ref, source: r.source, filled, approval: d.approval };
  try {
    mkdirSync(config.home, { recursive: true });
    appendFileSync(join(config.home, 'fill-audit.log'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error(`flintrail: could not write the fill audit log: ${(e as Error).message}`);
  }
  if (r.viaExtension) getRelayClient()?.request('fillAudit', { key: r.browser, ...entry }, 5000).catch(() => {});
}
