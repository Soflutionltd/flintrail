// Who may fill a saved password, and the record of each fill. In one of the user's own browsers, the settings
// of the Rocketwright extension decide (on or off, domains, a confirmation each time, one-time codes): only the
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
  /** The vault holding the login, checked again against the user's vault rules. */
  vault?: string;
}

export interface FillDecision {
  totp: boolean;
  approval: 'silent' | 'confirmed by the user' | 'dedicated browser';
}

export interface VaultRules { allow: string[]; deny: string[] }

/**
 * Which password manager vaults may be searched: in one of the user's browsers, the extension settings; in the
 * dedicated browser, ROCKETWRIGHT_VAULTS and ROCKETWRIGHT_EXCLUDE_VAULTS. Empty lists: every vault the manager opens.
 */
export async function vaultRules(where: { browser: string; viaExtension: boolean }): Promise<VaultRules> {
  if (!where.viaExtension) return { allow: config.vaultsAllow, deny: config.vaultsDeny };
  const relay = getRelayClient();
  if (!relay) throw new Error('Refused: the extension relay is off, so the extension settings cannot be checked.');
  const r = await relay.request('fillRules', { key: where.browser }, 5000).catch((e: Error) => {
    // An extension older than its vault settings has none: every vault, as before.
    if (/Unknown method fillRules/.test(e.message)) return {};
    throw e;
  }) as { vaultsAllow?: string[]; vaultsDeny?: string[] };
  return { allow: (r.vaultsAllow || []).map(String), deny: (r.vaultsDeny || []).map(String) };
}

/** Whether a vault passes the rules (names compared without case). An account with no vault is not concerned. */
export function vaultAllowed(vault: string | undefined, r: VaultRules): boolean {
  if (!vault) return true;
  const norm = (x: string) => x.normalize('NFC').trim().toLowerCase();
  const v = norm(vault);
  if (r.deny.some((d) => norm(d) === v)) return false;
  return !r.allow.length || r.allow.some((a) => norm(a) === v);
}

/** Longer than the extension's own wait for the user's answer (2 minutes). */
const CONFIRM_WAIT_MS = 130_000;

/** Throws when the user's settings refuse this fill; waits for the user's answer when they asked to confirm each one. */
export async function askFill(r: FillRequest): Promise<FillDecision> {
  // The dedicated browser has no extension: ROCKETWRIGHT_PASSWORDS, set by the user, is the setting.
  if (!r.viaExtension) return { totp: true, approval: 'dedicated browser' };
  const relay = getRelayClient();
  if (!relay) throw new Error('Refused: the extension relay is off, so the extension settings cannot be checked.');
  let answer: { refused?: string; totp?: boolean; confirmed?: boolean; noSettings?: boolean };
  try {
    answer = await relay.request('fillPolicy', { key: r.browser, domain: r.domain, host: r.host, item: r.item, source: r.source, fields: r.fields, ...(r.vault ? { vault: r.vault } : {}) }, CONFIRM_WAIT_MS);
  } catch (e) {
    // An older relay cannot ask the extension: its settings (a confirmation, say) would be skipped.
    if (/Unknown method fillPolicy/.test((e as Error).message)) {
      throw new Error(`Refused: the running Rocketwright relay is too old to check the extension settings in ${r.browser}. Close the other conversations so the relay is updated, then try again.`);
    }
    throw e;
  }
  // Extension 1.4.0 and older have no settings: the defaults apply (on, every domain, no confirmation).
  if (answer.noSettings) return { totp: true, approval: 'silent' };
  if (answer.refused) throw new Error(`Refused by the Rocketwright extension settings in ${r.browser}: ${answer.refused}.`);
  return { totp: answer.totp !== false, approval: answer.confirmed ? 'confirmed by the user' : 'silent' };
}

/** Appends the fill to ~/.rocketwright/fill-audit.log and to the extension's history: which login, where, when, how approved. */
export function recordFill(r: FillRequest, d: FillDecision, filled: string[]) {
  const entry = { at: new Date().toISOString(), browser: r.browser, domain: r.domain, item: r.item, ref: r.ref, source: r.source, filled, approval: d.approval };
  try {
    mkdirSync(config.home, { recursive: true });
    appendFileSync(join(config.home, 'fill-audit.log'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error(`rocketwright: could not write the fill audit log: ${(e as Error).message}`);
  }
  if (r.viaExtension) getRelayClient()?.request('fillAudit', { key: r.browser, ...entry }, 5000).catch(() => {});
}
