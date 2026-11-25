// Password sources fl_login can read from, besides the browser's own password manager: the command-line tools of
// 1Password, Bitwarden, Dashlane, LastPass, Proton Pass and KeePassXC, or any command that prints the matching logins
// as JSON.
import { execFile } from 'node:child_process';
import { getDomain } from 'tldts';

export interface Credentials { username: string; password: string; totp: string }

/** Payment and bank items are never filled, whatever the page asks: only plain logins. */
export function assertLoginItem(source: string, title: string, category: string | undefined) {
  if (category && !/^login$/i.test(category)) {
    throw new Error(`Refused: ${source} item "${title}" is a ${category.toLowerCase().replace(/_/g, ' ')}. Flintrail only fills logins, never payment cards or bank details.`);
  }
}

/** A login found in a source. Holds no secret: reveal() fetches it at fill time. */
export interface Account {
  source: string;
  ref: string;
  title: string;
  username: string;
  where: string;
  /** The password manager vault holding it (1Password), for the user's vault rules. */
  vault?: string;
  hosts: string[];
  reveal(): Promise<Credentials>;
}

export interface CliSource {
  kind: '1password' | 'bitwarden' | 'dashlane' | 'lastpass' | 'protonpass' | 'keepassxc' | 'command';
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

/** Development addresses of this computer: localhost, 127.x.x.x, [::1], *.localhost and *.test (reserved, never on the Internet). */
export const isLocalHost = (host: string) =>
  /^(localhost|127(\.\d+){3}|\[::1\])$/.test(host) || host.endsWith('.localhost') || host.endsWith('.test');

/**
 * Host of an address saved in a login. On a local development address an explicit port is kept: the login then
 * only fits that one app ("localhost:5191"), not every app the computer serves. Without a port, every port fits.
 */
export const savedHostOf = (url: string) => {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    const host = u.hostname.toLowerCase();
    return u.port && isLocalHost(host) ? `${host}:${u.port}` : host;
  } catch {
    return '';
  }
};

