// Renders docs/extension-popup.png (the popup in its recording state) for the README.
import { chromium } from 'playwright-core';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { dirname, join } from 'node:path'; import { fileURLToPath } from 'node:url';
const ext = join(dirname(fileURLToPath(import.meta.url)), '../extension');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'x-')), { viewport: { width: 320, height: 520 }, deviceScaleFactor: 2, headless: true, ...(process.env.FLINTRAIL_CHROME ? { executablePath: process.env.FLINTRAIL_CHROME } : { channel: 'chromium' }), args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
await sw.evaluate(() => chrome.storage.local.set({ status: 'connected', token: 'x'.repeat(32), recording: { name: 'paybyphone-renew', tabId: 1, steps: 4 } }));
await new Promise((r) => setTimeout(r, 1500));
await sw.evaluate(() => chrome.storage.local.set({ status: 'connected', autoConnect: false }));
const p = await ctx.newPage({ viewport: { width: 320, height: 440 }, deviceScaleFactor: 2 });
await p.goto(`chrome-extension://${id}/popup.html`);
await p.waitForTimeout(400);
const h = await p.evaluate(() => document.body.scrollHeight);
await p.screenshot({ path: join(ext, '../docs/extension-popup.png'), clip: { x: 0, y: 0, width: 320, height: h } });
await ctx.close();
