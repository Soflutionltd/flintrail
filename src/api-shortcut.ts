// Direct API replay: when a recorded flow ends on a single write request (the "Confirm" click that
// POSTs an order), the flow can be replayed by sending that request alone, without the UI.
// Everything here is conservative: when the request cannot be tied to the flow with certainty,
// no shortcut is kept and the flow replays through the UI as before.
import type { Step } from './engine.js';
import type { ApiCall } from './recorder.js';

export interface ApiShortcut {
  method: string;
  /** Path and query on the origin of startUrl. A path segment or query value may be {{var}}. */
  url: string;
  contentType?: string;
  /** JSON body template: a string leaf may be {{var}} or {{var:number}}. */
  json?: unknown;
  /** Form body template (application/x-www-form-urlencoded), values may be {{var}}. */
  form?: [string, string][];
  /** The site answered JSON when the flow was recorded: any other kind of answer on replay is not a success. */
  answersJson: boolean;
}

export interface RenderedRequest {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Recorded bodies are cut at this length (recorder.ts): a longer one cannot be replayed. */
export const BODY_LIMIT = 4000;

export const isWrite = (call: ApiCall) => WRITES.has(call.method.toUpperCase());

/** Names of fields that carry a credential or a session token: such a request is never stored. */
const SECRET_NAME = /pass(word|wd|phrase)|secret|token|csrf|xsrf|^auth$|authori[sz]ation|auth[-_]?(key|code)|session|(^|[_-])otp($|[_-])|api[-_]?key|signature|nonce|credential/i;
/** A signed token, or a long unbroken run of key characters (longer than a UUID): a secret whatever its field is called. */
const SECRET_VALUE = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$|^[A-Za-z0-9+/_=-]{40,}$/;
/** Endpoints that only report what the user did: sending one alone is not replaying the flow. */
const TELEMETRY = /(^|[/._-])(analytics|telemetry|beacon|collect|sentry|metrics|rum|logs?|tracking|pixel)([/._?-]|$)/i;

function secretIn(node: unknown, name = ''): string | null {
  if (name && SECRET_NAME.test(name)) return name;
  if (typeof node === 'string') return SECRET_VALUE.test(node) ? name || 'value' : null;
  if (Array.isArray(node)) {
    for (const item of node) { const found = secretIn(item, name); if (found) return found; }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { const found = secretIn(v, k); if (found) return found; }
  }
  return null;
}

const token = (name: string, numeric = false) => `{{${name}${numeric ? ':number' : ''}}}`;

/** Replaces the leaves equal to the recorded value. Returns the new template and how many it replaced. */
function bindJson(node: unknown, literal: string, name: string): { node: unknown; hits: number } {
  if (typeof node === 'string') return node === literal ? { node: token(name), hits: 1 } : { node, hits: 0 };
  if (typeof node === 'number') return String(node) === literal ? { node: token(name, true), hits: 1 } : { node, hits: 0 };
  if (Array.isArray(node)) {
    let hits = 0;
    const out = node.map((item) => { const r = bindJson(item, literal, name); hits += r.hits; return r.node; });
    return { node: out, hits };
  }
  if (node && typeof node === 'object') {
    let hits = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) { const r = bindJson(v, literal, name); hits += r.hits; out[k] = r.node; }
    return { node: out, hits };
  }
  return { node, hits: 0 };
}

function bindUrl(url: string, literal: string, name: string): { url: string; hits: number } {
  const [path = '', query] = url.split('?');
  let hits = 0;
  const same = (raw: string) => {
    try { return decodeURIComponent(raw.replace(/\+/g, ' ')) === literal; } catch { return false; }
  };
  const segments = path.split('/').map((seg) => (seg && same(seg) ? (hits++, token(name)) : seg));
  const pairs = query === undefined ? undefined : query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0 || !same(pair.slice(eq + 1))) return pair;
    hits++;
    return `${pair.slice(0, eq)}=${token(name)}`;
  });
  return { url: segments.join('/') + (pairs ? `?${pairs.join('&')}` : ''), hits };
}

/**
 * Ties a flow variable to the one place of the request that carried its recorded value.
 * Returns null when the value is absent or appears more than once: guessing could write wrong data.
 */
export function bindVariable(shortcut: ApiShortcut, literal: string, name: string): ApiShortcut | null {
  if (literal === '') return null;
  const inUrl = bindUrl(shortcut.url, literal, name);
  const inJson = shortcut.json === undefined ? { node: undefined, hits: 0 } : bindJson(shortcut.json, literal, name);
  let formHits = 0;
  const form = shortcut.form?.map(([k, v]): [string, string] => (v === literal ? (formHits++, [k, token(name)]) : [k, v]));
  if (inUrl.hits + inJson.hits + formHits !== 1) return null;
  return {
    ...shortcut,
    url: inUrl.url,
    ...(shortcut.json !== undefined ? { json: inJson.node } : {}),
    ...(form ? { form } : {}),
  };
}

const isWait = (step: Step) => step.do === 'wait';

/**
 * Looks for the direct request of a recording. `calls` are the write requests seen while recording,
 * `literals` the recorded value of every variable. Returns the shortcut, or the reason there is none
 * (reason is undefined when the recording made no write request at all: nothing to report).
 */