function run(bin: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin}: ${(stderr || err.message).trim().split('\n')[0]}`));
      else resolve(stdout);
    });
    // A database password goes on standard input only, never in the arguments (ps shows those).
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** The site of a page, for tools that search by text: example.com for app.example.com. */
const siteOfUrl = (url: string) => { const host = hostOf(url); return getDomain(host) || host; };

/** The first one-time code in a tool's output ("123456 (expires in 12s)"). */
function codeIn(text: string, bin: string): string {
  const code = /\b(\d{6,8})\b/.exec(text)?.[1];
  if (!code) throw new Error(`${bin}: no one-time code in its answer.`);
  return code;
}

/** Parses a CLI's JSON output. Its own error would quote the output, which can hold a password. */
function parseJson<T>(text: string, bin: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${bin}: unreadable output (not the JSON Flintrail expects).`);
  }
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
  interface OpItem { id: string; title: string; category?: string; vault: { id: string; name: string }; urls?: { href: string }[]; additional_information?: string }
  interface OpField { type?: string; purpose?: string; value?: string; totp?: string }
  const list = cachedList(async () => {
    const items = parseJson<OpItem[]>(await run(bin, ['item', 'list', '--categories', 'Login', '--format', 'json']), bin);
    return items.filter((i) => !i.category || /^login$/i.test(i.category)).map((i) => ({
      source: '1password',
      ref: i.id,
      title: i.title,
      username: i.additional_information || '',
      where: `1Password vault ${i.vault.name}`,
      vault: i.vault.name,
      hosts: (i.urls || []).map((u) => savedHostOf(u.href)).filter(Boolean),
      async reveal() {
        const raw = await run(bin, ['item', 'get', i.id, '--vault', i.vault.id, '--reveal', '--format', 'json']);
        const item = parseJson<{ category?: string; fields?: OpField[] }>(raw, bin);
        assertLoginItem('1Password', i.title, item.category);
        const fields = item.fields || [];
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
    const items = parseJson<BwItem[]>(await run(bin, ['list', 'items']), bin);
    return items.filter((i) => i.type === 1 && i.login).map(({ id, name, login }) => ({
      source: 'bitwarden',
      ref: id,
      title: name,
      username: login!.username || '',
      where: 'Bitwarden',
      hosts: (login!.uris || []).map((u) => savedHostOf(u.uri || '')).filter(Boolean),
      async reveal() {
        const item = parseJson<BwItem>(await run(bin, ['get', 'item', id]), bin);
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

/** Dashlane CLI (dcli): logins whose website or title matches the page's site, as JSON; the code with -f otp. */
function dashlane(bin: string): CliSource {
  interface DlCredential { id: string; title?: string; email?: string; login?: string; password?: string; url?: string; otpSecret?: string; otpUrl?: string }
  return {
    kind: 'dashlane',
    async accounts(pageUrl) {
      const site = siteOfUrl(pageUrl);
      if (!site) return [];
      // The answer holds the passwords: only the metadata is kept, reveal() asks again for the one login used.
      const items = parseJson<DlCredential[]>((await run(bin, ['password', site, '-o', 'json'])).trim() || '[]', bin);
      return items.map((c) => ({
        source: 'dashlane',
        ref: c.id,
        title: c.title || c.url || c.id,
        username: c.login || c.email || '',
        where: 'Dashlane',
        hosts: c.url ? [savedHostOf(c.url)].filter(Boolean) : [],
        async reveal() {
          const [item] = parseJson<DlCredential[]>(await run(bin, ['password', `id=${c.id}`, '-o', 'json']), bin);
          if (!item) throw new Error(`Dashlane: login ${c.id} not found any more.`);
          return {
            username: item.login || item.email || '',
            password: item.password || '',
            totp: item.otpSecret || item.otpUrl ? codeIn(await run(bin, ['password', `id=${c.id}`, '-f', 'otp', '-o', 'console']), bin) : '',
          };
        },
      }));
    },
  };
}

/** LastPass CLI (lpass): every site entry as JSON (lpass gives no one-time codes). */
function lastpass(bin: string): CliSource {
  interface LpEntry { id: string; name?: string; fullname?: string; username?: string; password?: string; url?: string }
  const list = cachedList(async () => {
    // The answer holds the passwords: only the metadata is kept, reveal() asks again for the one login used.
    const items = parseJson<LpEntry[]>(await run(bin, ['show', '--sync=auto', '--json', '--expand-multi', '--basic-regexp', '.*']), bin);
    // Secure notes carry the placeholder address http://sn.
    return items.filter((e) => e.url && e.url !== 'http://sn').map((e) => ({
      source: 'lastpass',
      ref: e.id,
      title: e.fullname || e.name || e.id,
      username: e.username || '',
      where: 'LastPass',
      hosts: [savedHostOf(e.url!)].filter(Boolean),
      async reveal() {
        const [item] = parseJson<LpEntry[]>(await run(bin, ['show', '--sync=no', '--json', e.id]), bin);
        if (!item) throw new Error(`LastPass: entry ${e.id} not found any more.`);
        return { username: item.username || '', password: item.password || '', totp: '' };
      },
    }));
  });
  return { kind: 'lastpass', accounts: (_url, fresh) => list(fresh) };
}

/** Proton Pass CLI (pass-cli): the logins of every vault; secrets read field by field through pass:// references. */
function protonPass(bin: string): CliSource {
  interface Vault { share_id?: string }
  interface Item { id?: string; share_id?: string; title?: string; state?: unknown }
  // Login fields sit at a depth that varies with the item kind: found by name, the password never collected.
  const details = (node: unknown) => {
    const out = { username: '', email: '', urls: [] as string[], totp: false };
    const visit = (n: unknown, depth: number) => {
      if (depth > 8 || n === null || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const c of n) visit(c, depth + 1); return; }
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (k === 'password') continue;
        if (k === 'urls' && Array.isArray(v)) out.urls.push(...v.filter((u): u is string => typeof u === 'string'));
        else if (k === 'username' && typeof v === 'string' && v) out.username ||= v;
        else if (k === 'email' && typeof v === 'string' && v) out.email ||= v;
        else if ((k === 'totp_uri' || k === 'totp') && typeof v === 'string' && v) out.totp = true;
        else visit(v, depth + 1);
      }
    };
    visit(node, 0);
    return out;
  };
  const list = cachedList(async () => {
    const vaults = parseJson<Vault[] | { vaults?: Vault[] }>(await run(bin, ['vault', 'list', '--output', 'json']), bin);
    const shares = (Array.isArray(vaults) ? vaults : vaults.vaults || []).map((v) => v.share_id).filter((x): x is string => !!x);
    const accounts: Account[] = [];
    for (const share of shares) {
      const page = parseJson<{ items?: Item[] }>(await run(bin, ['item', 'list', '--share-id', share, '--filter-type', 'login', '--filter-state', 'active', '--output', 'json']), bin);
      for (const it of page.items || []) {
        if (!it.id) continue;
        const ref = `pass://${it.share_id || share}/${it.id}`;
        const d = details(parseJson<unknown>(await run(bin, ['item', 'view', ref, '--output', 'json']), bin));
        accounts.push({
          source: 'protonpass',
          ref,
          title: it.title || it.id,
          username: d.username || d.email,
          where: 'Proton Pass',
          hosts: d.urls.map(savedHostOf).filter(Boolean),
          async reveal() {
            return {
              username: d.username || d.email,
              password: (await run(bin, ['item', 'view', `${ref}/password`])).replace(/\r?\n$/, ''),
              totp: d.totp ? codeIn(await run(bin, ['item', 'view', `${ref}/totp`]), bin) : '',
            };
          },
        });
      }
    }
    return accounts;
  });
  return { kind: 'protonpass', accounts: (_url, fresh) => list(fresh) };
}

/**
 * KeePassXC CLI (keepassxc-cli) on one database. It is unlocked with FLINTRAIL_KEEPASSXC_KEYFILE, or with the password
 * printed by FLINTRAIL_KEEPASSXC_PASSWORD_COMMAND (e.g. a macOS Keychain lookup), passed on standard input only.
 */
function keepassxc(bin: string, db: string): CliSource {
  if (!db) throw new Error('FLINTRAIL_PASSWORDS: keepassxc needs the database, e.g. keepassxc:/Users/me/Passwords.kdbx.');
  const keyfile = process.env.FLINTRAIL_KEEPASSXC_KEYFILE || '';
  const passwordCommand = process.env.FLINTRAIL_KEEPASSXC_PASSWORD_COMMAND || '';
  if (!keyfile && !passwordCommand) {
    throw new Error('KeePassXC: set FLINTRAIL_KEEPASSXC_KEYFILE or FLINTRAIL_KEEPASSXC_PASSWORD_COMMAND to unlock the database (never its password in clear).');
  }
  const unlock = async (): Promise<{ args: string[]; input?: string }> => {
    if (!passwordCommand) return { args: ['--no-password', '--key-file', keyfile] };
    const [cmd, ...cmdArgs] = passwordCommand.split(' ').filter(Boolean);
    const password = (await run(cmd!, cmdArgs)).replace(/\r?\n$/, '');
    return { args: keyfile ? ['--key-file', keyfile] : [], input: `${password}\n` };
  };
  // keepassxc-cli <command> [options] <database> <entry or term>: every option before the database.
  const kp = async (command: string, options: string[], target: string) => {
    const u = await unlock();
    return run(bin, [command, '--quiet', ...u.args, ...options, db, target], u.input);
  };
  return {
    kind: 'keepassxc',
    async accounts(pageUrl) {
      const site = siteOfUrl(pageUrl);
      if (!site) return [];
      const paths = (await kp('search', [], site).catch((e: Error) => { if (/No results/i.test(e.message)) return ''; throw e; }))
        .split('\n').map((l) => l.trim()).filter(Boolean);
      const accounts: Account[] = [];
      for (const path of paths) {
        const [title = '', username = '', url = ''] = (await kp('show', ['-a', 'Title', '-a', 'UserName', '-a', 'URL'], path)).split('\n');
        accounts.push({
          source: 'keepassxc',
          ref: path,
          title: title || path,
          username,
          where: `KeePassXC ${db}`,
          hosts: [savedHostOf(url)].filter(Boolean),
          async reveal() {
            const password = (await kp('show', ['--show-protected', '-a', 'Password'], path)).replace(/\r?\n$/, '');
            // An entry without a TOTP makes --totp fail: then there is no code to fill.
            const totp = await kp('show', ['--totp', '-a', 'Title'], path).then((o) => codeIn(o.split('\n').slice(1).join('\n'), bin), () => '');
            return { username, password, totp };
          },
        });
      }
      return accounts;
    },
  };
}

/** Any program: called with the page URL, prints [{ url, username, password, totp?, title? }] (or one object). */
function command(bin: string): CliSource {
  interface Out { url?: string; username?: string; password?: string; totp?: string; title?: string }
  return {
    kind: 'command',
    async accounts(pageUrl) {
      const parsed = parseJson<Out | Out[]>((await run(bin, [pageUrl])).trim() || '[]', bin);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((o) => {
        const creds = { username: o.username || '', password: o.password || '', totp: o.totp || '' };
        return {
          source: 'command',
          ref: o.title || creds.username,
          title: o.title || creds.username,
          username: creds.username,
          where: bin,
          hosts: o.url ? [savedHostOf(o.url)].filter(Boolean) : [],
          reveal: async () => creds,
        };
      });
    },
  };
}

/** Parses FLINTRAIL_PASSWORDS entries: browser, 1password[:bin], bitwarden[:bin], dashlane[:bin], lastpass[:bin], protonpass[:bin], keepassxc:database, command:bin. */
export function parseSources(entries: string[]): SourceSpec[] {
  return entries.map((entry) => {
    const i = entry.indexOf(':');
    const kind = (i < 0 ? entry : entry.slice(0, i)).toLowerCase();
    const bin = i < 0 ? '' : entry.slice(i + 1);
    if (kind === 'browser') return { kind: 'browser' };
    if (kind === '1password') return onePassword(bin || 'op');
    if (kind === 'bitwarden') return bitwarden(bin || 'bw');
    if (kind === 'dashlane') return dashlane(bin || 'dcli');
    if (kind === 'lastpass') return lastpass(bin || 'lpass');
    if (kind === 'protonpass') return protonPass(bin || 'pass-cli');
    if (kind === 'keepassxc') return keepassxc(process.env.FLINTRAIL_KEEPASSXC_CLI || 'keepassxc-cli', bin);
    if (kind === 'command' && bin) return command(bin);
    throw new Error(`FLINTRAIL_PASSWORDS: unknown source "${entry}" (use browser, 1password[:path], bitwarden[:path], dashlane[:path], lastpass[:path], protonpass[:path], keepassxc:database or command:path).`);
  });
}
