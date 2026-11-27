// rocketwright --separate-profile <brand> <profile name>: moves a copy of one browser profile into a browser instance of
// its own (its own data folder, so its own process). Chromium shows its "is debugging this browser" bar in every
// window of the process, every profile included: in its own instance, a profile Rocketwright drives keeps that bar to
// its own windows. Nothing is deleted: the original profile is renamed "<name> (old)" and stays until the user
// removes it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { installNativeHost } from './pairing.js';
import { extensionIds, localProfiles, separateInstancesDir } from './profiles.js';
import { slug } from './relay-protocol.js';

/** Folders a browser rebuilds by itself: left out of the copy. */
const CACHES = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache'];

/**
 * Whether a browser has this data folder open: Chromium holds a SingletonLock link to "<host>-<pid>" in it while it
 * runs. A link left by a browser that crashed or was killed points to a process that is gone.
 */
function inUse(dataDir: string): boolean {
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

export function separateProfile(brand: string, name: string, o: { launcher?: boolean } = {}): string[] {
  if (platform() !== 'darwin') throw new Error('Separate browser instances are made on macOS only.');
  const all = localProfiles();
  const matches = all.filter((p) => !p.separate && p.brand === brand && slug(p.name) === slug(name));
  if (!matches.length) throw new Error(`No ${brand} profile called "${name}". Profiles: ${all.filter((p) => p.brand === brand).map((p) => `"${p.name}"`).join(', ') || 'none'}.`);
  if (matches.length > 1) throw new Error(`Several ${brand} profiles are called "${name}": rename one in the browser first.`);
  const src = matches[0]!;
  if (!src.app) throw new Error(`Rocketwright cannot open ${brand} by itself, so it cannot make a separate instance of it.`);
  if (inUse(src.dataDir)) throw new Error(`${src.app} is open: quit it completely (Cmd+Q), then run this again. Its profile files cannot be copied while it writes them.`);
  const target = join(separateInstancesDir(), brand, src.name.replace(/[/\\:]/g, '-'));
  if (existsSync(target)) throw new Error(`${target} already exists: Rocketwright never writes over a separate instance.`);
  const said: string[] = [];

  // The profile, without the caches the browser rebuilds.
  mkdirSync(target, { recursive: true });
  execFileSync('rsync', ['-a', ...CACHES.map((c) => `--exclude=/${c}`), `${join(src.dataDir, src.dir)}/`, `${join(target, 'Default')}/`]);
  // The Rocketwright extension's own storage (its instance id, its pairing) is not copied: the copy pairs as a new
  // browser, and the relay never takes one for the other.
  for (const id of extensionIds()) {
    for (const store of ['Local Extension Settings', 'Sync Extension Settings']) rmSync(join(target, 'Default', store, id), { recursive: true, force: true });
  }
  said.push(`Copied ${brand} profile "${src.name}" to ${target}.`);

  // Its Local State: the browser's own settings, with this one profile in it.
  const stateFile = join(src.dataDir, 'Local State');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const info = state.profile.info_cache[src.dir];
  const own = structuredClone(state);
  own.profile.info_cache = { Default: { ...info, name: src.name } };
  own.profile.last_used = 'Default';
  own.profile.last_active_profiles = ['Default'];
  own.profile.profiles_order = ['Default'];
  writeFileSync(join(target, 'Local State'), JSON.stringify(own));

  // The original stays, renamed, so the two are never mistaken for one another. Local State is backed up first.
  const backup = `${stateFile}.rocketwright-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(stateFile, backup);
  state.profile.info_cache[src.dir].name = `${src.name} (old)`;
  writeFileSync(stateFile, JSON.stringify(state));
  said.push(`The original profile is renamed "${src.name} (old)" and kept: delete it in ${src.app} once the new one works. Local State backed up to ${backup}.`);

  // The extension of the new instance pairs with Rocketwright by itself.
  installNativeHost();

  if (o.launcher !== false) {
    const appsDir = join(homedir(), 'Applications');
    const app = join(appsDir, `${src.app.replace(/ Browser$/, '')} ${src.name.replace(/[/\\:]/g, '-')}.app`);
    if (existsSync(app)) said.push(`${app} already exists: left as it is.`);
    else {
      mkdirSync(appsDir, { recursive: true });
      const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const command = `open -na ${JSON.stringify(src.app)} --args --user-data-dir=${JSON.stringify(target)} --profile-directory=Default`;
      execFileSync('osacompile', ['-o', app, '-e', `do shell script "${q(command)}"`]);
      said.push(`Launcher: ${app} (drag it to the Dock).`);
    }
  }
  said.push(`Open it from the launcher. In it, the Rocketwright extension pairs by itself: its settings start fresh (sites, confirmations, vaults), set them again there. Extensions that need signing in (1Password) may ask once.`);
  return said;
}