export function findShortcut(input: {
  steps: Step[];
  vars: string[];
  literals: Map<string, string>;
  startUrl: string | null;
  calls: ApiCall[];
  /** Forms the flow submitted by plain navigation: writes a direct request would skip. */
  formPosts: number;
  sensitive: boolean;
  /** Number of tabs the recorded actions ran in. */
  tabs: number;
}): { shortcut?: ApiShortcut; reason?: string } {
  const { steps, vars, literals, startUrl, calls, formPosts, sensitive, tabs } = input;
  if (!calls.length) return {};
  if (sensitive || steps.some((s) => s.do === 'login')) return { reason: 'the flow handles a password' };
  if (steps.some((s) => s.do === 'request')) return {};
  if (steps.some((s) => s.do === 'desktop')) return { reason: 'the flow also drives a desktop app' };
  if (tabs > 1) return { reason: 'the flow works in several tabs' };
  if (formPosts) return { reason: 'the flow also submits a form by page navigation, which a direct request would skip' };
  const skipped = steps.find((s) => s.do === 'eval' || s.do === 'download' || s.do === 'upload');
  if (skipped) return { reason: `the flow has a ${skipped.do} step, which a direct request would skip` };
  if (calls.length > 1) return { reason: `the flow makes ${calls.length} write requests, a direct replay handles exactly one` };
  const call = calls[0]!;
  if (!startUrl) return { reason: 'the flow has no start URL' };
  // A variable that picks the start page may also pick the record the request writes to.
  if (startUrl.includes('{{')) return { reason: 'the start URL holds a variable' };
  if (call.status === undefined) return { reason: 'the request had not been answered when recording stopped' };
  if (call.status < 200 || call.status >= 300) return { reason: `the site answered HTTP ${call.status} to it` };
  if (steps.slice(call.afterStep + 1).some((s) => !isWait(s))) return { reason: 'other actions follow the request in the flow' };

  let origin: string;
  let target: URL;
  try {
    origin = new URL(startUrl.replace(/\{\{\w+\}\}/g, 'x')).origin;
    target = new URL(call.url);
  } catch {
    return { reason: 'its URL could not be read' };
  }
  if (target.origin !== origin) return { reason: `it goes to another site (${target.origin})` };

  // fetch('//host/path') leaves the site.
  if (target.pathname.startsWith('//')) return { reason: 'its path cannot be replayed safely' };
  if (TELEMETRY.test(target.pathname)) return { reason: `it looks like usage reporting (${target.pathname}), not the action itself` };
  const queryNames = Object.fromEntries(target.searchParams);

  let shortcut: ApiShortcut = {
    method: call.method.toUpperCase(),
    url: target.pathname + target.search,
    answersJson: !!call.responseType?.includes('json'),
  };
  const type = (call.requestType || '').split(';')[0]!.trim().toLowerCase();
  // A body Playwright could not read (file, binary) would be replayed empty.
  if (call.postData === undefined && type) return { reason: `its body (${type}) could not be read` };
  if (call.postData !== undefined) {
    if (call.postData.length >= BODY_LIMIT) return { reason: 'its body is too long to be recorded whole' };
    if (type === 'application/json' || type.endsWith('+json')) {
      try { shortcut.json = JSON.parse(call.postData); } catch { return { reason: 'its JSON body could not be read' }; }
    } else if (type === 'application/x-www-form-urlencoded') {
      shortcut.form = [...new URLSearchParams(call.postData)];
    } else {
      return { reason: `its body type (${type || 'unknown'}) cannot be replayed directly` };
    }
    shortcut.contentType = call.requestType;
  }
  // Stored in the flow file in clear: a request that carries a credential or a session token is not kept.
  const secret = secretIn(queryNames) ?? secretIn(shortcut.json) ?? secretIn(Object.fromEntries(shortcut.form ?? []));
  if (secret) return { reason: `its request carries a credential or session token (${secret})` };

  for (const name of vars) {
    const literal = literals.get(name);
    if (literal === undefined) return { reason: `variable "${name}" has no recorded value to find in the request` };
    const bound = bindVariable(shortcut, literal, name);
    if (!bound) return { reason: `the recorded value of variable "${name}" is not found exactly once in the request` };
    shortcut = bound;
  }
  return { shortcut };
}

function valueOf(name: string, vars: Record<string, string>): string {
  if (!(name in vars)) throw new Error(`Missing variable: ${name}`);
  return vars[name]!;
}

function renderJson(node: unknown, vars: Record<string, string>): unknown {
  if (typeof node === 'string') {
    const m = /^\{\{(\w+)(:number)?\}\}$/.exec(node);
    if (!m) return node;
    const value = valueOf(m[1]!, vars);
    if (!m[2]) return value;
    const n = Number(value);
    if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`Variable "${m[1]}" must be a number for the direct API call, got "${value}".`);
    return n;
  }
  if (Array.isArray(node)) return node.map((item) => renderJson(item, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, renderJson(v, vars)]));
  return node;
}

const renderText = (text: string, vars: Record<string, string>, encode: (v: string) => string) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => encode(valueOf(name, vars)));

/** Builds the request to send, each variable escaped for the place it lands in. */
export function renderShortcut(shortcut: ApiShortcut, vars: Record<string, string>): RenderedRequest {
  const request: RenderedRequest = { method: shortcut.method, url: renderText(shortcut.url, vars, encodeURIComponent) };
  // An empty value in the first path segment would turn "/{{v}}/x" into "//x", which is another host.
  if (!request.url.startsWith('/') || request.url.startsWith('//')) throw new Error('The direct request has no valid path with these values (an empty variable?).');
  if (shortcut.json !== undefined) request.body = JSON.stringify(renderJson(shortcut.json, vars));
  else if (shortcut.form) {
    request.body = new URLSearchParams(shortcut.form.map(([k, v]): [string, string] => [k, renderText(v, vars, (x) => x)])).toString();
  }
  if (shortcut.contentType) request.headers = { 'content-type': shortcut.contentType };
  return request;
}

export const describeShortcut = (shortcut: ApiShortcut) => `${shortcut.method} ${shortcut.url.slice(0, 120)}`;
