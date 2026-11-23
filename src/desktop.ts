// Desktop apps (Finder, Mail, Preview, Calculator, any native app) through the OS accessibility tree.
// Powered by agent-desktop (Apache-2.0, Vercel Labs): https://github.com/vercel-labs/agent-desktop
// Headless by default: actions go through the accessibility API, the pointer does not move and no window is raised.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export type DesktopKind =
  | 'click' | 'dblclick' | 'rightclick' | 'fill' | 'type' | 'clear' | 'press' | 'select'
  | 'check' | 'uncheck' | 'toggle' | 'expand' | 'collapse' | 'focus' | 'scroll' | 'get'
  | 'wait' | 'launch' | 'quit';

/** Fingerprint of an element, stable across runs (refs are not). */
export interface DesktopTarget {
  role: string;
  name?: string;
  nativeId?: string;
  /** Index among the elements of the snapshot with the same nativeId, or the same role + name. */
  nth?: number;
}

/** One desktop action, as the agent sends it live. */
export interface DesktopAction {
  do: DesktopKind;
  app?: string;
  ref?: string;
  role?: string;
  name?: string;
  nativeId?: string;
  value?: string;
  var?: string;
  key?: string;
  text?: string;
  ms?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

/** One desktop step, as stored in a flow. */
export interface DesktopStep {
  do: DesktopKind;
  app?: string;
  target?: DesktopTarget;
  value?: string;
  key?: string;
  text?: string;
  ms?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

export interface SnapOptions {
  window?: string;
  interactive?: boolean;
  root?: string;
  skeleton?: boolean;
  surface?: string;
  max?: number;
}

interface AdNode {
  role?: string;
  name?: string;
  value?: string | null;
  ref_id?: string;
  states?: string[];
  native_id?: { kind?: string; value?: string };
  children?: AdNode[];
  children_count?: number;
}

interface Known { ref: string; target: DesktopTarget }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REF_ACTIONS: Partial<Record<DesktopKind, string>> = {
  click: 'click', dblclick: 'double-click', rightclick: 'right-click', clear: 'clear',
  check: 'check', uncheck: 'uncheck', toggle: 'toggle', expand: 'expand', collapse: 'collapse', focus: 'focus',
};

export class DesktopError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// ---------- binary ----------

let bin: string | null = null;
export function binary(): string {
  if (bin) return bin;
  const env = process.env.FLINTRAIL_AGENT_DESKTOP;
  if (env) return (bin = env);
  const ext = process.platform === 'win32' ? '.exe' : '';
  try {
    const dir = join(dirname(createRequire(import.meta.url).resolve('agent-desktop/package.json')), 'bin');
    for (const n of [`agent-desktop${ext}`, `agent-desktop-${process.platform}-${process.arch}${ext}`]) {
      if (existsSync(join(dir, n))) return (bin = join(dir, n));
    }
  } catch { /* not installed as a dependency: fall back to PATH */ }
  return (bin = 'agent-desktop');
}

/** Runs one agent-desktop command and returns its data, or throws its error. */
export function ad<T = any>(args: string[], timeout = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(binary(), args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const line = stdout.trim().split('\n').pop() || '';
      let j: any;
      try { j = JSON.parse(line); } catch {
        const why = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
          ? 'agent-desktop is not installed (npm i agent-desktop, or set FLINTRAIL_AGENT_DESKTOP)'
          : (stderr || err?.message || 'no output').trim().slice(0, 300);
        return reject(new DesktopError('NO_OUTPUT', `agent-desktop: ${why}`));
      }
      if (j.ok) return resolve(j.data as T);
      const e = j.error || {};
      const windows = Array.isArray(e.details?.candidates || e.details?.windows)
        ? ` Windows: ${(e.details.candidates || e.details.windows).map((w: any) => `${w.id || w.window_id} "${w.title || ''}"`).join(', ')}.`
        : '';
      reject(new DesktopError(e.code || 'ERROR', `${e.code || 'ERROR'}: ${e.message || 'failed'}${e.suggestion ? ` (${e.suggestion})` : ''}${windows}`));
    });
  });
}

// ---------- apps ----------

