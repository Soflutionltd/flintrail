// fl_trace and fl_video: what the agent did, kept for a human. A trace is Playwright's own file (every action with a
// picture before and after), opened with `npx playwright show-trace`. A video films one tab.
// Both are dropped, files and all, before Rocketwright fills a password, a code or a secret where they record, or as soon
// as a secret shows there: the file would hold it. A trace never keeps page copies or the network log: they hold the
// browser's cookies and whatever the user types by hand. Playwright writes its own working copy of each in a
// temporary folder until the browser closes: Rocketwright deletes it as soon as the recording ends, kept or dropped,
// since an agent with a shell could read it there.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { BrowserContext, Page } from 'playwright-core';
import { config } from './config.js';
import { assertNoSecret, assertNoSecretIn, drivenIn, onSecret } from './engine.js';
import { holdsRemembered } from './secrets.js';

interface Recording {
  file: string;
  started: number;
  /** Settles once recording really runs: a secret that comes meanwhile waits for it, then drops it. */
  ready: Promise<void>;
  /** Being saved (stop, release, time limit): a secret that comes meanwhile waits, then deletes what was saved. */
  saving?: Promise<string>;
  /** A secret came near: being dropped, or dropped. */
  dropping?: Promise<void>;
  /** Stops without saving and deletes every copy. */
  drop: () => Promise<void>;
  /** Stops at the time limit. */
  timer?: NodeJS.Timeout;
  /** Stops watching the browser's new tabs (a trace saved when its last tab closes). */
  unwatch?: () => void;
}

const traces = new Map<BrowserContext, Recording>();
const videos = new Map<Page, Recording>();
/** Playwright's own name for a trace's working copy; a video's on-screen pointer. */
const traceNames = new WeakMap<Recording, string>();
const pointers = new WeakMap<Recording, { dispose: () => Promise<void> }>();
/** What a recording that ended by itself (time limit, last tab released) said, for the next stop. */
const endedTraces = new WeakMap<BrowserContext, string>();
const endedVideos = new WeakMap<Page, string>();

/** A recording stops by itself after this: the file and the temporary folder do not grow without end. */
const MAX_MS = 30 * 60_000;

const DROPPED = 'deleted: Rocketwright filled a password, a code or a secret while it recorded, and the file would hold it';

/** A trace or video shows every frame of the page, the frames of other sites it embeds included. */
function assertNoList(what: string) {
  if (config.allowedDomains.length) {
    throw new Error(`Refused: ${what} would record the frames of other sites the page embeds, which ROCKETWRIGHT_ALLOWED_DOMAINS keeps from the agent. Use fl_screenshot, which hides them.`);
  }
}

function fileFor(base: string, ext: string): string {
  mkdirSync(config.downloadsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const clean = base.replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 60) || 'rocketwright';
  let file = join(config.downloadsDir, `${clean} ${stamp}.${ext}`);
  for (let n = 2; existsSync(file); n++) file = join(config.downloadsDir, `${clean} ${stamp} (${n}).${ext}`);
  return file;
}

const removeFile = (file: string) => { try { unlinkSync(file); } catch { /* never written */ } };

/** Playwright's temporary folders (its in-process driver writes them under this process's temp folder). */
function workDirs(): string[] {
  try {
    return readdirSync(tmpdir()).filter((d) => /^playwright-(artifacts|tracing)-/.test(d)).map((d) => join(tmpdir(), d));
  } catch {
    return [];
  }
}

/** Deletes Playwright's working copy of a trace: its files and the pictures it gathered. */
function removeTraceWork(name: string) {
  for (const dir of workDirs()) {
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    if (!files.includes(`${name}.trace`)) continue;
    for (const f of files) if (f.startsWith(name)) removeFile(join(dir, f));
    // One trace at a time per browser, and one browser per folder: its pictures are this trace's own.
    for (const sub of ['resources', 'screencast']) rmSync(join(dir, sub), { recursive: true, force: true });
  }
}

/** Deletes Playwright's working copy of a saved video: the file in its folders with the very same bytes. */
function removeVideoWork(saved: string) {
  let bytes: Buffer;
  try { bytes = readFileSync(saved); } catch { return; }
  for (const dir of workDirs()) {
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.webm')); } catch { continue; }
    for (const f of files) {
      const p = join(dir, f);
      try { if (statSync(p).size === bytes.length && readFileSync(p).equals(bytes)) removeFile(p); } catch { /* gone */ }
    }
  }
}

