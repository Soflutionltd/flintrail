// Flintrail extension service worker.
// Connects to the local Flintrail relay (ws://127.0.0.1:<port>/extension) and executes CDP commands
// on tabs with chrome.debugger. Only tabs opened by the agent, or shared from the popup, are attached.
const VERSION = chrome.runtime.getManifest().version;
// Tabs driven through chrome.debugger. The browser keeps them attached when it restarts this service
// worker, so the set lives in session storage too and is read back at startup.
const attached = new Set();
const saveAttached = () => chrome.storage.session.set({ attachedTabs: [...attached] });
const restored = (async () => {
  const { attachedTabs = [] } = await chrome.storage.session.get('attachedTabs');
  const live = new Set((await chrome.debugger.getTargets()).filter((t) => t.attached && typeof t.tabId === 'number').map((t) => t.tabId));
  for (const tabId of attachedTabs) if (live.has(tabId)) attached.add(tabId);
  await saveAttached();
})();
// After this long without the relay, the tabs are released: the debugging bar goes away.
const RELAY_GRACE_MS = 60 * 1000;
let ws = null;
let pingTimer = null;
let reqSeq = 1;
const demoWaiters = new Map();

const store = {
  get: (k) => chrome.storage.local.get(k),
  set: (o) => chrome.storage.local.set(o),
};
// Settings, token and history are for this extension's own pages only, never for its scripts inside web pages.
// When the browser cannot restrict it, password filling stays refused (see fillPolicy).
const storageProtected = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(() => true, () => false);

// The recording tab's content script asks again whether it records (it cannot read the storage).
const notifyRecording = (tabId) => chrome.tabs.sendMessage(tabId, { type: 'recordingChanged' }).catch(() => {});

async function setStatus(status, detail = '') {
  await store.set({ status, statusDetail: detail });
  refreshBadge();
}

