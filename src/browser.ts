// Browser connections. The dedicated browser ("agent") depends on the mode:
//  - attach (default): connect over CDP to a dedicated Chrome for Testing that keeps your logged-in sessions.
//    On macOS Rocketwright finds it, starts it with a local debugging port, and refuses any other browser.
//  - launch: start its own Chromium with a persistent profile (servers, CI, headless).
//  - extension: no dedicated browser, only the browsers below.
// In every mode, the user's own browsers where the Rocketwright extension is installed are reachable by
// name ("brave", "brave-ideekdo", "chrome"...) through the shared relay daemon, several at once, and from
// several Rocketwright processes (one per conversation) at the same time.
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { loadToken } from './auth.js';
import { dataDirInUse, EXTENSION_STORE_URL, extensionDir, extensionInstall, matchProfiles, openProfile, profileOpen, type LocalProfile } from './profiles.js';
import { getRelayClient, relayClient, type RelayClient } from './relay-client.js';
import { VERSION } from './version.js';
import { startCdpFilter, type CdpFilter } from './cdp-filter.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function chromeForTestingPath(): string | null {
  if (config.chromePath) return config.chromePath;
  if (platform() !== 'darwin') return null;
  const roots = [join(homedir(), 'Applications/ResearchBrowser/chrome'), join(homedir(), '.cache/puppeteer/chrome'), join(homedir(), 'chrome')];
  for (const base of roots) {
    if (!existsSync(base)) continue;
    const versions = readdirSync(base)
      .filter((d) => d.startsWith('mac'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac-x64']) {
        const p = join(base, v, arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
        if (existsSync(p)) return p;
      }
    }
  }
  const app = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  return existsSync(app) ? app : null;
}

