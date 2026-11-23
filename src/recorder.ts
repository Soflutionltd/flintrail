// Records live actions into a replayable flow, and keeps a short log of the site's own API calls.
import type { Page, Request, Response } from 'playwright-core';
import type { Action, Step } from './engine.js';
import type { DesktopStep } from './desktop.js';
import type { TargetDescriptor } from './page-scripts.js';
import { BODY_LIMIT, describeShortcut, findShortcut, isWrite } from './api-shortcut.js';
import { loadFlow, saveFlow, type Flow } from './store.js';

export interface ApiCall {
  id: number;
  method: string;
  url: string;
  status?: number;
  requestType?: string;
  postData?: string;
  responseType?: string;
  sample?: string;
  ms?: number;
  afterStep: number;
}

interface Recording {
  name: string;
  description: string;
  startUrl: string | null;
  steps: Step[];
  repairFrom?: number;
  base?: Flow;
  /** Recorded value of each variable, to find it again in the site's API request. */
  literals: Map<string, string>;
  /** A password went through this recording: its requests are never kept. */
  sensitive: boolean;
  /** Write requests (POST, PUT, PATCH, DELETE) the site made during this recording. */
  writes: ApiCall[];
  /** Forms submitted by plain page navigation (POST), which no fetch/XHR capture sees. */
  formPosts: number;
}

class Recorder {
  private rec: Recording | null = null;
  private calls: ApiCall[] = [];
  private pending = new Map<Request, { call: ApiCall; t0: number }>();
  private seq = 1;
  /** Index of the step being performed: the requests it triggers are tied to it. */
  private current = 0;
  /** False until the first action of the recording: what the start page sends by itself while it loads. */
  private acted = false;
  /** Tab the recorded actions run in: requests of other tabs are not part of the flow. */
  private page: Page | null = null;

  get active() { return this.rec !== null; }

  status(): string | null {
    return this.rec ? `${this.rec.name}: ${this.rec.steps.length} steps` : null;
  }

  start(name: string, description?: string, startUrl?: string, repairFrom?: number): string {
    let base: Flow | undefined;
    if (repairFrom !== undefined) base = loadFlow(name);
    this.rec = {
      name,
      description: description || base?.description || '',
      startUrl: startUrl || base?.startUrl || null,
      steps: [],
      repairFrom,
      base,
      literals: new Map(),
      sensitive: false,
      writes: [],
      formPosts: 0,
    };
    this.current = 0;
    this.acted = false;
    this.page = null;
    return `Recording "${name}" started${repairFrom !== undefined ? ` (repairing from step ${repairFrom})` : ''}. Every fl_open / fl_act / fl_desktop_act from now on is captured.`;
  }

  stop(save: boolean): string {
    if (!this.rec) throw new Error('No recording in progress.');
    const r = this.rec;
    this.rec = null;
    if (!save) return 'Recording discarded.';
    const steps = r.base ? [...r.base.steps.slice(0, r.repairFrom), ...r.steps] : r.steps;
    const vars = [...new Set((JSON.stringify(steps).match(/\{\{(\w+)\}\}/g) || []).map((v) => v.slice(2, -2)))];
    const now = new Date().toISOString();
    // A repaired flow mixes two recordings: its request can no longer be tied to all of its steps.
    const found = r.base
      ? (r.base.api || r.writes.length ? { reason: 'a repaired flow mixes two recordings' } : {})
      : findShortcut({
      steps,
      vars,
      literals: r.literals,
      startUrl: r.startUrl,
      calls: r.writes,
      formPosts: r.formPosts,
      sensitive: r.sensitive,
    });
    saveFlow({
      name: r.name,
      description: r.description,
      startUrl: r.startUrl,
      vars,
      steps,
      ...(found.shortcut ? { api: found.shortcut } : {}),
      createdAt: r.base?.createdAt || now,
      updatedAt: now,
      runs: r.base?.runs || 0,
    });
    const direct = found.shortcut
      ? `\nDirect API call detected: ${describeShortcut(found.shortcut)}. fl_run(direct: true) sends it without the UI steps.`
      : found.reason ? `\nNo direct API call kept: ${found.reason}.` : '';
    return `Flow "${r.name}" saved: ${steps.length} steps, variables: ${vars.join(', ') || 'none'}.${direct}`;
  }

  onOpen(url: string) {
    if (this.rec && this.rec.steps.length === 0 && !this.rec.startUrl) this.rec.startUrl = url;
    else if (this.rec) this.rec.steps.push({ do: 'goto', url });
    if (this.rec) this.current = Math.max(0, this.rec.steps.length - 1);
  }

