// Browser connection. Two modes:
//  - attach (default): connect over CDP to a dedicated Chrome for Testing that keeps your logged-in sessions.
//    On macOS Flintrail finds it, starts it with a local debugging port, and refuses any other browser.
//  - launch: start its own Chromium with a persistent profile (servers, CI, headless).
//  - extension: drive the browser where the Flintrail extension is installed, through the local relay.
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { loadToken } from './auth.js';
import { startRelay } from './relay.js';

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
      if (!cmd.includes('Google Chrome for Testing')) {
        throw new Error(`Refusing to attach: port ${config.port} is not owned by Chrome for Testing (set FLINTRAIL_ALLOW_ANY_BROWSER=1 to override).`);
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

let ctxPromise: Promise<BrowserContext> | null = null;
let browserRef: Browser | null = null;

async function connect(): Promise<BrowserContext> {
  if (config.mode === 'extension') {
    const relay = await startRelay(loadToken());
    if (!relay) throw new Error(`Another Flintrail process owns the extension relay on port ${config.relayPort}.`);
    await relay.waitForExtension(config.extensionWaitMs);
    const browser = await chromium.connectOverCDP(relay.cdpUrl, { timeout: 15000 });
    browserRef = browser;
    browser.on('disconnected', () => { ctxPromise = null; browserRef = null; });
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('Extension browser exposes no context.');
    return ctx;
  }
  if (config.mode === 'launch') {
    const ctx = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      executablePath: config.chromePath || undefined,
      viewport: { width: 1280, height: 860 },
      acceptDownloads: true,
    });
    ctx.on('close', () => { ctxPromise = null; });
    return ctx;
  }
  let version = await cdpVersion();
  if (!version) {
    if (config.cdpUrlExplicit) throw new Error(`No browser reachable at ${config.cdpUrl}.`);
    await startChromeForTesting();
    version = await cdpVersion();
  }
  if (!version) throw new Error('Browser unreachable.');
  assertDedicatedBrowser(version);
  const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 15000 });
  browserRef = browser;
  browser.on('disconnected', () => { ctxPromise = null; browserRef = null; });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('Connected browser exposes no context.');
  return ctx;
}

export async function getContext(): Promise<BrowserContext> {
  if (!ctxPromise) ctxPromise = connect().catch((e) => { ctxPromise = null; throw e; });
  return ctxPromise;
}

/** Attached browser handle (null in launch mode). */
export function getAttachedBrowser(): Browser | null {
  return browserRef;
}

export async function shutdown() {
  if (config.mode === 'launch' && ctxPromise) {
    const ctx = await ctxPromise.catch(() => null);
    await ctx?.close().catch(() => {});
  }
  ctxPromise = null;
}