async function refreshBadge() {
  const { status, recording } = await store.get(['status', 'recording']);
  if (recording) {
    chrome.action.setBadgeBackgroundColor({ color: '#E5262B' });
    chrome.action.setBadgeText({ text: 'REC' });
  } else if (status === 'connected') {
    chrome.action.setBadgeBackgroundColor({ color: '#FF6A1A' });
    chrome.action.setBadgeText({ text: attached.size ? String(attached.size) : 'ON' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

const HOST_NAME = 'com.soflution.flintrail';

// Ask the local Flintrail for its token through native messaging. The browser only starts the host
// for this extension's ID, so no other extension or web page can read the token this way.
async function pair() {
  // The Chrome Web Store build declares native messaging as optional, granted when the user clicks
  // Connect: without it, pairing is skipped and the pasted token is the way in.
  if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) return false;
  try {
    const r = await chrome.runtime.sendNativeMessage(HOST_NAME, { type: 'pair' });
    if (r?.type !== 'paired' || !r.token) return false;
    await store.set({ token: r.token, port: Number(r.port) || 8932, paired: true });
    return true;
  } catch {
    return false; // Flintrail never ran on this computer, or pairing is turned off: manual token still works.
  }
}

// The name of the browser profile this extension runs in ("Soflution"), asked of the pairing host: started by
// the browser, it may read the browser's profile files when the relay may not. Empty when it cannot tell.
async function profileName(instance) {
  if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) return '';
  try {
    const r = await chrome.runtime.sendNativeMessage(HOST_NAME, { type: 'profile', instance });
    return r?.type === 'profile' ? String(r.name || '').slice(0, 60) : '';
  } catch {
    return '';
  }
}

// Stable per-browser id, so a reconnecting browser keeps its name on the Flintrail side.
async function instanceId() {
  const { instance } = await store.get('instance');
  if (instance) return instance;
  const fresh = crypto.randomUUID();
  await store.set({ instance: fresh });
  return fresh;
}

// One connection attempt at a time: install, startup and the alarm can all fire together, and two
// parallel attempts would open two sockets that answer each other's requests.
let connecting = null;
function connect() {
  if (!connecting) connecting = openConnection().finally(() => { connecting = null; });
  return connecting;
}

async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function openConnection() {
  await restored;
  let { token } = await store.get('token');
  if (!token && await pair()) ({ token } = await store.get('token'));
  if (!token) {
    const canPair = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
    await setStatus('idle', canPair
      ? 'Start Flintrail once on this computer, or paste the token from ~/.flintrail/token'
      : 'Click Connect to pair with Flintrail, or paste the token from ~/.flintrail/token');
    return;
  }
  const { port = 8932, label = '' } = await store.get(['port', 'label']);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const instance = await instanceId();
  const profile = await profileName(instance);
  const cnonce = crypto.randomUUID();
  let welcomed = false;
  await setStatus('connecting');
  const sock = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  ws = sock;
  // The relay sends a challenge: answer with an HMAC of it, so the token itself never travels, then check
  // that the relay knows the token too before obeying it.
  sock.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (!welcomed && m.type === 'challenge') {
      sock.send(JSON.stringify({
        type: 'hello', mac: await hmac(token, 'extension:' + m.nonce), cnonce, version: VERSION, userAgent: navigator.userAgent, instance, label, profile,
        browser: (navigator.userAgentData?.brands || []).map((b) => b.brand).filter((b) => !/Not.A.Brand|Chromium/i.test(b))[0] || 'Chromium',
      }));
      return;
    }
    if (!welcomed && m.type === 'welcome') {
      if (m.mac !== await hmac(token, 'relay:' + cnonce)) { sock.close(); await setStatus('error', 'The program on the relay port is not Flintrail.'); return; }
      welcomed = true;
      quickRetries = 0;
      await store.set({ name: m.name || '' });
      await chrome.storage.session.remove('relayLostAt');
      // Tabs restored after a service worker restart have no use time: count it from now.
      for (const tabId of attached) if (!lastUsed.has(tabId)) lastUsed.set(tabId, Date.now());
      // Back after a service worker restart or a dropped connection: the tabs still attached are kept.
      sock.send(JSON.stringify({ type: 'attached', tabIds: [...attached] }));
    }
    if (welcomed) onMessage(m);
  };
  sock.onclose = async (ev) => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(pingTimer);
    const bad = ev.code === 4401;
    const { autoConnect: on = true } = await store.get('autoConnect');
    if (bad || !on) for (const tabId of [...attached]) await detach(tabId, bad ? 'refused' : 'disconnected');
    else if (attached.size && !(await chrome.storage.session.get('relayLostAt')).relayLostAt) await chrome.storage.session.set({ relayLostAt: Date.now() });
    // The token changed on the Flintrail side (new install, new computer): pair again, then retry.
    if (bad && await pair() && (await store.get('token')).token !== token) { connect(); return; }
    if (!welcomed && (await store.get('status')).status === 'error') return;
    await setStatus(bad ? 'error' : 'disconnected', bad ? 'Wrong token' : 'Flintrail is not running (it starts with your agent).');
    if (!bad) retrySoon();
  };
  sock.onerror = () => {};
}

async function disconnect() {
  await store.set({ autoConnect: false });
  ws?.close();
}

async function onMessage(m) {
  if (m.type === 'welcome') {
    await setStatus('connected', m.recording ? `Recording ${m.recording}` : '');
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), 20000);
    return;
  }
  if (m.type === 'pong') return;
  if (m.type === 'demoResult') {
    demoWaiters.get(m.reqId)?.(m.text);
    demoWaiters.delete(m.reqId);
    return;
  }
  if (typeof m.id !== 'number') return;
  try {
    const result = await handle(m.method, m.params || {});
    send({ id: m.id, result });
  } catch (e) {
    send({ id: m.id, error: String(e?.message || e) });
  }
}

async function targetInfoFor(tabId) {
  try {
    const r = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
    if (r?.targetInfo) return { ...r.targetInfo, browserContextId: r.targetInfo.browserContextId || 'flintrail-default' };
  } catch { /* fall back below */ }
  const tab = await chrome.tabs.get(tabId);
  const t = (await chrome.debugger.getTargets()).find((x) => x.tabId === tabId);
  return {
    targetId: t?.id || `tab-${tabId}`, type: 'page', title: tab.title || '', url: tab.url || 'about:blank',
    attached: true, canAccessOpener: false, browserContextId: 'flintrail-default',
  };
}

// Browser pages and extension pages (this one's settings and confirmation windows included) are never
// driven: an agent must not be able to open the settings and turn the confirmation off by itself.
// Only web pages are allowed (http, https, about:blank), not a list of what is forbidden: view-source:,
// blob:, filesystem: or a leading space would slip through such a list.
function webUrl(url) {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' || u.href === 'about:blank';
  } catch {
    return false;
  }
}
const isProtected = (url) => url !== undefined && url !== '' && !webUrl(url);

