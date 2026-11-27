// The user's browsers and profiles on this computer: "Brave, profile Soflution", "Brave, profile Antoine".
// An extension cannot read the name of the profile it runs in, so the relay works it out from two local
// files of each Chromium browser, read only:
//  - Local State, which maps each profile folder (Default, Profile 1 ...) to the name the user gave it;
//  - the extension's own storage in each profile, where it keeps its instance id (sent in every hello).
// The same list lets Rocketwright open a browser profile that is not running yet.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug } from './relay-protocol.js';

/** ID fixed by the "key" in extension/manifest.json (unpacked and packed builds). */
export const EXTENSION_ID = 'hgkglidmccenjlhdcplcpkgbadonplnb';

/** ID of the Chrome Web Store listing: the store signs the extension with its own key. */
export const STORE_EXTENSION_ID = 'amgonogobcfmneginonbkfjlbbnecchp';

/** The Rocketwright extension in the Chrome Web Store: what the agent hands the user to connect their own browser. */
export const EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/rocketwright/${STORE_EXTENSION_ID}`;

/** The extension folder of this installation (next to dist/): what "Load unpacked" and --load-extension point to. */
export function extensionDir(): string {
  return fileURLToPath(new URL('../extension', import.meta.url));
}

export function extensionIds(): string[] {
  const extra = (process.env.ROCKETWRIGHT_EXTENSION_IDS || '').split(',').map((s) => s.trim()).filter((s) => /^[a-p]{32}$/.test(s));
  return [...new Set([EXTENSION_ID, STORE_EXTENSION_ID, ...extra])];
}

/** One Chromium browser installed for this user. */
export interface KnownBrowser {
  /** Brand key, as in browser names: brave, chrome, edge, chromium ... */
  brand: string;
  /** User data directory (holds Local State and one folder per profile). */
  dataDir: string;
  /** macOS application that opens it, null when Rocketwright cannot open a given profile of it. */
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
  /** The browser's own default name ("Person 1", "Votre Chromium"): it says nothing, so it never names a browser. */
  defaultName?: boolean;
}

/** The name a profile gives its browser: the one the user chose, never the browser's default. */
export function chosenName(p: LocalProfile | undefined): string {
  return p && !p.defaultName ? p.name : '';
}

/**
 * Where the user keeps browser instances of their own, one folder each: <brand>/<name>, e.g. brave/Soflution.
 * Chromium shows its "is debugging this browser" bar in every window of the process, every profile included: a
 * profile in its own instance keeps that bar to its own windows.
 */
export function separateInstancesDir(): string {
  return process.env.ROCKETWRIGHT_INSTANCES_DIR || join(homedir(), 'Library/Application Support/Rocketwright/Browsers');
}

/**
 * Where separate instances are looked for: the folder above, then the one Flintrail (1.x) made them in before the
 * rename, still in use by the browsers it holds (each instance's launcher points there). Nothing is moved.
 */
export function separateInstancesDirs(): string[] {
  if (process.env.ROCKETWRIGHT_INSTANCES_DIR) return [process.env.ROCKETWRIGHT_INSTANCES_DIR];
  return [separateInstancesDir(), join(homedir(), 'Library/Application Support/Flintrail/Browsers')];
}

/** The separate instances of the brands that have an app: one data folder each, the first found for a name. */
function separateInstances(apps: Map<string, string | null>): KnownBrowser[] {
  const out: KnownBrowser[] = [];
  const seen = new Set<string>();
  for (const root of separateInstancesDirs()) {
    for (const [brand, app] of apps) {
      if (!app) continue;
      let names: string[];
      try { names = readdirSync(join(root, brand)); } catch { continue; }
      for (const n of names) {
        const dataDir = join(root, brand, n);
        if (seen.has(`${brand}/${n}`) || !existsSync(join(dataDir, 'Local State'))) continue;
        seen.add(`${brand}/${n}`);
        out.push({ brand, dataDir, app, separate: true });
      }
    }
  }
  return out;
}

/** The Chromium browsers Rocketwright knows, per platform (ROCKETWRIGHT_PAIRING_DIRS replaces the list). */
export function knownBrowsers(): KnownBrowser[] {
  const override = process.env.ROCKETWRIGHT_PAIRING_DIRS;
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
    for (const [dir, info] of Object.entries(cache as Record<string, { name?: string; is_using_default_name?: boolean }>)) {
      if (!existsSync(join(b.dataDir, dir))) continue;
      out.push({ brand: b.brand, dataDir: b.dataDir, app: b.app, dir, name: String(info?.name || dir), ...(b.separate ? { separate: true } : {}), ...(info?.is_using_default_name ? { defaultName: true } : {}) });
    }
  }
  return out;
}

/** The profile whose Rocketwright extension stored this instance id, if it can be found. */
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

/**
 * Whether a browser has this data folder open: Chromium holds a SingletonLock link to "<host>-<pid>" in it while it
 * runs. A link left by a browser that crashed or was killed points to a process that is gone.
 */
export function dataDirInUse(dataDir: string): boolean {
  let target: string;
  try { target = readlinkSync(join(dataDir, 'SingletonLock')); } catch { return false; }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether this profile seems to have a window open: its browser runs and lists it among the profiles of the session
 * (a hint for what to tell the user: the list is saved by the browser from time to time).
 */
export function profileOpen(p: LocalProfile): boolean {
  if (!dataDirInUse(p.dataDir)) return false;
  if (p.separate) return true;
  try {
    const active = JSON.parse(readFileSync(join(p.dataDir, 'Local State'), 'utf8'))?.profile?.last_active_profiles;
    return Array.isArray(active) && active.includes(p.dir);
  } catch {
    return false;
  }
}

/** The Rocketwright extension in one profile, as the browser's own preferences describe it. */
export interface ExtensionInstall {
  status: 'ok' | 'disabled' | 'moved' | 'missing' | 'unknown';
  /** ok: installed from the Chrome Web Store (signed by the store), not loaded unpacked. */
  store?: boolean;
  /** moved: the folder it was loaded unpacked from, which no longer holds it. */
  path?: string;
}

/**
 * Reads the profile's Preferences and Secure Preferences (read only): is the extension installed, turned off, or
 * loaded unpacked from a folder that is gone (a repository renamed or moved)?
 */
export function extensionInstall(p: LocalProfile): ExtensionInstall {
  const settings: Record<string, { location?: number; path?: string; state?: number; disable_reasons?: number | number[] }> = {};
  let read = false;
  for (const file of ['Preferences', 'Secure Preferences']) {
    try {
      const prefs = JSON.parse(readFileSync(join(p.dataDir, p.dir, file), 'utf8'));
      read = true;
      Object.assign(settings, prefs?.extensions?.settings || {});
    } catch { /* absent or being rewritten: the other file may say it */ }
  }
  if (!read) return { status: 'unknown' };
  const found = extensionIds().filter((id) => settings[id]).map((id) => ({ id, s: settings[id]! }));
  if (!found.length) return { status: 'missing' };
  const off = (s: { state?: number; disable_reasons?: number | number[] }) =>
    (Array.isArray(s.disable_reasons) ? s.disable_reasons.length > 0 : !!s.disable_reasons) || s.state === 0;
  // Location 4: loaded unpacked, from the absolute path the browser keeps.
  const gone = (s: { location?: number; path?: string }) => s.location === 4 && !!s.path && isAbsolute(s.path) && !existsSync(join(s.path, 'manifest.json'));
  const good = found.find(({ s }) => !off(s) && !gone(s));
  if (good) return { status: 'ok', store: good.id === STORE_EXTENSION_ID && good.s.location !== 4 };
  const moved = found.find(({ s }) => gone(s));
  if (moved) return { status: 'moved', path: moved.s.path };
  return { status: 'disabled' };
}

/**
 * The command that opens a window of this profile (macOS), or null if Rocketwright cannot open it. loadExtension:
 * the extension of this installation is loaded too (Chrome 137 and later ignore --load-extension unless the feature
 * that turns it off is disabled), so a profile whose own copy is missing or moved still connects.
 */
export function openCommand(p: LocalProfile, o: { loadExtension?: string } = {}): [string, string[]] | null {
  if (!p.app || platform() !== 'darwin') return null;
  const load = o.loadExtension ? [`--load-extension=${o.loadExtension}`, '--disable-features=DisableLoadExtensionCommandLineSwitch'] : [];
  // A separate instance: its own data folder, so its own process (an instance already open takes the window).
  if (p.separate) return ['open', ['-na', p.app, '--args', `--user-data-dir=${p.dataDir}`, `--profile-directory=${p.dir}`, ...load]];
  return ['open', ['-na', p.app, '--args', `--profile-directory=${p.dir}`, ...load]];
}

/**
 * Opens a window of this profile, only on the agent's explicit request (fl_open launch): the browser starts if needed,
 * with the extension of this installation loaded unless the store's copy is installed and on there.
 */
export function openProfile(p: LocalProfile): void {
  const ext = extensionInstall(p);
  const dir = extensionDir();
  const fromStore = ext.status === 'ok' && !!ext.store;
  if (!fromStore && !existsSync(join(dir, 'manifest.json'))) throw new Error(`The Rocketwright extension folder of this installation is missing (${dir}): reinstall Rocketwright. Nothing was opened.`);
  const cmd = openCommand(p, fromStore ? {} : { loadExtension: dir });
  if (!cmd) throw new Error(`Rocketwright cannot open ${p.brand} profile "${p.name}" by itself on this system: open it, the extension then connects.`);
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => console.error(`rocketwright: could not open ${p.brand} profile "${p.name}": ${e.message}`));
  child.unref();
}
