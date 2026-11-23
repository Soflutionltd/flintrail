// Flintrail extension service worker.
// Connects to the local Flintrail relay (ws://127.0.0.1:<port>/extension) and executes CDP commands
// on tabs with chrome.debugger. Only tabs opened by the agent, or shared from the popup, are attached.
const VERSION = chrome.runtime.getManifest().version;
const attached = new Set();
let ws = null;
let pingTimer = null;
let reqSeq = 1;
const demoWaiters = new Map();

const store = {
  get: (k) => chrome.storage.local.get(k),
  set: (o) => chrome.storage.local.set(o),
};

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
  try {
    const r = await chrome.runtime.sendNativeMessage(HOST_NAME, { type: 'pair' });
    if (r?.type !== 'paired' || !r.token) return false;
    await store.set({ token: r.token, port: Number(r.port) || 8932, paired: true });
    return true;
  } catch {
    return false; // Flintrail never ran on this computer, or pairing is turned off: manual token still works.
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

async function openConnection() {
  let { token } = await store.get('token');
  if (!token && await pair()) ({ token } = await store.get('token'));
  if (!token) { await setStatus('idle', 'Start Flintrail once on this computer, or paste the token from ~/.flintrail/token'); return; }
  const { port = 8932 } = await store.get('port');
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const instance = await instanceId();
  await setStatus('connecting');
  const sock = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  ws = sock;
  sock.onopen = () => {
    sock.send(JSON.stringify({
      type: 'hello', token, version: VERSION, userAgent: navigator.userAgent, instance,
      browser: (navigator.userAgentData?.brands || []).map((b) => b.brand).filter((b) => !/Not.A.Brand|Chromium/i.test(b))[0] || 'Chromium',
    }));
  };
  sock.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  sock.onclose = async (ev) => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(pingTimer);
    for (const tabId of [...attached]) await detach(tabId);
    const bad = ev.code === 4401;
    // The token changed on the Flintrail side (new install, new computer): pair again, then retry.
    if (bad && await pair() && (await store.get('token')).token !== token) { connect(); return; }
    await setStatus(bad ? 'error' : 'disconnected', bad ? 'Wrong token' : 'Flintrail is not running (it starts with your agent).');
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

async function attach(tabId) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
    refreshBadge();
  }
  lastUsed.set(tabId, Date.now());
  return targetInfoFor(tabId);
}

async function detach(tabId) {
  lastUsed.delete(tabId);
  if (!attached.delete(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
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
  // No window picked, or it was closed: open one for the agent, without taking the focus.
  const win = await chrome.windows.create({ focused: false, url: 'about:blank' });
  await chrome.storage.session.set({ agentWindow: win.id });
  return { windowId: win.id, blankTabId: win.tabs?.[0]?.id };
}

// The debugging bar shows in every window while any tab is driven: release tabs left idle.
const IDLE_RELEASE_MS = 5 * 60 * 1000;
const lastUsed = new Map();
async function releaseIdleTabs() {
  const now = Date.now();
  for (const tabId of [...attached]) {
    if (now - (lastUsed.get(tabId) ?? now) < IDLE_RELEASE_MS) continue;
    await detach(tabId);
    send({ type: 'detached', tabId });
  }
}

async function handle(method, p) {
  switch (method) {
    case 'createTab': {
      const { windowId, blankTabId } = await agentWindow();
      const tab = blankTabId !== undefined
        ? await chrome.tabs.get(blankTabId)
        : await chrome.tabs.create({ windowId, url: 'about:blank', active: !p.background });
      const targetInfo = await attach(tab.id);
      if (p.url && p.url !== 'about:blank') chrome.tabs.update(tab.id, { url: p.url });
      return { tabId: tab.id, targetInfo };
    }
    case 'send':
      lastUsed.set(p.tabId, Date.now());
      return chrome.debugger.sendCommand(p.sessionId ? { tabId: p.tabId, sessionId: p.sessionId } : { tabId: p.tabId }, p.method, p.params);
    case 'closeTab':
      await chrome.tabs.remove(p.tabId).catch(() => {});
      attached.delete(p.tabId);
      return {};
    case 'releaseAll':
      for (const tabId of [...attached]) await detach(tabId);
      return {};
    default:
      throw new Error(`Unknown method ${method}`);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!attached.has(source.tabId)) return;
  send({ type: 'event', tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source) => {
  if (!attached.delete(source.tabId)) return;
  send({ type: 'detached', tabId: source.tabId });
  refreshBadge();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (attached.delete(tabId)) send({ type: 'tabClosed', tabId });
  const { recording } = await store.get('recording');
  if (recording?.tabId === tabId) stopDemo();
});

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
  if (!text.startsWith('Error')) await store.set({ recording: { name, tabId: tab.id, steps: 0 } });
  refreshBadge();
  return text;
}

async function stopDemo() {
  await stepChain;
  const { recording } = await store.get('recording');
  if (!recording) return 'Nothing to stop.';
  await chrome.storage.local.remove('recording');
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
      case 'share': {
        if (!ws || ws.readyState !== WebSocket.OPEN) return reply({ text: 'Error: connect to Flintrail first.' });
        try {
          const targetInfo = await attach(msg.tabId);
          send({ type: 'shared', tabId: msg.tabId, targetInfo });
          return reply({ text: 'Tab shared with your agent.' });
        } catch (e) { return reply({ text: `Error: ${e.message}` }); }
      }
      case 'unshare':
        await detach(msg.tabId);
        send({ type: 'detached', tabId: msg.tabId });
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
      case 'demoStart':
        return reply({ text: await startDemo(msg.name, msg.tab) });
      case 'demoStop':
        return reply({ text: await stopDemo() });
    }
  })();
  return true;
});

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