let appsCache: { at: number; apps: { name: string; bundle_id?: string; presentation?: string }[] } | null = null;
async function runningApps() {
  if (!appsCache || Date.now() - appsCache.at > 5000) {
    // The inventory can be busy right after an app launches or quits: retry briefly.
    let d: any;
    for (let i = 0; ; i++) {
      try { d = await ad<any>(['list-apps']); break; } catch (e) {
        if (i >= 3 || (e as DesktopError).code !== 'TIMEOUT') throw e;
        await sleep(400);
      }
    }
    appsCache = { at: Date.now(), apps: d.apps || [] };
  }
  return appsCache.apps;
}

/** Accepts the localized name ("Calculatrice"), the English name ("Calculator") or the bundle id. */
export async function resolveApp(app: string): Promise<string> {
  const apps = await runningApps();
  const low = app.toLowerCase();
  const hit = apps.find((a) => a.name.toLowerCase() === low)
    || apps.find((a) => a.bundle_id?.toLowerCase() === low)
    || apps.find((a) => a.bundle_id?.toLowerCase().split('.').pop() === low.replace(/\s+/g, ''))
    || apps.find((a) => a.presentation === 'foreground' && a.name.toLowerCase().includes(low));
  return hit ? hit.name : app;
}

export async function listApps(): Promise<string> {
  appsCache = null;
  const apps = (await runningApps()).filter((a) => a.presentation === 'foreground');
  return apps.length ? `Running apps: ${apps.map((a) => a.name).join(', ')}.` : 'No foreground app found.';
}

async function windowOf(app: string): Promise<string | undefined> {
  const w = await ad<any[]>(['list-windows', '--app', app]).catch(() => []);
  return (w.find((x) => x.is_focused) || w[0])?.id;
}

// ---------- snapshots ----------

const known = new Map<string, Map<string, Known>>();
const stableId = (n: AdNode) => {
  const v = n.native_id?.value;
  // Ids that embed live state ("StandardInputView;value:0") change between runs.
  return v && !/[;:]/.test(v) && v.length < 120 ? v : undefined;
};

export async function snapshotApp(appIn: string, o: SnapOptions = {}): Promise<string> {
  const app = await resolveApp(appIn);
  const args = ['snapshot', '--app', app, '--compact'];
  if (o.interactive !== false) args.push('-i');
  if (o.window) args.push('--window-id', o.window);
  if (o.skeleton) args.push('--skeleton');
  if (o.surface) args.push('--surface', o.surface);
  if (o.root) args.push('--root', refOf(app, o.root));
  const d = await ad<any>(args);
  const map = new Map<string, Known>();
  known.set(app, map);
  const max = o.max ?? 150;
  const lines: string[] = [];
  const counts = new Map<string, number>();
  let n = 0;
  let hidden = 0;
  const walk = (node: AdNode, depth: number) => {
    let next = depth;
    if (node.ref_id) {
      const target: DesktopTarget = { role: node.role || 'unknown' };
      if (node.name) target.name = node.name;
      const nid = stableId(node);
      if (nid) target.nativeId = nid;
      const key = nid ? `id:${nid}` : `rn:${target.role}|${target.name || ''}`;
      const nth = counts.get(key) || 0;
      counts.set(key, nth + 1);
      if (nth) target.nth = nth;
      const short = `d${++n}`;
      map.set(short, { ref: node.ref_id, target });
      if (lines.length < max) lines.push(fmt(node, short, depth)); else hidden++;
      next = depth + 1;
    } else if (node.name && node.role !== 'window') {
      if (lines.length < max) lines.push(`${'  '.repeat(depth)}- ${node.role} "${clip(node.name)}"${node.value ? ` = "${clip(String(node.value))}"` : ''}`);
      next = depth + 1;
    }
    if (node.children_count && !node.children?.length) lines.push(`${'  '.repeat(next)}(${node.children_count} children, use root to expand)`);
    for (const c of node.children || []) walk(c, next);
  };
  if (d.tree) walk(d.tree, 0);
  const head = `App ${d.app}, window "${d.window?.title || ''}" (${d.window?.id || '?'}), ${n} elements${d.complete === false ? ' (partial)' : ''}`;
  return [head, ...lines, ...(hidden ? [`... ${hidden} more (raise max, or snapshot a region with root)`] : [])].join('\n');
}

