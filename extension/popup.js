const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let tab = null;
let labelLoaded = false;

async function render() {
  const s = await chrome.storage.local.get(['status', 'statusDetail', 'token', 'port', 'recording', 'label', 'name']);
  const connected = s.status === 'connected';
  $('dot').className = s.status || '';
  $('status').textContent = connected ? 'Connected to Flintrail.' : (s.statusDetail || 'Not connected.');
  if (!$('token').value && s.token) $('token').value = s.token;
  if (!$('port').value) $('port').value = s.port || 8932;
  if (!labelLoaded) { $('label').value = s.label || ''; labelLoaded = true; }
  $('nameInfo').textContent = connected && s.name
    ? `Agents pick this browser as "${s.name}".`
    : 'Give each browser or profile a name, so agents pick the right one.';
  $('connect').classList.toggle('hidden', connected);
  $('disconnect').classList.toggle('hidden', !connected);
  $('share').disabled = !connected || !tab;
  if (tab) {
    const { shared } = await send({ type: 'isShared', tabId: tab.id });
    $('share').textContent = shared ? 'Release this tab' : 'Share with agent';
    $('share').dataset.shared = shared ? '1' : '';
  }
  if (tab) {
    const { windowId } = await send({ type: 'getAgentWindow' });
    const isAgent = windowId === tab.windowId;
    $('agentWindow').disabled = isAgent;
    $('agentWindow').textContent = isAgent ? 'This is the agent window' : 'Use this window for the agent';
    $('windowInfo').textContent = isAgent
      ? 'The agent opens its tabs here only.'
      : windowId === null
        ? 'No window picked: the agent opens its own window when it needs one.'
        : 'The agent works in another window, never in this one.';
  }
  const rec = s.recording;
  $('recStart').classList.toggle('hidden', !!rec);
  $('recStop').classList.toggle('hidden', !rec);
  $('recStart').disabled = !connected;
  $('flow').disabled = !!rec;
  if (rec) $('flow').value = rec.name;
  $('recinfo').textContent = rec ? `● Recording "${rec.name}": ${rec.steps} step${rec.steps === 1 ? '' : 's'}` : '';
}

$('connect').onclick = async () => {
  await send({ type: 'connect', token: $('token').value, port: $('port').value });
  setTimeout(render, 400);
};
$('saveLabel').onclick = async () => {
  await send({ type: 'setLabel', label: $('label').value });
  setTimeout(render, 600);
};
$('disconnect').onclick = async () => { await send({ type: 'disconnect' }); render(); };
$('agentWindow').onclick = async () => {
  const r = await send({ type: 'setAgentWindow', windowId: tab.windowId });
  $('msg').textContent = r.text;
  render();
};
$('share').onclick = async () => {
  const r = await send({ type: $('share').dataset.shared ? 'unshare' : 'share', tabId: tab.id });
  $('msg').textContent = r.text;
  render();
};
$('recStart').onclick = async () => {
  const name = $('flow').value.trim().replace(/[^\w.-]+/g, '-');
  if (!name) { $('msg').textContent = 'Give the flow a name first.'; return; }
  const r = await send({ type: 'demoStart', name, tab: { id: tab.id, url: tab.url } });
  $('msg').textContent = r.text.startsWith('Error') ? r.text : 'Do the task in this tab. Click Stop when done.';
  render();
};
$('recStop').onclick = async () => {
  const r = await send({ type: 'demoStop' });
  $('msg').textContent = r.text;
  render();
};

chrome.storage.onChanged.addListener(render);
chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => { tab = t || null; render(); });
