// fl_paste_secret: the other half of fl_capture_secret. A secret kept in a vault is typed into one field of a page
// (a new token into a deploy setting, an API key into a dashboard) without ever reaching the agent. The user
// clicks to allow each one in the Flintrail extension, which shows the site and the secret's name: a hostile page
// or a misled agent cannot send a secret anywhere without that click.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { describe, mcphub, onePasswordBin, parseDestination, type Destination } from './capture.js';
import { config } from './config.js';
import { domainProblem } from './domains.js';
import { agentRanJs, beforeSecret, elementByRef, loginRunning, markSecretFilled, pageBrowser, sealSite, withNavigation } from './engine.js';
import { siteOf } from './login.js';
import { vaultAllowed, vaultRules } from './fill-policy.js';
import { hostOf } from './passwords.js';
import { getRelayClient } from './relay-client.js';
import { remember } from './secrets.js';

function read(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 90_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // Only the first line of an error, never the output: it could hold the value.
      if (err) reject(new Error(`${bin}: ${String(stderr || err.message).trim().split('\n')[0]}`));
      else resolve(String(stdout));
    });
  });
}

/** The secret's value, read from the vault only after the user allowed it. */
async function reveal(d: Destination, host: string): Promise<string> {
  if (d.kind === 'mcphub') {
    const out = (await read(mcphub(), ['vault', 'get', ...(d.tenant ? ['--tenant', d.tenant] : []), d.name, '--reveal'])).replace(/\r?\n$/, '');
    // Older McpHub printed "NAME = value": that whole line would be typed into the field.
    if (out.startsWith(`${d.name} = `) || out.startsWith(`${d.name}=`)) throw new Error('McpHub printed the name with the value (an older McpHub): update it, then try again. Nothing was pasted.');
    return out;
  }
  interface Field { type?: string; purpose?: string; value?: string }
  interface Item { category?: string; fields?: Field[]; urls?: { href?: string }[] }
  if (d.title.startsWith('-') || d.vault.startsWith('-')) throw new Error('from: a vault or item title cannot start with "-".');
  const raw = await read(onePasswordBin(), ['item', 'get', d.title, '--vault', d.vault, '--reveal', '--format', 'json']);
  let item: Item;
  try {
    item = JSON.parse(raw) as Item;
  } catch {
    throw new Error('1Password: unreadable output (not the JSON Flintrail expects).');
  }
  // An API credential or a password item, or a login of this very site: never a card, a bank account, or the
  // login of another site (fl_login would not fill it here either).
  const category = String(item.category || '').toUpperCase();
  if (!['API_CREDENTIAL', 'PASSWORD', 'LOGIN'].includes(category)) throw new Error(`Refused: that 1Password item is a ${category.toLowerCase().replace(/_/g, ' ') || 'item of unknown kind'}; only an API credential, a password or a login of this site is pasted.`);
  const sites = (item.urls || []).map((u) => siteOf(hostOf(u.href || ''))).filter(Boolean);
  if ((category === 'LOGIN' || sites.length) && !sites.includes(siteOf(host))) throw new Error(`Refused: that 1Password item belongs to ${sites.join(', ') || 'no website'}, not ${siteOf(host)}.`);
  const fields = item.fields || [];
  // The concealed field: an API credential, or the password of a login.
  return (fields.find((f) => f.type === 'CONCEALED' && f.purpose === 'PASSWORD') || fields.find((f) => f.type === 'CONCEALED'))?.value || '';
}