const clip = (s: string, l = 80) => (s.length > l ? s.slice(0, l) + '…' : s).replace(/\n/g, ' ');
function fmt(node: AdNode, short: string, depth: number) {
  const st = node.states?.filter((s) => /^(checked|selected|expanded|disabled)$/.test(s)) || [];
  return `${'  '.repeat(depth)}[${short}] ${node.role}${node.name ? ` "${clip(node.name)}"` : ''}` +
    `${node.value !== undefined && node.value !== null && node.value !== '' ? ` = "${clip(String(node.value))}"` : ''}` +
    `${st.length ? ` {${st.join(', ')}}` : ''}`;
}

function refOf(app: string, short: string): string {
  if (short.startsWith('@')) return short;
  const k = known.get(app)?.get(short);
  if (!k) throw new DesktopError('UNKNOWN_REF', `Unknown ref ${short} for ${app}: take a fresh fl_desktop snapshot.`);
  return k.ref;
}

// ---------- resolving targets (replay, and self-healing of stale refs) ----------

export async function findTarget(app: string, t: DesktopTarget, timeout = 7000): Promise<string> {
  // Clues in order of strength: native id first, then role + exact name (ids can carry state, names can be localized).
  const queries: string[][] = [];
  if (t.nativeId) queries.push(['--native-id', t.nativeId]);
  if (t.name || !t.nativeId) queries.push(['--role', t.role, ...(t.name ? ['--name', t.name, '--exact'] : [])]);
  const t0 = Date.now();
  for (;;) {
    for (const q of queries) {
      const d = await ad<any>(['find', '--app', app, '--limit', '0', ...q]).catch((e) => { if (e.code === 'APP_NOT_FOUND') throw e; return null; });
      const matches: { ref_id: string }[] = d?.matches || (d?.match ? [d.match] : []);
      const hit = matches[t.nth || 0] || matches[0];
      if (hit) return hit.ref_id;
    }
    if (Date.now() - t0 > timeout) {
      throw new DesktopError('NOT_FOUND', `element not found in ${app}: ${t.role}${t.name ? ` "${t.name}"` : ''}${t.nativeId ? ` #${t.nativeId}` : ''}`);
    }
    await sleep(250);
  }
}

// ---------- actions ----------

const fill = (v: string | undefined, vars?: Record<string, string>) =>
  v === undefined ? v : v.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars?.[k] ?? `{{${k}}}`);

/** Performs one stored step. Returns a value for `get`. */
export async function performDesktop(s: DesktopStep, ref: string | null, vars?: Record<string, string>): Promise<string | undefined> {
  const app = s.app ? await resolveApp(s.app) : undefined;
  const value = fill(s.value, vars);
  const need = () => { if (!ref) throw new DesktopError('NO_TARGET', `${s.do} needs an element (ref, or role / name / nativeId).`); return ref; };
  const cmd = REF_ACTIONS[s.do];
  if (cmd) { await ad([cmd, need()]); return; }
  switch (s.do) {
    case 'fill':
      try { await ad(['set-value', need(), value ?? '']); } catch {
        await ad(['clear', need()]).catch(() => {});
        await ad(['type', need(), value ?? '']);
      }
      return;
    case 'type': await ad(['type', need(), value ?? '']); return;
    case 'select': await ad(['select', need(), value ?? '']); return;
    case 'scroll': await ad(['scroll', need(), '--direction', s.direction || 'down', '--amount', String(s.amount ?? 3)]); return;
    case 'get': {
      const v = String((await ad<any>(['get', need(), '--property', s.text === 'value' ? 'value' : 'text'])).value ?? '');
      if (v || s.text === 'value') return v;
      // Containers (a calculator display, a list cell) carry their text in children: read the subtree.
      const d = await ad<any>(['snapshot', '--root', need(), '--compact']).catch(() => null);
      const parts: string[] = [];
      const walk = (n: AdNode) => {
        const t = (n.value !== undefined && n.value !== null && n.value !== '' ? String(n.value) : n.name) || '';
        if (t && !parts.includes(t)) parts.push(t);
        for (const c of n.children || []) walk(c);
      };
      if (d?.tree) for (const c of d.tree.children || []) walk(c);
      return parts.join(' ').trim();
    }
    case 'press': {
      if (ref) await ad(['focus', ref]).catch(() => {});
      const w = app ? await windowOf(app) : undefined;
      await ad(['press', s.key || 'return', ...(w ? ['--window-id', w] : [])]);
      return;
    }
    case 'wait':
      if (s.text) await ad(['wait', '--text', fill(s.text, vars)!, ...(app ? ['--app', app] : []), '--timeout', String(s.ms ?? 15000)], (s.ms ?? 15000) + 5000);
      else await sleep(s.ms ?? 500);
      return;
    case 'launch':
      if (!app) throw new DesktopError('NO_APP', 'launch needs app.');
      await ad(['launch', app]);
      appsCache = null;
      return;
    case 'quit':
      if (!app) throw new DesktopError('NO_APP', 'quit needs app.');
      await ad(['close-app', app]);
      appsCache = null;
      return;
  }
  throw new DesktopError('BAD_ACTION', `Unknown desktop action "${s.do}".`);
}

