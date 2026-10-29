// Password sources fl_login can read from, besides the browser's own password manager:
// 1Password CLI, Bitwarden CLI, or any command that prints the matching logins as JSON.
import { execFile } from 'node:child_process';

export interface Credentials { username: string; password: string; totp: string }

/** A login found in a source. Holds no secret: reveal() fetches it at fill time. */
export interface Account {
  source: string;
  ref: string;
  title: string;
  username: string;
  where: string;
  hosts: string[];
  reveal(): Promise<Credentials>;
}

export interface CliSource {
  kind: '1password' | 'bitwarden' | 'command';
  /** Accounts that may match pageUrl. fresh skips the list cache. */
  accounts(pageUrl: string, fresh: boolean): Promise<Account[]>;
}

export type SourceSpec = { kind: 'browser' } | CliSource;

const LIST_TTL = 10 * 60_000;

export const hostOf = (url: string) => {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return '';
  }
};

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin}: ${(stderr || err.message).trim().split('\n')[0]}`));
      else resolve(stdout);
    });
  });
}

/** Lists once, then serves the cached metadata for LIST_TTL. */
function cachedList(load: () => Promise<Account[]>) {
  let cache: { at: number; items: Account[] } | null = null;
  return async (fresh: boolean) => {
    if (!cache || fresh || Date.now() - cache.at > LIST_TTL) cache = { at: Date.now(), items: await load() };
    return cache.items;
  };
}

function onePassword(bin: string): CliSource {
  interface OpItem { id: string; title: string; vault: { id: string; name: string }; urls?: { href: string }[]; additional_information?: string }
  interface OpField { type?: string; purpose?: string; value?: string; totp?: string }
  const list = cachedList(async () => {
    const items = JSON.parse(await run(bin, ['item', 'list', '--categories', 'Login', '--format', 'json'])) as OpItem[];
    return items.map((i) => ({
      source: '1password',
      ref: i.id,
      title: i.title,
      username: i.additional_information || '',
      where: `1Password vault ${i.vault.name}`,
      hosts: (i.urls || []).map((u) => hostOf(u.href)).filter(Boolean),
      async reveal() {
        const raw = await run(bin, ['item', 'get', i.id, '--vault', i.vault.id, '--reveal', '--format', 'json']);
        const fields = (JSON.parse(raw) as { fields?: OpField[] }).fields || [];
        return {
          username: fields.find((f) => f.purpose === 'USERNAME')?.value || '',
          password: fields.find((f) => f.purpose === 'PASSWORD')?.value || '',
          totp: fields.find((f) => f.type === 'OTP')?.totp || '',
        };
      },
    }));
  });
  return { kind: '1password', accounts: (_url, fresh) => list(fresh) };
}

function bitwarden(bin: string): CliSource {
  interface BwItem { id: string; name: string; type: number; login?: { username?: string; password?: string; totp?: string; uris?: { uri?: string }[] } }
  const list = cachedList(async () => {
    // bw list returns passwords too: keep only the metadata, so the cache holds no secret.
    const items = JSON.parse(await run(bin, ['list', 'items'])) as BwItem[];
    return items.filter((i) => i.type === 1 && i.login).map(({ id, name, login }) => ({
      source: 'bitwarden',
      ref: id,
      title: name,
      username: login!.username || '',
      where: 'Bitwarden',
      hosts: (login!.uris || []).map((u) => hostOf(u.uri || '')).filter(Boolean),
      async reveal() {
        const item = JSON.parse(await run(bin, ['get', 'item', id])) as BwItem;
        return {
          username: item.login?.username || '',
          password: item.login?.password || '',
          totp: item.login?.totp ? (await run(bin, ['get', 'totp', id])).trim() : '',
        };
      },
    }));
  });
  return { kind: 'bitwarden', accounts: (_url, fresh) => list(fresh) };
}

/** Any program: called with the page URL, prints [{ url, username, password, totp?, title? }] (or one object). */
function command(bin: string): CliSource {
  interface Out { url?: string; username?: string; password?: string; totp?: string; title?: string }
  return {
    kind: 'command',
    async accounts(pageUrl) {
      const parsed = JSON.parse((await run(bin, [pageUrl])).trim() || '[]') as Out | Out[];
      return (Array.isArray(parsed) ? parsed : [parsed]).map((o) => {
        const creds = { username: o.username || '', password: o.password || '', totp: o.totp || '' };
        return {
          source: 'command',
          ref: o.title || creds.username,
          title: o.title || creds.username,
          username: creds.username,
          where: bin,
          hosts: o.url ? [hostOf(o.url)].filter(Boolean) : [],
          reveal: async () => creds,
        };
      });
    },
  };
}

/** Parses FLINTRAIL_PASSWORDS entries: browser, 1password[:bin], bitwarden[:bin], command:bin. */
export function parseSources(entries: string[]): SourceSpec[] {
  return entries.map((entry) => {
    const i = entry.indexOf(':');
    const kind = (i < 0 ? entry : entry.slice(0, i)).toLowerCase();
    const bin = i < 0 ? '' : entry.slice(i + 1);
    if (kind === 'browser') return { kind: 'browser' };
    if (kind === '1password') return onePassword(bin || 'op');
    if (kind === 'bitwarden') return bitwarden(bin || 'bw');
    if (kind === 'command' && bin) return command(bin);
    throw new Error(`FLINTRAIL_PASSWORDS: unknown source "${entry}" (use browser, 1password[:path], bitwarden[:path] or command:path).`);
  });
}