/** Fills the field (ref, selector or label) of this tab with a vault secret, after the user's click. */
export async function pasteSecret(page: Page, o: { ref?: string; selector?: string; label?: string; from: string; submit?: boolean }): Promise<string> {
  let source: Destination;
  try {
    source = parseDestination(o.from);
  } catch {
    throw new Error('from: "mcphub:NAME", "mcphub:tenant/NAME" or "1password:Vault/Item title".');
  }
  const where = pageBrowser(page);
  if (!where.viaExtension) throw new Error('Refused: fl_paste_secret asks the user in the Flintrail extension, so it only works in one of the user\'s own browsers.');
  // A 1Password vault the user excluded in the settings is not read, even with their click.
  if (source.kind === '1password' && !vaultAllowed(source.vault, await vaultRules(where))) throw new Error(`Refused: the vault "${source.vault}" is not one Flintrail may use (extension settings).`);
  // A script the agent ran in this page could catch the value as it is typed.
  if (agentRanJs(page)) throw new Error('Refused: you ran JavaScript in this tab (eval, extract or request), which could catch the secret. Open the page in a new tab (fl_open) and paste there before running any script.');
  const url = page.url();
  const host = hostOf(url);
  if (!/^https:/.test(url) && !/^(localhost|127\.0\.0\.1)$/.test(host)) throw new Error(`Refused: ${host || 'this page'} is not served over HTTPS.`);
  const away = domainProblem(url);
  if (away) throw new Error(`Refused: ${away}`);
  // The main frame only: an embedded frame of another site would get the value.
  if (o.ref && o.ref.includes(':')) throw new Error('Refused: that field is in an embedded frame. Only a field of the page itself can receive a secret.');
  const field: Locator | null = o.ref ? elementByRef(page, o.ref) : o.selector ? page.locator(o.selector).first() : o.label ? page.getByLabel(o.label).first() : null;
  if (!field) throw new Error('Give the field: ref (from the snapshot), selector or label.');
  // Held from here: if the page goes to another document, this handle dies and nothing is filled there.
  const handle = await field.elementHandle({ timeout: 5000 }).catch(() => null);
  if (!handle) throw new Error('That field is not on the page, take a new snapshot.');
  const kind = await handle.evaluate((el, submit) => {
    const input = el as HTMLInputElement;
    if (window !== window.top) return 'frame';
    const visible = !!(el as HTMLElement).getClientRects().length;
    const form = (el as HTMLInputElement).form;
    // A form sent to another site gives it the value; pressing Enter in a form sent by GET puts it in the address.
    if (form && (new URL(form.action, location.href).origin !== location.origin || submit && form.method.toLowerCase() === 'get')) return 'form';
    if (el instanceof HTMLTextAreaElement) return input.disabled || input.readOnly || !visible ? 'locked' : 'textarea';
    if (!(el instanceof HTMLInputElement) || !['text', 'password'].includes(input.type)) return 'other';
    return input.disabled || input.readOnly || !visible ? 'locked' : input.type;
  }, !!o.submit).catch(() => 'missing');
  if (kind === 'missing') throw new Error('That field is not on the page, take a new snapshot.');
  if (kind === 'frame') throw new Error('Refused: that field is in an embedded frame. Only a field of the page itself can receive a secret.');
  if (kind === 'form') throw new Error('Refused: that field\'s form is sent to another site, or by GET with submit (the secret would land in the address).');
  if (!['text', 'password', 'textarea'].includes(kind)) throw new Error('Refused: a secret only goes into a text, password or text area field the user can see and edit.');
  const name = await handle.evaluate((el) => (el.getAttribute('aria-label') || (el as HTMLInputElement).labels?.[0]?.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || 'field').replace(/\s+/g, ' ').trim().slice(0, 60));
  const origin = new URL(url).origin;
  const relay = getRelayClient();
  if (!relay) throw new Error('Refused: the extension relay is off, so the user cannot be asked.');
  // The user sees the site and the secret's name, and clicks. Nothing is read from the vault before.
  // From the question to the end, the agent's scripts and requests are refused in this tab: none can be put in
  // place to catch the value as it is typed.
  loginRunning(page, true);
  let value = '';
  try {
    // A trace or video of this tab is dropped before the user is even asked: it would hold the secret.
    await beforeSecret(page);
    let answer: { refused?: string; confirmed?: boolean };
    try {
      answer = await relay.request('pastePolicy', { key: where.browser, domain: siteOf(host), host, origin, item: describe(source), source: 'vault', ...(source.kind === '1password' ? { vault: source.vault } : {}), fields: [`into the ${kind} field the page calls "${name}"`] }, 130_000);
    } catch (e) {
      if (/Unknown method pastePolicy/.test((e as Error).message)) throw new Error(`Refused: the Flintrail extension in ${where.browser} is too old to ask before pasting a secret. Reload it to update it.`);
      throw e;
    }
    if (answer.refused || !answer.confirmed) throw new Error(`Refused by the Flintrail extension in ${where.browser}: ${answer.refused || 'not confirmed by the user'}.`);
    value = await reveal(source, host);
    if (!value) throw new Error(`Nothing pasted: ${describe(source)} is empty or missing.`);
    remember(value, Infinity);
    // Still the same document, the one the user was shown (the handle would be dead on another one).
    const still = await handle.evaluate((el) => (el.isConnected ? location.origin : '')).catch(() => '');
    if (still !== origin || agentRanJs(page)) throw new Error('Refused: the tab changed while you were asked. Nothing was pasted.');
    markSecretFilled(page);
    sealSite(host);
    await handle.evaluate((el) => el.setAttribute('data-fl-secret', ''));
    await handle.fill(value, { timeout: 8000 });
    if (o.submit) await withNavigation(page, () => handle.press('Enter', { timeout: 8000 }));
  } finally {
    loginRunning(page, false);
    await handle.dispose().catch(() => {});
  }
  const entry = { at: new Date().toISOString(), browser: where.browser, domain: host, pasted: describe(source), field: name, approval: 'confirmed by the user' };
  try {
    mkdirSync(config.home, { recursive: true });
    appendFileSync(join(config.home, 'fill-audit.log'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error(`flintrail: could not write the audit log: ${(e as Error).message}`);
  }
  return `Pasted the secret from ${describe(source)} into "${name}" on ${host} (${value.length} characters), confirmed by the user. Its value is never shown to you; scripts and screenshots of this page are refused until it loads another page.`;
}