async function assertWebTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (isProtected(tab.url) || isProtected(tab.pendingUrl)) throw new Error('Flintrail never drives browser or extension pages.');
}

async function attach(tabId) {
  await assertWebTab(tabId);
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
    await saveAttached();
    refreshBadge();
  }
  lastUsed.set(tabId, Date.now());
  return targetInfoFor(tabId);
}

async function detach(tabId, reason = 'released') {
  lastUsed.delete(tabId);
  if (!attached.delete(tabId)) return;
  await saveAttached();
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
  send({ type: 'detached', tabId, reason });
  refreshBadge();
}

// ---------- agent window ----------
// The agent opens its tabs only in the window the user picked in the popup, never in the window the
// user works in. Window ids change when the browser restarts, so the choice lives in session storage
// and is forgotten on restart rather than pointing at the wrong window.
async function agentWindow() {
  const { agentWindow: id } = await chrome.storage.session.get('agentWindow');
  if (typeof id === 'number') {
    try { await chrome.windows.get(id); return { windowId: id }; } catch { /* closed since */ }
  }
  // No window picked, or it was closed: open one for the agent, in front, so the user sees what the agent
  // opens (a page asking them to confirm a password, say). Later tabs do not take the focus again.
  const win = await chrome.windows.create({ focused: true, url: 'about:blank' });
  await chrome.storage.session.set({ agentWindow: win.id });
  return { windowId: win.id, blankTabId: win.tabs?.[0]?.id };
}

// Where a new agent tab goes: a window the agent named (from listTabs), a new window, or the agent window.
async function placeTab(p) {
  if (p.newWindow) {
    const win = await chrome.windows.create({ focused: false, url: 'about:blank' });
    return { windowId: win.id, blankTabId: win.tabs?.[0]?.id };
  }
  if (typeof p.windowId === 'number') {
    await chrome.windows.get(p.windowId).catch(() => { throw new Error(`Window ${p.windowId} is closed (list windows with fl_extension tabs:true).`); });
    return { windowId: p.windowId };
  }
  return agentWindow();
}

// The debugging bar shows in every window while any tab is driven: release tabs left idle.
const IDLE_RELEASE_MS = 5 * 60 * 1000;
const lastUsed = new Map();
async function releaseIdleTabs() {
  const now = Date.now();
  const { relayLostAt } = await chrome.storage.session.get('relayLostAt');
  const relayGone = !(ws && ws.readyState === WebSocket.OPEN) && relayLostAt && now - relayLostAt > RELAY_GRACE_MS;
  for (const tabId of [...attached]) {
    if (relayGone) { await detach(tabId, 'relay gone'); continue; }
    if (now - (lastUsed.get(tabId) ?? now) < IDLE_RELEASE_MS) continue;
    await detach(tabId, 'idle');
  }
}

async function handle(method, p) {
  switch (method) {
    case 'createTab': {
      if (isProtected(p.url)) throw new Error('Flintrail never opens browser or extension pages.');
      const { windowId, blankTabId } = await placeTab(p);
      // The new tab is the one shown in its window: a background tab behind about:blank looked empty.
      const tab = blankTabId !== undefined
        ? await chrome.tabs.get(blankTabId)
        : await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
      const targetInfo = await attach(tab.id);
      if (p.url && p.url !== 'about:blank') chrome.tabs.update(tab.id, { url: p.url });
      return { tabId: tab.id, targetInfo };
    }
    case 'send':
      if (isProtected(p.params?.url)) throw new Error('Flintrail never opens browser or extension pages.');
      // Checked on every command: the tab may have reached such a page since the last one.
      await assertWebTab(p.tabId);
      lastUsed.set(p.tabId, Date.now());
      return chrome.debugger.sendCommand(p.sessionId ? { tabId: p.tabId, sessionId: p.sessionId } : { tabId: p.tabId }, p.method, p.params);
    case 'closeTab':
      await chrome.tabs.remove(p.tabId).catch(() => {});
      if (attached.delete(p.tabId)) await saveAttached();
      refreshBadge();
      return {};
    case 'release':
      // One conversation is done: release its tabs only, the other conversations keep theirs.
      for (const tabId of p.tabIds || []) await detach(tabId, 'conversation closed');
      return {};
    case 'releaseAll':
      for (const tabId of [...attached]) await detach(tabId, 'conversation closed');
      return {};
    case 'adoptTab':
      return adoptOpenTab(p);
    case 'fillPolicy':
      return fillPolicy(p);
    case 'fillAudit':
      return fillAudit(p);
    case 'listTabs': {
      // Site and title only (no path, no query string): enough to find the window where an account is open.
      const all = await chrome.tabs.query({});
      return all.map((t) => {
        let origin = '';
        try { origin = t.url ? new URL(t.url).origin : ''; } catch { /* chrome:// and the like */ }
        return { window: t.windowId, origin: origin === 'null' ? '' : origin, title: t.title || '', attached: attached.has(t.id) };
      });
    }
    default:
      throw new Error(`Unknown method ${method}`);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!attached.has(source.tabId)) return;
  send({ type: 'event', tabId: source.tabId, sessionId: source.sessionId, method, params });
});

