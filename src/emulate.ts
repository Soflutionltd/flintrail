// fl_emulate: how a tab presents itself to the site: a phone or tablet screen with touch, another user agent, a
// position, a language, a time zone, dark mode, no network. Through the browser's own emulation, tab by tab; in the
// user's browser the tab gets its own look back when the agent releases or closes it (fl_emulate reset too).
import type { CDPSession, Page } from 'playwright-core';
import { devices } from 'playwright-core';
import { getDriven } from './browser.js';
import { pageBrowser } from './engine.js';

export interface EmulateOptions {
  device?: string;
  width?: number;
  height?: number;
  mobile?: boolean;
  userAgent?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  locale?: string;
  timezone?: string;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  offline?: boolean;
  reset?: boolean;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
const sessions = new WeakMap<Page, CDPSession>();
/** Tabs with emulation on, so release and close can undo it. */
const emulated = new WeakSet<Page>();

/** Runs fn with a way to send emulation commands to the tab. */
export async function withSender<T>(page: Page, fn: (send: Send) => Promise<T>): Promise<T> {
  const where = pageBrowser(page);
  if (where.viaExtension) {
    // The relay passes them to this conversation's tab at that address (see Rocketwright.tabCommand).
    const driven = await getDriven(where.browser);
    if (!driven.browser) throw new Error('This browser cannot take emulation commands.');
    const cdp = await driven.browser.newBrowserCDPSession();
    const raw = cdp.send.bind(cdp) as (m: string, p: Record<string, unknown>) => Promise<unknown>;
    try {
      return await fn((method, params = {}) => raw('Rocketwright.tabCommand', { url: page.url(), method, params }));
    } finally {
      await cdp.detach().catch(() => {});
    }
  }
  // The dedicated browser: one session per tab, kept, since its overrides end with it.
  let cdp = sessions.get(page);
  if (!cdp) sessions.set(page, (cdp = await page.context().newCDPSession(page)));
  const raw = cdp.send.bind(cdp) as (m: string, p: Record<string, unknown>) => Promise<unknown>;
  return fn((method, params = {}) => raw(method, params));
}

/** Every override back to the tab's own values. */
export async function resetEmulation(page: Page) {
  if (!emulated.has(page) || page.isClosed()) return;
  await withSender(page, (send) => Promise.allSettled([
    send('Emulation.clearDeviceMetricsOverride'),
    send('Emulation.setTouchEmulationEnabled', { enabled: false }),
    send('Emulation.setEmitTouchEventsForMouse', { enabled: false }),
    send('Emulation.setUserAgentOverride', { userAgent: '' }),
    send('Emulation.clearGeolocationOverride'),
    send('Emulation.setLocaleOverride', {}),
    send('Emulation.setTimezoneOverride', { timezoneId: '' }),
    send('Emulation.setEmulatedMedia', { media: '', features: [] }),
    send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),
  ]));
  // Playwright keeps its own screen size on the dedicated browser's tabs: put it back after the device one.
  const size = page.viewportSize();
  if (size) await page.setViewportSize({ width: size.width + 1, height: size.height }).then(() => page.setViewportSize(size)).catch(() => {});
  emulated.delete(page);
}

export async function emulate(page: Page, o: EmulateOptions): Promise<string> {
  if (o.reset) {
    await resetEmulation(page);
    return 'Emulation off: the tab has its own screen, user agent, position, language, time zone and network again.';
  }
  return withSender(page, (send) => apply(page, send, o));
}

/** Chrome keeps a few overrides from extensions: said plainly, with where it works. */
const trusted = (e: Error) => (/only available to trusted clients/i.test(e.message)
  ? 'Chrome does not let an extension change this in your own browser (time zone, language). Use the dedicated browser for it (browser "agent").'
  : null);

async function apply(page: Page, send: Send, o: EmulateOptions): Promise<string> {
  const said: string[] = [];
  let width = o.width;
  let height = o.height;
  let mobile = o.mobile;
  let scale = 0;
  let userAgent = o.userAgent;
  if (o.device) {
    const d = devices[o.device] || Object.entries(devices).find(([k]) => k.toLowerCase() === o.device!.toLowerCase())?.[1];
    if (!d) throw new Error(`Unknown device "${o.device}". Examples: ${['iPhone 15', 'iPhone 15 Pro Max', 'Pixel 7', 'iPad Pro 11', 'Galaxy S9+'].join(', ')}.`);
    width ??= d.viewport.width;
    height ??= d.viewport.height;
    mobile ??= d.isMobile;
    scale = d.deviceScaleFactor;
    userAgent ??= d.userAgent;
    said.push(o.device);
  }
  emulated.add(page);
  if (width && height) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: !!mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 1 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: !!mobile, configuration: mobile ? 'mobile' : 'desktop' });
    said.push(`${width}x${height}${mobile ? ' with touch' : ''}`);
  }
  if (userAgent) {
    await send('Emulation.setUserAgentOverride', { userAgent, ...(o.locale ? { acceptLanguage: o.locale } : {}) });
    said.push('its user agent');
  }
  if (typeof o.latitude === 'number' && typeof o.longitude === 'number') {
    if (Math.abs(o.latitude) > 90 || Math.abs(o.longitude) > 180) throw new Error('latitude between -90 and 90, longitude between -180 and 180.');
    await send('Emulation.setGeolocationOverride', { latitude: o.latitude, longitude: o.longitude, accuracy: o.accuracy ?? 50 });
    said.push(`position ${o.latitude}, ${o.longitude} (the site still has to be allowed to ask for it)`);
  }
  if (o.locale) {
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(o.locale)) throw new Error('locale: e.g. fr-FR, en-US.');
    await send('Emulation.setLocaleOverride', { locale: o.locale }).catch((e: Error) => { throw new Error(trusted(e) ?? e.message); });
    said.push(`language ${o.locale}`);
  }
  if (o.timezone) {
    await send('Emulation.setTimezoneOverride', { timezoneId: o.timezone }).catch((e: Error) => {
      throw new Error(trusted(e) ?? (/timezone/i.test(e.message) ? `Unknown time zone "${o.timezone}" (e.g. Europe/Paris).` : e.message));
    });
    said.push(`time zone ${o.timezone}`);
  }
  if (o.colorScheme) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.colorScheme }] });
    said.push(`${o.colorScheme} color scheme`);
  }
  if (typeof o.offline === 'boolean') {
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: o.offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    said.push(o.offline ? 'offline' : 'online');
  }
  if (!said.length) throw new Error('Nothing to emulate: give device, width and height, userAgent, latitude and longitude, locale, timezone, colorScheme or offline (or reset).');
  return `Emulating ${said.join(', ')}. Reload the page (goto) for a site that reads them only at load. fl_emulate reset, fl_release or fl_close puts the tab back.`;
}
