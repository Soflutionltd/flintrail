// Replays recorded flows at browser speed, with no LLM in the loop.
// A flow may mix browser steps and desktop steps (do: 'desktop'); a desktop-only flow never opens a tab.
import type { Page } from 'playwright-core';
import { fillVars, getTab, gotoFast, openTab, performOn, performPage, resolveTarget, snapshot, closeTab } from './engine.js';
import { runDesktopStep, snapshotApp } from './desktop.js';
import { signIn } from './login.js';
import { loadFlow, saveFlow } from './store.js';

export interface RunResult {
  ok: boolean;
  tab: string;
  ms: number;
  failedStep?: number;
  outputs: string[];
  text: string;
}

export async function runFlow(name: string, vars: Record<string, string> = {}, tab?: string, opts: { snapshot?: boolean } = {}): Promise<RunResult> {
  const flow = loadFlow(name);
  const missing = flow.vars.filter((v) => !(v in vars) && v !== 'password');
  if (missing.length) throw new Error(`Missing variables for "${name}": ${missing.join(', ')}`);
  const t0 = Date.now();
  let id = tab || '';
  let page: Page | null = tab ? getTab(tab) : null;
  const web = async (): Promise<Page> => {
    if (!page) { id = await openTab(); page = getTab(id); }
    return page;
  };
  const outputs: string[] = [];
  let lastApp: string | undefined;
  if (flow.startUrl) await gotoFast(await web(), fillVars(flow.startUrl, vars)!);
  for (let i = 0; i < flow.steps.length; i++) {
    const s = flow.steps[i]!;
    try {
      if (s.do === 'desktop' && s.desktop) {
        if (s.desktop.app) lastApp = s.desktop.app;
        const v = await runDesktopStep(s.desktop, vars);
        if (v !== undefined) outputs.push(`#${i} get -> ${JSON.stringify(v).slice(0, 4000)}`);
        continue;
      }
      const p = await web();
      if (s.do === 'login') {
        await signIn(p, { item: s.item, source: s.source, submit: s.submit });
        continue;
      }
      if (!s.target) {
        const v = await performPage(p, s, vars);
        if (v !== undefined) outputs.push(`#${i} ${s.do} -> ${JSON.stringify(v).slice(0, 4000)}`);
        continue;
      }
      const loc = await resolveTarget(p, s.target);
      if (!loc) throw new Error(`element not found (${s.target.role || s.target.tag} "${s.target.name || s.target.text}")`);
      const r = await performOn(p, loc, s, vars);
      if (r.download) outputs.push(`#${i} downloaded -> ${r.download}`);
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = (e as Error).message.split('\n')[0];
      const desktop = s.do === 'desktop';
      const where = desktop
        ? (lastApp ? await snapshotApp(lastApp).catch(() => '') : '')
        : page ? await snapshot(page) : '';
      return {
        ok: false, tab: id, ms, failedStep: i, outputs,
        text: `FAILED at step ${i}/${flow.steps.length} (${desktop ? `desktop ${s.desktop?.do}` : s.do}) after ${ms} ms: ${msg}\n` +
          (desktop ? `${lastApp ? `${lastApp} is left as it is.` : ''}` : `Tab ${id} is left open on that page.`) +
          ` To repair: fl_record_start(name="${name}", repairFrom=${i}), redo the rest live, then fl_record_stop.\n\n` + where,
      };
    }
  }
  const ms = Date.now() - t0;
  flow.runs = (flow.runs || 0) + 1;
  flow.lastMs = ms;
  flow.lastOk = new Date().toISOString();
  saveFlow(flow);
  let tail = '';
  if (opts.snapshot !== false) {
    const last = flow.steps.at(-1);
    tail = last?.do === 'desktop' && lastApp
      ? await snapshotApp(lastApp, { max: 60 }).catch(() => '')
      : page ? await snapshot(page, { text: 400 }) : '';
  } else if (page) tail = `URL: ${(page as Page).url()}`;
  const where = id ? `, tab ${id}` : '';
  return { ok: true, tab: id, ms, outputs, text: `OK "${name}" in ${ms} ms (${flow.steps.length} steps${where}).\n${outputs.join('\n')}\n\n${tail}` };
}

/** Runs the same flow for many variable sets in parallel, each in its own background tab. */
export async function runMany(name: string, runs: Record<string, string>[], concurrency = 4, keepTabs = false): Promise<string> {
  const flow = loadFlow(name);
  // Desktop steps drive one shared app: run them one at a time.
  if (flow.steps.some((s) => s.do === 'desktop')) concurrency = 1;
  const t0 = Date.now();
  const results: string[] = new Array(runs.length);
  let next = 0;
  let ok = 0;
  const worker = async () => {
    while (next < runs.length) {
      const i = next++;
      try {
        const r = await runFlow(name, runs[i]!, undefined, { snapshot: false });
        if (r.ok) ok++;
        results[i] = `[${i}] ${r.ok ? 'OK' : `FAILED step ${r.failedStep}`} ${r.ms} ms ${JSON.stringify(runs[i])}${r.outputs.length ? '\n   ' + r.outputs.join('\n   ') : ''}`;
        if (r.ok && r.tab && !keepTabs) await closeTab(r.tab).catch(() => {});
      } catch (e) {
        results[i] = `[${i}] ERROR ${(e as Error).message.split('\n')[0]}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, runs.length)) }, worker));
  return `${ok}/${runs.length} succeeded in ${Date.now() - t0} ms (concurrency ${concurrency}).\n` + results.join('\n');
}