/**
 * Live: runs several actions on one app, then returns a fresh snapshot.
 * A stale ref is healed once by finding the same element again from its fingerprint.
 * `record` receives each step with its fingerprint, for fl_record_start.
 */
export async function actDesktop(
  appIn: string,
  actions: DesktopAction[],
  opts: { snapshot?: boolean; max?: number; interactive?: boolean; record?: (s: DesktopStep) => void } = {},
): Promise<string> {
  const out: string[] = [];
  let app = await resolveApp(appIn);
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    if (a.app) app = await resolveApp(a.app);
    const step: DesktopStep = { do: a.do, app };
    if (a.value !== undefined) step.value = a.var ? `{{${a.var}}}` : a.value;
    for (const k of ['key', 'text', 'ms', 'direction', 'amount'] as const) if (a[k] !== undefined) (step as any)[k] = a[k];
    let ref: string | null = null;
    try {
      if (a.ref) {
        ref = refOf(app, a.ref);
        step.target = a.ref.startsWith('@') ? undefined : known.get(app)?.get(a.ref)?.target;
      } else if (a.role || a.name || a.nativeId) {
        step.target = { role: a.role || 'button', ...(a.name ? { name: a.name } : {}), ...(a.nativeId ? { nativeId: a.nativeId } : {}) };
        ref = await findTarget(app, step.target);
      }
      const run = { ...step, value: a.value };
      let v: string | undefined;
      try {
        v = await performDesktop(run, ref);
      } catch (e) {
        if (!(e instanceof DesktopError) || !/STALE_REF|SNAPSHOT_NOT_FOUND|ELEMENT_NOT_FOUND/.test(e.code) || !step.target) throw e;
        ref = await findTarget(app, step.target, 3000);
        v = await performDesktop(run, ref);
      }
      if (v !== undefined) out.push(`#${i} get -> ${JSON.stringify(v).slice(0, 4000)}`);
      if (opts.record && !(a.do === 'get' && !step.target)) opts.record(step);
    } catch (e) {
      out.push(`#${i} ${a.do} FAILED: ${(e as Error).message.split('\n')[0]}`);
      break;
    }
  }
  if (opts.snapshot === false) return out.join('\n') || 'Done.';
  const snap = await snapshotApp(app, { max: opts.max, interactive: opts.interactive }).catch((e) => `(no snapshot: ${(e as Error).message})`);
  return `${out.length ? out.join('\n') + '\n\n' : ''}${snap}`;
}

/** Replays one stored step: finds the element again from its fingerprint. */
export async function runDesktopStep(s: DesktopStep, vars?: Record<string, string>): Promise<string | undefined> {
  const app = s.app ? await resolveApp(s.app) : undefined;
  const ref = s.target && app ? await findTarget(app, s.target) : null;
  return performDesktop({ ...s, app }, ref, vars);
}
