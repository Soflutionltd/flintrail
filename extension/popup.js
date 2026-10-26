const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let tab = null;

async function render() {
  const s = await chrome.storage.local.get(['status', 'statusDetail', 'token', 'port', 'recording']);
  const connected = s.status === 'connected';
  $('dot').className = s.status || '';
  $('status').textContent = connected ? 'Connected to Flintrail.' : (s.statusDetail || 'Not connected.');
  if (!$('token').value && s.token) $('token').value = s.token;
  if (!$('port').value) $('port').value = s.port || 8932;
  $('connect').classList.toggle('hidden', connected);
  $('disconnect').classList.toggle('hidden', !connected);
  $('share').disabled = !connected || !tab;
  if (tab) {
    const { shared } = await send({ type: 'isShared', tabId: tab.id });
    $('share').textContent = shared ? 'Release this tab' : 'Share with agent';
    $('share').dataset.shared = shared ? '1' : '';
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
$('disconnect').onclick = async () => { await send({ type: 'disconnect' }); render(); };
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