// reason: "target_closed", or "canceled_by_user" when the user closed the debugging bar.
// The browser also says "target_closed" when the tab is still open but debugging it is no longer allowed: most
// often another extension (a password manager) put its own frame in the page. Say so instead of "closed".
async function detachReason(tabId, reason) {
  if (reason !== 'target_closed') return reason === 'canceled_by_user' ? 'debugging cancelled from the browser bar' : reason;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return 'tab closed';
  // The other extension's frame may still be loading when the browser cuts in: try again a moment later.
  let last = '';
  for (const wait of [300, 1000, 2000]) {
    await new Promise((r) => setTimeout(r, wait));
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      await chrome.debugger.detach({ tabId }).catch(() => {});
    } catch (e) {
      last = String(e?.message || e);
      if (/different extension/i.test(last)) {
        return 'another extension (a password manager?) put its own frame in this page, and the browser then stops any extension from driving it. In that extension\'s details (brave://extensions or chrome://extensions), set "Site access" to "On click", then open the page again';
      }
      if (!(await chrome.tabs.get(tabId).catch(() => null))) return 'tab closed';
    }
  }
  return `the browser stopped debugging this tab (it is still open)${last ? `: ${last}` : ''}`;
}

chrome.debugger.onDetach.addListener(async (source, reason) => {
  await restored;
  if (!attached.delete(source.tabId)) return;
  await saveAttached();
  refreshBadge();
  const why = await detachReason(source.tabId, reason);
  // Its address now, so the conversation that drove it can tell which of its tabs this was.
  const url = (await chrome.tabs.get(source.tabId).catch(() => null))?.url || '';
  send({ type: 'detached', tabId: source.tabId, reason: why, url });
});

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.url && isProtected(change.url) && attached.has(tabId)) await detach(tabId, 'browser or extension page');
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await restored;
  if (attached.delete(tabId)) { await saveAttached(); send({ type: 'tabClosed', tabId }); }
  const { recording } = await store.get('recording');
  if (recording?.tabId === tabId) stopDemo();
});

// ---------- the user's open tabs ----------
// An agent may take over a tab the user already has open (fl_adopt), without sharing it first, unless the user
// turned that off or listed the site. Password manager vaults are listed from the start; banks are for the user to add.
const ADOPT_DEFAULTS = {
  adoptOpenTabs: true,
  neverAdopt: ['1password.com', '1password.eu', '1password.ca', 'bitwarden.com', 'bitwarden.eu', 'lastpass.com', 'dashlane.com', 'keepersecurity.com', 'pass.proton.me'],
};

async function adoptSettings() {
  const { adoptSettings: saved } = await store.get('adoptSettings');
  return { ...ADOPT_DEFAULTS, ...(saved || {}) };
}

async function adoptOpenTab(p) {
  if (!(await storageProtected)) return { refused: 'this browser cannot protect the extension settings from web pages, so taking over open tabs stays off' };
  const settings = await adoptSettings();
  if (!settings.adoptOpenTabs) return { refused: 'taking over open tabs is turned off in the Flintrail extension settings: share the tab from the extension instead' };
  const match = String(p.match || '').trim();
  // An empty or tiny address would match any tab, the last one the user looked at included.
  if (match.length < 3) return { refused: 'give at least 3 characters of the tab address' };
  const candidates = (await chrome.tabs.query({}))
    .filter((t) => t.url && t.url.includes(match) && webUrl(t.url) && t.url !== 'about:blank' && !attached.has(t.id));
  const hostOf = (t) => { try { return new URL(t.url).hostname.toLowerCase(); } catch { return ''; } };
  const open = candidates.filter((t) => !hostAllowed(hostOf(t), settings.neverAdopt));
  if (!open.length) {
    return candidates.length ? { refused: `${hostOf(candidates[0])} is in the Flintrail extension's list of sites agents never take over` } : { tabId: null };
  }
  // The one the user looked at last.
  const tab = open.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  const targetInfo = await attach(tab.id);
  return { tabId: tab.id, targetInfo };
}

