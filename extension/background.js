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

async function connect() {
  const { token, port = 8932 } = await store.get(['token', 'port']);
  if (!token) { await setStatus('idle', 'Paste the token from ~/.flintrail/token'); return; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  await setStatus('connecting');
  const sock = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  ws = sock;
  sock.onopen = () => {
    sock.send(JSON.stringify({
      type: 'hello', token, version: VERSION, userAgent: navigator.userAgent,
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
  return targetInfoFor(tabId);
}

async function detach(tabId) {
  if (!attached.delete(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
  refreshBadge();
}

async function handle(method, p) {
  switch (method) {
    case 'createTab': {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: !p.background });
      const targetInfo = await attach(tab.id);
      if (p.url && p.url !== 'about:blank') chrome.tabs.update(tab.id, { url: p.url });
      return { tabId: tab.id, targetInfo };
    }
    case 'send':
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
        await store.set({ token: msg.token.trim(), port: Number(msg.port) || 8932, autoConnect: true });
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
  const { autoConnect: on = true, token } = await store.get(['autoConnect', 'token']);
  if (on && token) connect();
}
chrome.runtime.onStartup.addListener(autoConnect);
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove('recording');
  chrome.alarms.create('flintrail-reconnect', { periodInMinutes: 0.5 });
  autoConnect();
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'flintrail-reconnect') autoConnect(); });
autoConnect();
