// Replays recorded flows at browser speed, with no LLM in the loop.
// A flow may mix browser steps and desktop steps (do: 'desktop'); a desktop-only flow never opens a tab.
import type { Page } from 'playwright-core';
import { fillVars, getTab, gotoFast, openTab, performOn, performPage, resolveTarget, snapshot, closeTab, forgetSnapshot } from './engine.js';
import { runDesktopStep, snapshotApp } from './desktop.js';
import { signIn } from './login.js';
import { describeShortcut, renderShortcut } from './api-shortcut.js';
import { fetchScript } from './page-scripts.js';
import { config } from './config.js';
import { assertAllowed, domainProblem } from './domains.js';
import { loadFlow, saveFlow } from './store.js';

export interface RunResult {
  ok: boolean;
  tab: string;
  ms: number;
  failedStep?: number;
  outputs: string[];
  text: string;
}

export async function runFlow(name: string, vars: Record<string, string> = {}, tab?: string, opts: { snapshot?: boolean; browser?: string; direct?: boolean } = {}): Promise<RunResult> {
  const flow = loadFlow(name);
  if (opts.direct && !flow.api) throw new Error(`Flow "${name}" has no direct API call (see fl_flow). Run it without direct.`);
  const missing = flow.vars.filter((v) => !(v in vars) && v !== 'password');
  if (missing.length) throw new Error(`Missing variables for "${name}": ${missing.join(', ')}`);
  const t0 = Date.now();
  let id = tab || '';
  let page: Page | null = tab ? getTab(tab) : null;
  const web = async (): Promise<Page> => {
    if (!page) { id = await openTab(undefined, opts.browser); page = getTab(id); }
    return page;
  };
  const outputs: string[] = [];
  let lastApp: string | undefined;
  if (flow.startUrl) await gotoFast(await web(), fillVars(flow.startUrl, vars)!);
  // The request is sent from the page: if the start URL led elsewhere (sign-in, consent), it would go to that site.
  const landed = (p: Page) => { try { return new URL(p.url()).origin; } catch { return ''; } };
  const wanted = flow.startUrl ? new URL(fillVars(flow.startUrl, vars)!).origin : '';
  if (opts.direct && flow.api && landed(await web()) !== wanted) {
    outputs.push(`Direct ${describeShortcut(flow.api)} not sent: the start URL led to ${landed(await web()) || 'another page'}. Replayed through the UI instead.`);
  } else if (opts.direct && flow.api) {
    const what = describeShortcut(flow.api);
    const request = renderShortcut(flow.api, vars);
    // With a list, send the full address: a <base> tag in the page cannot point the path elsewhere.
    if (config.allowedDomains.length) request.url = new URL(request.url, (await web()).url()).href;
    const stopped = (why: string): RunResult => ({
      ok: false, tab: id, ms: Date.now() - t0, outputs,
      // A request that may have reached the site is never sent again through the UI: it could write twice.
      text: `FAILED direct ${what} after ${Date.now() - t0} ms: ${why}\nThe site may have received it. NOT replayed through the UI: check the result on the site first, then fl_run without direct if nothing was written.`,
    });
    let answer: { status: number; contentType: string; body: string; redirectedTo?: string };
    try {
      answer = await (await web()).evaluate(fetchScript, { ...request, max: 20000, manualRedirect: config.allowedDomains.length > 0 });
    } catch (e) {
      return stopped((e as Error).message.split('\n')[0]!);
    }
    // A redirect (expired session sent to the sign-in page) or a page instead of the recorded JSON is not a success.
    if (answer.redirectedTo !== undefined) return stopped(`the site redirected it${answer.redirectedTo ? ` to ${answer.redirectedTo.slice(0, 160)}` : ''} (session expired?)`);
    if (answer.status >= 200 && answer.status < 300 && flow.api.answersJson && !answer.contentType.includes('json')) {
      return stopped(`the site answered ${answer.contentType || 'no content type'} where it answered JSON when recorded`);
    }
    if (answer.status >= 200 && answer.status < 300) {
      const ms = Date.now() - t0;
      flow.runs = (flow.runs || 0) + 1;
      flow.lastMs = ms;
      flow.lastOk = new Date().toISOString();
      saveFlow(flow);
      return {
        ok: true, tab: id, ms, outputs,
        text: `OK "${name}" in ${ms} ms (direct ${what} -> ${answer.status}, UI steps skipped, tab ${id}).\n${answer.body.slice(0, 4000)}`,
      };
    }
    // A 4xx is a refusal (session token, missing header, validation): nothing was written, the UI can take over.
    if (answer.status < 400 || answer.status >= 500) return stopped(`HTTP ${answer.status}: ${answer.body.slice(0, 200)}`);
    outputs.push(`Direct ${what} refused (HTTP ${answer.status}): replayed through the UI instead.`);
  }
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
      // A step may have led to a site outside the user's list: stop there, do and read nothing more.
      assertAllowed(p.url());
      if (s.do === 'login') {
        await signIn(p, { item: s.item, source: s.source, submit: s.submit, account: s.account });
        continue;
      }
      if (!s.target) {
        const v = await performPage(p, s, vars);
        if (v !== undefined) outputs.push(`#${i} ${s.do} -> ${JSON.stringify(v).slice(0, 4000)}`);
        continue;
      }
      const loc = await resolveTarget(p, s.target);
      if (!loc) throw new Error(`element not found (${s.target.role || s.target.tag} "${s.target.name || s.target.text}")`);
      const dest = s.do === 'drag' && s.toTarget ? await resolveTarget(p, s.toTarget) : null;
      if (s.do === 'drag' && !dest) throw new Error('drop target not found');
      const r = await performOn(p, loc, s, vars, dest);
      if (r.download) outputs.push(`#${i} downloaded -> ${r.download}`);
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = (e as Error).message.split('\n')[0];
      const desktop = s.do === 'desktop';
      const where = desktop
        ? (lastApp ? await snapshotApp(lastApp).catch(() => '') : '')
        : page ? await snapshot(page) : '';
      // fl_run_many does not return this page to the agent: its next snapshot of the tab must be the whole page.
      if (page && opts.snapshot === false) forgetSnapshot(page);
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
  } else if (page) tail = domainProblem((page as Page).url()) ? 'Blocked: the tab ended on a site outside the allowed list. Close it with fl_close.' : `URL: ${(page as Page).url()}`;
  const where = id ? `, tab ${id}` : '';
  return { ok: true, tab: id, ms, outputs, text: `OK "${name}" in ${ms} ms (${flow.steps.length} steps${where}).\n${outputs.join('\n')}\n\n${tail}` };
}

/** Runs the same flow for many variable sets in parallel, each in its own background tab. */
export async function runMany(name: string, runs: Record<string, string>[], concurrency = 4, keepTabs = false, browser?: string, direct = false): Promise<string> {
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
        const r = await runFlow(name, runs[i]!, undefined, { snapshot: false, browser, direct });
        if (r.ok) ok++;
        results[i] = `[${i}] ${r.ok ? 'OK' : r.failedStep === undefined ? 'FAILED direct call (not replayed)' : `FAILED step ${r.failedStep}`} ${r.ms} ms ${JSON.stringify(runs[i])}${r.outputs.length ? '\n   ' + r.outputs.join('\n   ') : ''}`;
        if (r.ok && r.tab && !keepTabs) await closeTab(r.tab).catch(() => {});
      } catch (e) {
        results[i] = `[${i}] ERROR ${(e as Error).message.split('\n')[0]}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, runs.length)) }, worker));
  return `${ok}/${runs.length} succeeded in ${Date.now() - t0} ms (concurrency ${concurrency}).\n` + results.join('\n');
}
