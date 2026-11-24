// The user's browsers and profiles on this computer: "Brave, profile Soflution", "Brave, profile Antoine".
// An extension cannot read the name of the profile it runs in, so the relay works it out from two local
// files of each Chromium browser, read only:
//  - Local State, which maps each profile folder (Default, Profile 1 ...) to the name the user gave it;
//  - the extension's own storage in each profile, where it keeps its instance id (sent in every hello).
// The same list lets Flintrail open a browser profile that is not running yet.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { slug } from './relay-protocol.js';

/** ID fixed by the "key" in extension/manifest.json (unpacked and packed builds). */
export const EXTENSION_ID = 'hgkglidmccenjlhdcplcpkgbadonplnb';

/** ID of the Chrome Web Store listing: the store signs the extension with its own key. */
export const STORE_EXTENSION_ID = 'amgonogobcfmneginonbkfjlbbnecchp';

export function extensionIds(): string[] {
  const extra = (process.env.FLINTRAIL_EXTENSION_IDS || '').split(',').map((s) => s.trim()).filter((s) => /^[a-p]{32}$/.test(s));
  return [...new Set([EXTENSION_ID, STORE_EXTENSION_ID, ...extra])];
}

/** One Chromium browser installed for this user. */
export interface KnownBrowser {
  /** Brand key, as in browser names: brave, chrome, edge, chromium ... */
  brand: string;
  /** User data directory (holds Local State and one folder per profile). */
  dataDir: string;
  /** macOS application that opens it, null when Flintrail cannot open a given profile of it. */
  app: string | null;
  /** A browser instance of its own (its own data folder, its own process): opened with --user-data-dir. */
  separate?: boolean;
}

/** One profile of one browser. */
export interface LocalProfile {
  brand: string;
  dataDir: string;
  app: string | null;
  /** Profile folder: Default, Profile 1 ... */
  dir: string;
  /** Name the user gave the profile, e.g. "Soflution". */
  name: string;
  /** In a browser instance of its own (see separateInstancesDir). */
  separate?: boolean;
}

/**
 * Where the user keeps browser instances of their own, one folder each: <brand>/<name>, e.g. brave/Soflution.
 * Chromium shows its "is debugging this browser" bar in every window of the process, every profile included: a
 * profile in its own instance keeps that bar to its own windows.
 */
export function separateInstancesDir(): string {
  return process.env.FLINTRAIL_INSTANCES_DIR || join(homedir(), 'Library/Application Support/Flintrail/Browsers');
}

/** The separate instances of the brands that have an app: one data folder each. */
function separateInstances(apps: Map<string, string | null>): KnownBrowser[] {
  const out: KnownBrowser[] = [];
  for (const [brand, app] of apps) {
    if (!app) continue;
    let names: string[];
    try { names = readdirSync(join(separateInstancesDir(), brand)); } catch { continue; }
    for (const n of names) {
      const dataDir = join(separateInstancesDir(), brand, n);
      if (existsSync(join(dataDir, 'Local State'))) out.push({ brand, dataDir, app, separate: true });
    }
  }
  return out;
}

/** The Chromium browsers Flintrail knows, per platform (FLINTRAIL_PAIRING_DIRS replaces the list). */
export function knownBrowsers(): KnownBrowser[] {
  const override = process.env.FLINTRAIL_PAIRING_DIRS;
  if (override) return override.split(',').map((d) => d.trim()).filter(Boolean).map((dataDir) => ({ brand: 'chromium', dataDir, app: null }));
  const home = homedir();
  if (platform() === 'darwin') {
    const support = join(home, 'Library/Application Support');
    const mac = [
      ['chrome', 'Google/Chrome', 'Google Chrome'],
      ['chrome', 'Google/Chrome Beta', 'Google Chrome Beta'],
      ['chrome', 'Google/Chrome Canary', 'Google Chrome Canary'],
      ['chrome', 'Google/Chrome for Testing', 'Google Chrome for Testing'],
      ['chromium', 'Chromium', 'Chromium'],
      ['brave', 'BraveSoftware/Brave-Browser', 'Brave Browser'],
      ['brave', 'BraveSoftware/Brave-Browser-Beta', 'Brave Browser Beta'],
      ['edge', 'Microsoft Edge', 'Microsoft Edge'],
      // Arc keeps its own spaces and ignores --profile-directory: listed, never opened by profile.
      ['arc', 'Arc/User Data', null],
      ['vivaldi', 'Vivaldi', 'Vivaldi'],
      ['opera', 'com.operasoftware.Opera', 'Opera'],
    ] as const;
    const main: KnownBrowser[] = mac.map(([brand, dir, app]) => ({ brand, dataDir: join(support, dir), app }));
    // The first app of each brand opens its separate instances.
    const apps = new Map<string, string | null>();
    for (const [brand, , app] of mac) if (!apps.has(brand)) apps.set(brand, app);
    return [...main, ...separateInstances(apps)];
  }
  if (platform() === 'linux') {
    const cfg = process.env.XDG_CONFIG_HOME || join(home, '.config');
    return ([
      ['chrome', 'google-chrome'], ['chrome', 'google-chrome-beta'], ['chromium', 'chromium'], ['brave', 'BraveSoftware/Brave-Browser'],
      ['edge', 'microsoft-edge'], ['vivaldi', 'vivaldi'], ['opera', 'opera'],
    ] as const).map(([brand, dir]) => ({ brand, dataDir: join(cfg, dir), app: null }));
  }
  return [];
}