  /** Called before an action runs, so the requests it triggers are tied to its step. */
  beginAction(page: Page) {
    if (!this.rec) return;
    this.current = this.rec.steps.length;
    this.acted = true;
    this.page = page;
  }

  addStep(_page: Page, step: Step) {
    if (this.rec) this.rec.steps.push(step);
  }

  /** A step on a native desktop app (fl_desktop_act), stored with its element fingerprint. */
  addDesktopStep(step: DesktopStep) {
    if (this.rec) this.rec.steps.push({ do: 'desktop', desktop: step });
  }

  /** Returns a warning when a value was deliberately not recorded. */
  addElementStep(_page: Page, a: Action, target: TargetDescriptor): string | null {
    if (!this.rec) return null;
    if (target.type === 'password') {
      this.rec.sensitive = true;
      return 'password NOT recorded (keep the session logged in instead)';
    }
    const step: Step = { do: a.do, target };
    let warning: string | null = null;
    if (a.files) {
      if (a.var && a.files.length === 1) step.files = [`{{${a.var}}}`];
      else {
        step.files = a.files;
        if (a.var) warning = `var "${a.var}" ignored: a file variable needs exactly one file`;
      }
    } else if (a.value !== undefined) {
      step.value = a.var ? `{{${a.var}}}` : a.value;
      if (a.var) this.rec.literals.set(a.var, a.value);
    }
    if (a.key) step.key = a.key;
    this.rec.steps.push(step);
    return warning;
  }

  /** A step captured by the extension while the user performs the task by hand. */
  addDemoStep(step: Step) {
    if (!this.rec || !step || !step.do) return;
    if (step.target?.type === 'password') {
      this.rec.sensitive = true;
      return;
    }
    const last = this.rec.steps.at(-1);
    // Typing produces several change events on the same field: keep only the final value.
    if (step.do === 'fill' && last?.do === 'fill' && JSON.stringify(last.target) === JSON.stringify(step.target)) {
      last.value = step.value;
      return;
    }
    this.rec.steps.push({ do: step.do, target: step.target, value: step.value, key: step.key });
    this.current = this.rec.steps.length - 1;
  }

  /** True when the request comes from the tab being recorded (or when no action ran yet). */
  private fromRecordedTab(r: Request): boolean {
    if (!this.page) return true;
    try { return r.frame().page() === this.page; } catch { return false; }
  }

  onRequest(r: Request) {
    const type = r.resourceType();
    if (this.rec && type === 'document' && r.method().toUpperCase() !== 'GET' && this.fromRecordedTab(r)) this.rec.formPosts++;
    if (type !== 'fetch' && type !== 'xhr') return;
    const headers = r.headers();
    const call: ApiCall = {
      id: this.seq++,
      method: r.method(),
      url: r.url(),
      requestType: headers['content-type'],
      postData: r.postData()?.slice(0, BODY_LIMIT) || undefined,
      afterStep: this.rec ? this.current : -1,
    };
    // A direct replay opens the start page too, so what that page sends while loading is sent again anyway.
    const sentByStartPage = !!this.rec && !this.acted && this.rec.steps.length === 0;
    if (this.rec && isWrite(call) && this.fromRecordedTab(r) && !sentByStartPage) this.rec.writes.push(call);
    this.pending.set(r, { call, t0: Date.now() });
    this.calls.push(call);
    if (this.calls.length > 200) this.calls.shift();
  }

  async onResponse(res: Response) {
    const p = this.pending.get(res.request());
    if (!p) return;
    this.pending.delete(res.request());
    p.call.status = res.status();
    p.call.ms = Date.now() - p.t0;
    p.call.responseType = res.headers()['content-type'];
    if (p.call.responseType?.includes('json')) {
      p.call.sample = (await res.text().catch(() => '')).slice(0, 300);
    }
  }

  apiCalls(filter?: string, limit = 30): string {
    const list = this.calls
      .filter((c) => !filter || c.url.includes(filter))
      .filter((c) => !/\.(js|css|png|jpe?g|svg|woff2?)(\?|$)/.test(c.url))
      .slice(-limit);
    if (!list.length) return 'No API calls captured yet (fetch/XHR).';
    return list
      .map((c) => `#${c.id} ${c.method} ${c.status ?? '...'} ${c.ms ?? '?'}ms ${c.url.slice(0, 160)}` +
        (c.postData ? `\n   body: ${c.postData.slice(0, 200)}` : '') +
        (c.sample ? `\n   json: ${c.sample.slice(0, 200)}` : ''))
      .join('\n');
  }

  getCall(id: number): ApiCall | undefined {
    return this.calls.find((c) => c.id === id);
  }
}

export const recorder = new Recorder();