async function cdpVersion(): Promise<Record<string, string> | null> {
  try {
    const r = await fetch(`${config.cdpUrl}/json/version`, { signal: AbortSignal.timeout(800) });
    return r.ok ? ((await r.json()) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

/** Safety: only ever drive the dedicated automation browser, never a personal one. */
function assertDedicatedBrowser(version: Record<string, string>) {
  if (config.allowAnyBrowser) return;
  const ua = `${version['Browser'] ?? ''} ${version['User-Agent'] ?? ''}`;
  if (/brave|edg\/|opr\//i.test(ua)) throw new Error('Refusing to attach: the debugging port belongs to a personal browser.');
  if (platform() === 'darwin' && config.cdpUrl.includes('127.0.0.1')) {
    try {
      const pid = execFileSync('lsof', ['-nP', `-iTCP:${config.port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0];
      const cmd = pid ? execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }) : '';
      const ownsDedicatedProfile = !!config.dedicatedProfile && cmd.includes(`--user-data-dir=${config.dedicatedProfile}`);
      if (!cmd.includes('Google Chrome for Testing') && !ownsDedicatedProfile) {
        throw new Error(`Refusing to attach: port ${config.port} is not owned by Chrome for Testing or by ROCKETWRIGHT_DEDICATED_PROFILE (set ROCKETWRIGHT_ALLOW_ANY_BROWSER=1 to override).`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Refusing')) throw e;
    }
  }
}

function cftRunning(): boolean {
  try {
    execFileSync('pgrep', ['-f', 'Contents/MacOS/Google Chrome for Testing$']);
    return true;
  } catch {
    return false;
  }
}

async function startChromeForTesting() {
  const bin = chromeForTestingPath();
  if (!bin) throw new Error('No browser reachable on the debugging port and Chrome for Testing not found (set ROCKETWRIGHT_CHROME or ROCKETWRIGHT_CDP_URL).');
  if (platform() === 'darwin' && cftRunning()) {
    // Already open without a debugging port: restart it gracefully, tabs are restored.
    try {
      execFileSync('osascript', ['-e', 'quit app id "com.google.chrome.for.testing"'], { timeout: 15000 });
    } catch { /* ignore */ }
    for (let i = 0; i < 50 && cftRunning(); i++) await sleep(200);
  }
  const child = spawn(bin, [
    `--remote-debugging-port=${config.port}`,
    '--remote-debugging-address=127.0.0.1',
    '--restore-last-session',
    '--no-first-run',
    '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 75; i++) {
    if (await cdpVersion()) return;
    await sleep(200);
  }
  throw new Error('Chrome for Testing did not open its debugging port in time.');
}

/** A browser Rocketwright drives: the dedicated one ("agent") or a user browser through the extension. */
export interface Driven {
  name: string;
  ctx: BrowserContext;
  /** CDP-attached browser handle, null in launch mode. */
  browser: Browser | null;
  viaExtension: boolean;
}

/** Name of the dedicated automation browser (attach or launch mode). */
export const AGENT = 'agent';

const driven = new Map<string, Promise<Driven>>();
/** Extension connections being opened, by requested name. */
const connecting = new Map<string, Promise<Driven>>();
let filter: CdpFilter | null = null;

async function connectExtension(name: string | undefined, launch: boolean): Promise<Driven> {
  const relay = relayClient(loadToken(), VERSION);
  if (!relay) throw new Error('The extension relay is turned off (ROCKETWRIGHT_RELAY=off).');
  const found = await findOrOpen(relay, name, launch);
  const { key, cdpUrl } = await relay.open(found.key);
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15000 });
  browser.on('disconnected', () => driven.delete(key));
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error(`${key}: the extension exposes no context.`);
  return { name: key, ctx, browser, viaExtension: true };
}

/** Why the extension of this profile is not connected, as far as its browser's files tell, for a person to fix. */
export function whyNotConnected(profile: LocalProfile): string {
  const ext = extensionInstall(profile);
  const page = `${profile.brand}://extensions`;
  const dir = extensionDir();
  switch (ext.status) {
    case 'moved':
      return `its Rocketwright extension was loaded unpacked from ${ext.path}, a folder that no longer holds it (moved or renamed). ` +
        `In ${page}, remove that copy and use "Load unpacked" on ${dir}, or install it from the Chrome Web Store: ${EXTENSION_STORE_URL}`;
    case 'disabled':
      return `its Rocketwright extension is turned off in ${page}: the user turns it back on there.`;
    case 'missing':
      return `the Rocketwright extension is not installed in this profile: the user installs it from ${EXTENSION_STORE_URL} (or "Load unpacked" on ${dir} in ${page}).`;
    case 'unknown':
      return `Rocketwright cannot read this profile's extension settings. Likely causes: the Rocketwright extension is not installed or turned off (${page}), ` +
        `its site access is set to "On click" (Details, Site access: "On all sites"), or it was loaded unpacked from a folder that moved (it must be ${dir}).`;
    case 'ok':
      return `the extension looks installed and on. Likely causes: its site access is set to "On click" (${page}, Details, Site access: "On all sites"), ` +
        `or it is not paired: the user opens its popup, which must show "Connected to Rocketwright" with a green dot (Connect otherwise). ` +
        `If it was loaded unpacked, the folder must be ${dir}.`;
  }
}

/**
 * A connected browser by name. A browser profile of this computer whose extension is not connected is never opened
 * or restarted on Rocketwright's own initiative: the call fails and says why. Only launch (the agent asked, because
 * the user did) opens a profile that is not open, with the extension of this installation loaded.
 */
async function findOrOpen(relay: RelayClient, name: string | undefined, launch: boolean) {
  await relay.ensure();
  const connected = name ? relay.matching(name) : [];
  if (connected.length > 1) throw new Error(`Several browsers answer to "${name}": ${connected.map((b) => b.key).join(', ')}. Use one of these names.`);
  const now = relay.find(name);
  if (now || !name) return now ?? relay.waitFor(name, config.extensionWaitMs);
  const matches = matchProfiles(name);
  if (matches.length > 1) {
    throw new Error(`Several profiles are called "${name}": ${matches.map((p) => `${p.brand}-${p.name}`).join(', ')}. Name the browser too, e.g. "${matches[0]!.brand} ${matches[0]!.name}".`);
  }
  const profile = matches[0];
  if (!profile) return relay.waitFor(name, config.extensionWaitMs);
  const open = profileOpen(profile);
  // Open but still reconnecting (the extension retries every 30 s after Rocketwright restarts): give it that time.
  const soon = await relay.waitFor(name, open ? config.extensionWaitMs : Math.min(3000, config.extensionWaitMs)).catch(() => null);
  if (soon) return soon;
  const others = relay.connectedNames();
  const where = profile.separate ? ` (its own instance, ${profile.dataDir})` : '';
  const alternatives = others.length
    ? ` Browsers connected right now: ${others.join(', ')}. Use one of them only if the user agrees.`
    : ' No user browser is connected right now; the dedicated "agent" browser is available.';
  // A separate instance that runs is open whatever is asked: launching it again would only reach the same process.
  if ((open && !launch) || (profile.separate && dataDirInUse(profile.dataDir))) {
    throw new Error(`${profile.brand} profile "${profile.name}"${where} is open, but its Rocketwright extension is not connected. Nothing was opened or restarted: ${whyNotConnected(profile)}${alternatives}`);
  }
  if (!launch) {
    throw new Error(
      `${profile.brand} profile "${profile.name}"${where} is not open, and Rocketwright does not open a browser of the user by itself. ` +
        `If the user wants it opened, call fl_open again with launch:true: it starts with the Rocketwright extension of this installation loaded (${extensionDir()}). ` +
        `Otherwise ask the user to open it. If its extension still does not connect once open: ${whyNotConnected(profile)}${alternatives}`
    );
  }
  openProfile(profile);
  try {
    return await relay.waitFor(name, Math.max(config.extensionWaitMs, 45000));
  } catch {
    throw new Error(`Opened ${profile.brand} profile "${profile.name}"${where} with the Rocketwright extension loaded, but it did not connect: ${whyNotConnected(profile)}${alternatives}`);
  }
}

async function connectAgent(): Promise<Driven> {
  if (config.mode === 'launch') {
    const ctx = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      executablePath: config.chromePath || undefined,
      viewport: { width: 1280, height: 860 },
      acceptDownloads: true,
    });
    ctx.on('close', () => { driven.delete(AGENT); });
    return { name: AGENT, ctx, browser: null, viaExtension: false };
  }
  let version = await cdpVersion();
  if (!version) {
    if (config.cdpUrlExplicit) throw new Error(`No browser reachable at ${config.cdpUrl}.`);
    await startChromeForTesting();
    version = await cdpVersion();
  }
  if (!version) throw new Error('Browser unreachable.');
  assertDedicatedBrowser(version);
  // Go through a local filter that hides Chrome's own UI targets, which make connectOverCDP hang.
  const wsUrl = version['webSocketDebuggerUrl'];
  filter?.close();
  filter = wsUrl ? await startCdpFilter(wsUrl) : null;
  const browser = await chromium.connectOverCDP(filter ? filter.url : config.cdpUrl, { timeout: 15000 });
  browser.on('disconnected', () => { driven.delete(AGENT); });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('Connected browser exposes no context.');
  return { name: AGENT, ctx, browser, viaExtension: false };
}

/**
 * The browser to drive. name: "agent" for the dedicated browser, or a connected extension browser
 * ("brave", "chrome", "edge"...). Without a name: the dedicated browser, or in extension mode the first
 * connected browser. launch: a profile of this computer that is not open may be opened (see findOrOpen).
 */
export async function getDriven(name?: string, o: { launch?: boolean } = {}): Promise<Driven> {
  const wanted = name?.trim().toLowerCase() || (config.mode === 'extension' ? undefined : AGENT);
  if (wanted === AGENT) {
    if (config.mode === 'extension') throw new Error('Mode is "extension": there is no dedicated browser. Name a connected browser (see fl_extension).');
    if (!driven.has(AGENT)) driven.set(AGENT, connectAgent().catch((e) => { driven.delete(AGENT); throw e; }));
    return driven.get(AGENT)!;
  }
  // "Soflution", "brave" or no name at all: look the connection up under the browser's real name.
  const known = getRelayClient()?.find(wanted);
  const key = known?.key ?? wanted;
  if (key && driven.has(key)) return driven.get(key)!;
  const request = key ?? '';
  // Calls made at the same time for the same browser share one connection.
  if (!connecting.has(request)) {
    connecting.set(request, connectExtension(wanted, !!o.launch).then((d) => {
      if (!driven.has(d.name)) driven.set(d.name, Promise.resolve(d));
      return d;
    }).finally(() => connecting.delete(request)));
  }
  const settled = await connecting.get(request)!;
  return driven.get(settled.name)!;
}

export async function shutdown() {
  const agent = driven.get(AGENT);
  if (config.mode === 'launch' && agent) {
    const d = await agent.catch(() => null);
    await d?.ctx.close().catch(() => {});
  }
  driven.clear();
}
