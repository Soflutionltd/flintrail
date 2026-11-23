// Browser connections. The dedicated browser ("agent") depends on the mode:
//  - attach (default): connect over CDP to a dedicated Chrome for Testing that keeps your logged-in sessions.
//    On macOS Flintrail finds it, starts it with a local debugging port, and refuses any other browser.
//  - launch: start its own Chromium with a persistent profile (servers, CI, headless).
//  - extension: no dedicated browser, only the browsers below.
// In every mode, the user's own browsers where the Flintrail extension is installed are reachable by
// name ("brave", "brave-ideekdo", "chrome"...) through the shared relay daemon, several at once, and from
// several Flintrail processes (one per conversation) at the same time.
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { loadToken } from './auth.js';
import { getRelayClient, relayClient } from './relay-client.js';
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
        throw new Error(`Refusing to attach: port ${config.port} is not owned by Chrome for Testing or by FLINTRAIL_DEDICATED_PROFILE (set FLINTRAIL_ALLOW_ANY_BROWSER=1 to override).`);
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
  if (!bin) throw new Error('No browser reachable on the debugging port and Chrome for Testing not found (set FLINTRAIL_CHROME or FLINTRAIL_CDP_URL).');
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

/** A browser Flintrail drives: the dedicated one ("agent") or a user browser through the extension. */
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
let filter: CdpFilter | null = null;

async function connectExtension(name: string | undefined): Promise<Driven> {
  const relay = relayClient(loadToken(), VERSION);
  if (!relay) throw new Error('The extension relay is turned off (FLINTRAIL_RELAY=off).');
  const found = await relay.waitFor(name, config.extensionWaitMs);
  const { key, cdpUrl } = await relay.open(found.key);
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15000 });
  browser.on('disconnected', () => driven.delete(key));
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error(`${key}: the extension exposes no context.`);
  return { name: key, ctx, browser, viaExtension: true };
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
 * connected browser.
 */
export async function getDriven(name?: string): Promise<Driven> {
  const wanted = name?.trim().toLowerCase() || (config.mode === 'extension' ? undefined : AGENT);
  if (wanted === AGENT) {
    if (config.mode === 'extension') throw new Error('Mode is "extension": there is no dedicated browser. Name a connected browser (see fl_extension).');
    if (!driven.has(AGENT)) driven.set(AGENT, connectAgent().catch((e) => { driven.delete(AGENT); throw e; }));
    return driven.get(AGENT)!;
  }
  if (wanted && driven.has(wanted)) return driven.get(wanted)!;
  if (!wanted) {
    const first = getRelayClient()?.browsers[0];
    if (first && driven.has(first.key)) return driven.get(first.key)!;
  }
  const pending = connectExtension(wanted);
  const settled = await pending;
  // Cache under the real name (an unnamed request resolves to whichever browser is connected).
  if (!driven.has(settled.name)) driven.set(settled.name, pending);
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