/** Browsers whose profile list this process may not read (a sandbox, macOS privacy settings), with why. */
const unreadable = new Map<string, string>();
export function profileReadProblems(): string[] {
  return [...unreadable].map(([dir, code]) => `${dir} (${code})`);
}

/** Every profile of every installed browser, with the name the user gave it. */
export function localProfiles(): LocalProfile[] {
  const out: LocalProfile[] = [];
  for (const b of knownBrowsers()) {
    let state: any;
    try {
      state = JSON.parse(readFileSync(join(b.dataDir, 'Local State'), 'utf8'));
      unreadable.delete(b.dataDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') unreadable.set(b.dataDir, code);
      continue;
    }
    const cache = state?.profile?.info_cache;
    if (!cache || typeof cache !== 'object') continue;
    for (const [dir, info] of Object.entries(cache as Record<string, { name?: string }>)) {
      if (!existsSync(join(b.dataDir, dir))) continue;
      out.push({ brand: b.brand, dataDir: b.dataDir, app: b.app, dir, name: String(info?.name || dir), ...(b.separate ? { separate: true } : {}) });
    }
  }
  return out;
}

/** The profile whose Flintrail extension stored this instance id, if it can be found. */
export function profileOfInstance(instance: string, profiles = localProfiles()): LocalProfile | undefined {
  if (!/^[0-9a-f-]{16,}$/i.test(instance)) return undefined;
  const needle = Buffer.from(instance);
  for (const p of profiles) {
    for (const id of extensionIds()) {
      const store = join(p.dataDir, p.dir, 'Local Extension Settings', id);
      let files: string[];
      try { files = readdirSync(store).filter((f) => /\.(log|ldb)$/.test(f)); } catch { continue; }
      for (const f of files) {
        const file = join(store, f);
        try {
          if (statSync(file).size > 8 * 1024 * 1024) continue;
          // LevelDB keeps short values verbatim, in its log and (as a literal run) in its tables.
          if (readFileSync(file).includes(needle)) return p;
        } catch { /* being rewritten by the browser: try the next file */ }
      }
    }
  }
  return undefined;
}

/**
 * Profiles matching what the agent asked for: the profile name ("Soflution"), or brand and name
 * ("brave-soflution", "Brave Soflution").
 */
export function matchProfiles(wanted: string, profiles = localProfiles()): LocalProfile[] {
  const w = slug(wanted);
  return profiles.filter((p) => slug(p.name) === w || `${p.brand}-${slug(p.name)}` === w);
}

/** The command that opens a window of this profile (macOS), or null if Flintrail cannot open it. */
export function openCommand(p: LocalProfile): [string, string[]] | null {
  if (!p.app || platform() !== 'darwin') return null;
  // A separate instance: its own data folder, so its own process (an instance already open takes the window).
  if (p.separate) return ['open', ['-na', p.app, '--args', `--user-data-dir=${p.dataDir}`, `--profile-directory=${p.dir}`]];
  return ['open', ['-na', p.app, '--args', `--profile-directory=${p.dir}`]];
}

/** Opens a window of this profile: the browser starts if needed, its Flintrail extension then connects. */
export function openProfile(p: LocalProfile): void {
  const cmd = openCommand(p);
  if (!cmd) throw new Error(`Flintrail cannot open ${p.brand} profile "${p.name}" by itself on this system: open it, the extension then connects.`);
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => console.error(`flintrail: could not open ${p.brand} profile "${p.name}": ${e.message}`));
  child.unref();
}