// ---------- password filling ----------
// The user's settings for the passwords and codes Flintrail fills from their password manager. Only the
// options page writes them; Flintrail asks before every fill, and no Flintrail tool can change them.
const FILL_DEFAULTS = { enabled: true, confirm: false, allDomains: true, domains: [], totp: true };
const CONFIRM_MS = 2 * 60 * 1000;
const HISTORY_MAX = 200;
const pendingFills = new Map();

async function fillSettings() {
  const { fillSettings: saved } = await store.get('fillSettings');
  return { ...FILL_DEFAULTS, ...(saved || {}) };
}

// "github.com" also allows "gist.github.com", never the other way round.
const hostAllowed = (host, list) => list.some((d) => host === d || host.endsWith('.' + d));

async function fillPolicy(p) {
  if (!(await storageProtected)) return { refused: 'this browser cannot protect the extension settings from web pages, so password filling stays off' };
  const settings = await fillSettings();
  const domain = String(p.domain || '').toLowerCase();
  const host = String(p.host || domain).toLowerCase().replace(/^www\./, '');
  if (!settings.enabled) return { refused: 'password filling is turned off' };
  if (!settings.allDomains && !hostAllowed(host, settings.domains)) return { refused: `${host} is not one of the allowed domains` };
  if (!settings.confirm) return { totp: settings.totp };
  const ok = await askUser({ domain, item: String(p.item || ''), source: String(p.source || ''), fields: (p.fields || []).map(String), totp: settings.totp });
  return ok ? { totp: settings.totp, confirmed: true } : { refused: 'the user declined, or did not answer within 2 minutes' };
}

// A small window of this extension asks the user. Only a click there answers: no page and no agent can reach it.
async function askUser(request) {
  const id = crypto.randomUUID();
  const win = await chrome.windows.create({ type: 'popup', focused: true, width: 440, height: 340, url: chrome.runtime.getURL(`confirm.html#${id}`) });
  return new Promise((resolve) => {
    const onClosed = (windowId) => { if (windowId === win.id) done(false); };
    const timer = setTimeout(() => done(false), CONFIRM_MS);
    function done(ok) {
      if (!pendingFills.delete(id)) return;
      clearTimeout(timer);
      chrome.windows.onRemoved.removeListener(onClosed);
      chrome.windows.remove(win.id).catch(() => {});
      resolve(ok);
    }
    chrome.windows.onRemoved.addListener(onClosed);
    pendingFills.set(id, { request, done });
  });
}

async function fillAudit(p) {
  const entry = {
    at: String(p.at || new Date().toISOString()), domain: String(p.domain || ''), item: String(p.item || ''), source: String(p.source || ''),
    filled: (p.filled || []).map(String), approval: String(p.approval || ''),
  };
  const { fillHistory = [] } = await store.get('fillHistory');
  await store.set({ fillHistory: [entry, ...fillHistory].slice(0, HISTORY_MAX) });
  return {};
}

const fromConfirmWindow = (sender) => sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL('confirm.html'));

// ---------- recording by demonstration ----------

function demo(action, extra) {
  return new Promise((resolve) => {
    const reqId = reqSeq++;
    demoWaiters.set(reqId, resolve);
    send({ type: 'demo', action, reqId, ...extra });
    setTimeout(() => { if (demoWaiters.delete(reqId)) resolve('Error: Flintrail did not answer.'); }, 5000);
  });
}

async function startDemo(name, tab) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return 'Error: connect to Flintrail first.';
  const text = await demo('start', { name, url: tab.url });
  if (!text.startsWith('Error')) {
    await store.set({ recording: { name, tabId: tab.id, steps: 0 } });
    notifyRecording(tab.id);
  }
  refreshBadge();
  return text;
}

