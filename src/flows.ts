// Replays recorded flows at browser speed, with no LLM in the loop.
import { fillVars, getTab, gotoFast, openTab, performOn, performPage, resolveTarget, snapshot, closeTab } from './engine.js';
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
  const id = tab || (await openTab());
  const page = getTab(id);
  const outputs: string[] = [];
  if (flow.startUrl) await gotoFast(page, fillVars(flow.startUrl, vars)!);
  for (let i = 0; i < flow.steps.length; i++) {
    const s = flow.steps[i]!;
    try {
      if (!s.target) {
        const v = await performPage(page, s, vars);
        if (v !== undefined) outputs.push(`#${i} ${s.do} -> ${JSON.stringify(v).slice(0, 4000)}`);
        continue;
      }
      const loc = await resolveTarget(page, s.target);
      if (!loc) throw new Error(`element not found (${s.target.role || s.target.tag} "${s.target.name || s.target.text}")`);
      const r = await performOn(page, loc, s, vars);
      if (r.download) outputs.push(`#${i} downloaded -> ${r.download}`);
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = (e as Error).message.split('\n')[0];
      return {
        ok: false, tab: id, ms, failedStep: i, outputs,
        text: `FAILED at step ${i}/${flow.steps.length} (${s.do}) after ${ms} ms: ${msg}\n` +
          `Tab ${id} is left open on that page. To repair: fl_record_start(name="${name}", repairFrom=${i}), redo the rest live, then fl_record_stop.\n\n` +
          (await snapshot(page)),
      };
    }
  }
  const ms = Date.now() - t0;
  flow.runs = (flow.runs || 0) + 1;
  flow.lastMs = ms;
  flow.lastOk = new Date().toISOString();
  saveFlow(flow);
  const tail = opts.snapshot === false ? `URL: ${page.url()}` : await snapshot(page, { text: 400 });
  return { ok: true, tab: id, ms, outputs, text: `OK "${name}" in ${ms} ms (${flow.steps.length} steps, tab ${id}).\n${outputs.join('\n')}\n\n${tail}` };
}

/** Runs the same flow for many variable sets in parallel, each in its own background tab. */
export async function runMany(name: string, runs: Record<string, string>[], concurrency = 4, keepTabs = false): Promise<string> {
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
        if (r.ok && !keepTabs) await closeTab(r.tab).catch(() => {});
      } catch (e) {
        results[i] = `[${i}] ERROR ${(e as Error).message.split('\n')[0]}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, runs.length)) }, worker));
  return `${ok}/${runs.length} succeeded in ${Date.now() - t0} ms (concurrency ${concurrency}).\n` + results.join('\n');
}