/** The text files of a saved trace (a zip): actions, their results, console messages. */
function traceTexts(file: string): string[] {
  const buf = readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString();
    const local = buf.readUInt32LE(at + 42);
    if (!/\.(jpe?g|png)$/.test(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + size);
      texts.push((method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
    }
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return texts;
}

// A secret near a recording: dropped, and fl_login / fl_paste_secret wait for that before they fill anything.
onSecret(async (page) => {
  const pending: Promise<void>[] = [];
  const trace = traces.get(page.context());
  if (trace) pending.push(dropOnce(trace));
  const video = videos.get(page);
  if (video) pending.push(dropOnce(video));
  await Promise.all(pending);
});

function dropOnce(rec: Recording): Promise<void> {
  // A save already under way is let finish, then what it saved is deleted. One that starts later sees the drop and
  // waits for it instead (taken now, so the two never wait on each other).
  rec.dropping ??= (async (saving: Promise<string> | undefined) => {
    clearTimeout(rec.timer);
    await rec.ready.catch(() => {});
    await saving?.catch(() => '');
    await rec.drop();
  })(rec.saving);
  return rec.dropping;
}

/** Saves a trace (stop, time limit, last tab released), unless a secret came: then nothing is kept. */
function saveTrace(ctx: BrowserContext, rec: Recording): Promise<string> {
  rec.saving ??= (async () => {
    clearTimeout(rec.timer);
    if (rec.dropping) {
      await rec.dropping;
      return `Trace ${DROPPED}. Start a new one after the sign-in.`;
    }
    await rec.ready;
    try {
      await ctx.tracing.stop({ path: rec.file });
    } finally {
      removeTraceWork(traceNames.get(rec)!);
    }
    // A value Rocketwright masks everywhere (a filled password, a captured token) that reached the file another way, in
    // a script's result or a console message: nothing is kept.
    let held = false;
    try { held = traceTexts(rec.file).some(holdsRemembered); } catch { held = true; }
    if (held || rec.dropping) {
      removeFile(rec.file);
      return `Trace ${held ? 'deleted: it held a password, code or secret Rocketwright masks' : DROPPED}.`;
    }
    const s = Math.round((Date.now() - rec.started) / 1000);
    return `Trace saved: ${rec.file} (${s} s). The user opens it with: npx playwright show-trace "${rec.file}" (or by dropping it on trace.playwright.dev, which reads it locally).`;
  })().finally(() => {
    rec.unwatch?.();
    if (traces.get(ctx) === rec) traces.delete(ctx);
  });
  return rec.saving;
}

/** Whether a trace records this browser: fl_session refuses meanwhile, its cookies would be in the trace. */
export function traceRunning(ctx: BrowserContext): boolean {
  return traces.has(ctx);
}

export async function trace(page: Page, action: 'start' | 'stop', name?: string): Promise<string> {
  const ctx = page.context();
  const now = traces.get(ctx);
  if (action === 'stop') {
    if (!now) {
      const ended = endedTraces.get(ctx);
      if (ended) { endedTraces.delete(ctx); return ended; }
      throw new Error('No trace is running in this browser (fl_trace start first).');
    }
    return saveTrace(ctx, now);
  }
  if (now) throw new Error(`A trace is already running in this browser, since ${Math.round((Date.now() - now.started) / 1000)} s (fl_trace stop first).`);
  assertNoList('a trace');
  // A new trace: what an older one said when it stopped by itself is no longer the answer to a stop.
  endedTraces.delete(ctx);
  // Every tab Rocketwright drives in this browser is in the trace, not only this one.
  assertNoSecretIn(ctx, 'A trace');
  const work = `rocketwright-${randomUUID()}`;
  const file = fileFor(name || 'trace', 'zip');
  // Pictures and actions only: page copies and the network log would put the browser's cookies, and whatever is
  // typed by hand, in a file the agent can read.
  const ready = ctx.tracing.start({ name: work, screenshots: true, snapshots: false, title: name || 'Rocketwright' }).then(() => {});
  const rec: Recording = {
    file,
    started: Date.now(),
    ready,
    drop: async () => {
      rec.unwatch?.();
      await ctx.tracing.stop().catch(() => {});
      removeTraceWork(work);
      removeFile(file);
      if (traces.get(ctx) === rec) {
        traces.delete(ctx);
        endedTraces.set(ctx, `Trace ${DROPPED}. Start a new one after the sign-in.`);
      }
    },
  };
  traceNames.set(rec, work);
  // Registered before it starts: a sign-in that begins meanwhile finds it and waits.
  traces.set(ctx, rec);
  try {
    await ready;
  } catch (e) {
    traces.delete(ctx);
    throw e;
  }
  rec.timer = setTimeout(() => {
    void saveTrace(ctx, rec).then((said) => endedTraces.set(ctx, `The trace stopped by itself after ${MAX_MS / 60_000} minutes. ${said}`), () => {});
  }, MAX_MS);
  rec.timer.unref();
  // The user or the site closes the last tab Rocketwright drove there: the trace is saved then, as with fl_close.
  const onClose = () => setTimeout(() => {
    if (traces.get(ctx) !== rec || drivenIn(ctx) > 0) return;
    void saveTrace(ctx, rec).then((said) => endedTraces.set(ctx, `The trace stopped when its last tab closed. ${said}`), () => {});
  }, 0);
  const watch = (p: Page) => p.once('close', onClose);
  ctx.pages().forEach(watch);
  ctx.on('page', watch);
  rec.unwatch = () => ctx.off('page', watch);
  return `Trace started for every tab Rocketwright drives in this browser: every action with a picture before and after (no page copy or network log: they would hold the browser's cookies). fl_trace stop saves it; it stops by itself after ${MAX_MS / 60_000} minutes or when the last tab is released or closed. It is deleted if Rocketwright fills a password or secret meanwhile.`;
}

/** The last tab Rocketwright drove in this browser was released or closed: its trace is saved. */
export async function endTraceIfIdle(ctx: BrowserContext, drivenLeft: number): Promise<string | null> {
  const rec = traces.get(ctx);
  if (!rec || drivenLeft > 0) return null;
  return saveTrace(ctx, rec);
}

function saveVideo(page: Page, rec: Recording): Promise<string> {
  rec.saving ??= (async () => {
    clearTimeout(rec.timer);
    if (rec.dropping) {
      await rec.dropping;
      return `Video ${DROPPED}. Start a new one after the sign-in.`;
    }
    await rec.ready;
    await stopFilming(page, rec);
    if (rec.dropping) {
      removeFile(rec.file);
      return `Video ${DROPPED}.`;
    }
    if (!existsSync(rec.file)) throw new Error('The video could not be written (the tab closed?).');
    const s = Math.round((Date.now() - rec.started) / 1000);
    return `Video saved: ${rec.file} (${s} s, WebM, plays in any browser).`;
  })().finally(() => { if (videos.get(page) === rec) videos.delete(page); });
  return rec.saving;
}

export async function video(page: Page, action: 'start' | 'stop', o: { name?: string; actions?: boolean } = {}): Promise<string> {
  const now = videos.get(page);
  if (action === 'stop') {
    if (!now) {
      const ended = endedVideos.get(page);
      if (ended) { endedVideos.delete(page); return ended; }
      throw new Error('No video is being recorded in this tab (fl_video start first).');
    }
    return saveVideo(page, now);
  }
  if (now) throw new Error('This tab is already being filmed (fl_video stop first).');
  assertNoList('a video');
  endedVideos.delete(page);
  assertNoSecret(page, 'A video');
  const file = fileFor(o.name || (await page.title().catch(() => '')) || 'video', 'webm');
  const view = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => ({ width: 1280, height: 800 }));
  // Even sizes, at most 1280 wide: what the encoder takes, and a file that stays small.
  const scale = Math.min(1, 1280 / view.width);
  const size = { width: Math.max(2, Math.round((view.width * scale) / 2) * 2), height: Math.max(2, Math.round((view.height * scale) / 2) * 2) };
  let rec: Recording | null = null;
  const ready = (async () => {
    const shown = o.actions !== false ? await page.screencast.showActions({ duration: 700 }).catch(() => null) : null;
    if (shown && rec) pointers.set(rec, shown);
    await page.screencast.start({ path: file, size });
  })();
  const own: Recording = {
    file,
    started: Date.now(),
    ready,
    drop: async () => {
      await stopFilming(page, own);
      removeFile(file);
      if (videos.get(page) === own) {
        videos.delete(page);
        endedVideos.set(page, `Video ${DROPPED}. Start a new one after the sign-in.`);
      }
    },
  };
  rec = own;
  // Registered before it starts: a sign-in that begins meanwhile finds it and waits.
  videos.set(page, own);
  try {
    await ready;
  } catch (e) {
    videos.delete(page);
    throw e;
  }
  own.timer = setTimeout(() => {
    void saveVideo(page, own).then((said) => endedVideos.set(page, `The video stopped by itself after ${MAX_MS / 60_000} minutes. ${said}`), () => {});
  }, MAX_MS);
  own.timer.unref();
  // Closed by the site or the user: Playwright saves what it has, and its working copy goes.
  page.once('close', () => {
    if (videos.get(page) !== own) return;
    videos.delete(page);
    clearTimeout(own.timer);
    setTimeout(() => removeVideoWork(file), 1000);
  });
  return `Filming tab: ${size.width}x${size.height}${pointers.has(own) ? ', each action pointed out on screen' : ''}. fl_video stop saves it; it stops by itself after ${MAX_MS / 60_000} minutes. It is deleted if Rocketwright fills a password or secret in this tab meanwhile.`;
}

async function stopFilming(page: Page, rec: Recording) {
  try {
    await page.screencast.stop().catch(() => {});
    await pointers.get(rec)?.dispose().catch(() => {});
  } finally {
    removeVideoWork(rec.file);
  }
}

/** The tab is released or closed: its video is saved as it is. */
export async function stopVideo(page: Page): Promise<string | null> {
  if (!videos.has(page)) return null;
  return video(page, 'stop').catch((e: Error) => `Video: ${e.message}`);
}