async function stopDemo() {
  await stepChain;
  const { recording } = await store.get('recording');
  if (!recording) return 'Nothing to stop.';
  await chrome.storage.local.remove('recording');
  notifyRecording(recording.tabId);
  refreshBadge();
  return demo('stop', {});
}

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const { recording } = await store.get('recording');
  if (recording?.tabId !== d.tabId) return;
  if (['typed', 'auto_bookmark', 'generated'].includes(d.transitionType)) recordStep({ do: 'goto', url: d.url });
});

// Steps arrive in bursts (fill then press), so the counter is serialized through one promise chain.
let stepChain = Promise.resolve();
function recordStep(step) {
  stepChain = stepChain.then(async () => {
    const { recording } = await store.get('recording');
    if (!recording) return;
    send({ type: 'recorded', step });
    recording.steps++;
    await store.set({ recording });
  });
  return stepChain;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    // Scripts in web pages may only report recorded steps; everything else comes from the extension's own pages.
    if (sender.id !== chrome.runtime.id || (sender.tab && !fromConfirmWindow(sender) && !['step', 'isRecording'].includes(msg.type))) return reply({});
    switch (msg.type) {
      case 'step': {
        const { recording } = await store.get('recording');
        if (recording && sender.tab?.id === recording.tabId) await recordStep(msg.step);
        return reply({});
      }
      case 'isRecording': {
        const { recording } = await store.get('recording');
        return reply({ recording: !!recording && sender.tab?.id === recording.tabId });
      }
      case 'connect':
        // An empty token field means "pair automatically".
        if (msg.token.trim()) await store.set({ token: msg.token.trim(), port: Number(msg.port) || 8932, autoConnect: true });
        else { await chrome.storage.local.remove('token'); await store.set({ autoConnect: true }); }
        ws?.close();
        ws = null;
        await connect();
        return reply({});
      case 'disconnect':
        await disconnect();
        return reply({});
      case 'setLabel':
        // The name agents use to pick this browser (e.g. "Work" becomes brave-work): reconnect to apply it.
        await store.set({ label: String(msg.label || '').trim().slice(0, 60) });
        ws?.close();
        ws = null;
        await connect();
        return reply({ text: 'Saved.' });
      case 'share': {
        if (!ws || ws.readyState !== WebSocket.OPEN) return reply({ text: 'Error: connect to Flintrail first.' });
        try {
          const targetInfo = await attach(msg.tabId);
          send({ type: 'shared', tabId: msg.tabId, targetInfo });
          return reply({ text: 'Tab shared with your agent.' });
        } catch (e) { return reply({ text: `Error: ${e.message}` }); }
      }
      case 'unshare':
        await detach(msg.tabId, 'unshared');
        return reply({ text: 'Tab released.' });
      case 'isShared':
        return reply({ shared: attached.has(msg.tabId) });
      case 'setAgentWindow':
        await chrome.storage.session.set({ agentWindow: msg.windowId });
        return reply({ text: 'The agent will open its tabs in this window only.' });
      case 'getAgentWindow': {
        const { agentWindow: id } = await chrome.storage.session.get('agentWindow');
        return reply({ windowId: typeof id === 'number' ? id : null });
      }
      case 'fillRequest': {
        if (!fromConfirmWindow(sender)) return reply({});
        return reply({ request: pendingFills.get(msg.id)?.request || null });
      }
      case 'fillAnswer': {
        if (!fromConfirmWindow(sender)) return reply({});
        pendingFills.get(msg.id)?.done(msg.ok === true);
        return reply({});
      }
      case 'demoStart':
        return reply({ text: await startDemo(msg.name, msg.tab) });
      case 'demoStop':
        return reply({ text: await stopDemo() });
    }
  })();
  return true;
});

// The relay is a detached daemon that takes a moment to listen when Flintrail starts, or when a newer
// Flintrail replaces it: retry after 1, 2, 4, 8 and 16 s before leaving it to the 30 s alarm.
let quickRetries = 0;
function retrySoon() {
  if (quickRetries < 5) setTimeout(autoConnect, 1000 * 2 ** quickRetries++);
}

// Reconnect automatically: on browser start, on install, and every 30 s while Flintrail is down.
async function autoConnect() {
  const { autoConnect: on = true } = await store.get('autoConnect');
  if (on) connect();
}
const ensureAlarm = () => chrome.alarms.create('flintrail-reconnect', { periodInMinutes: 0.5 });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); autoConnect(); });
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove('recording');
  ensureAlarm();
  autoConnect();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'flintrail-reconnect') return;
  autoConnect();
  releaseIdleTabs();
});
autoConnect();
