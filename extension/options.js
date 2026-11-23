// Settings page: the only place where the password filling settings change.
const $ = (id) => document.getElementById(id);
const DEFAULTS = { enabled: true, confirm: false, allDomains: true, domains: [], totp: true };

// Bare domains only: "https://www.GitHub.com/login" becomes "github.com".
function cleanDomain(line) {
  const host = line.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0].replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(host) ? host : '';
}

async function load() {
  const { fillSettings } = await chrome.storage.local.get('fillSettings');
  const s = { ...DEFAULTS, ...(fillSettings || {}) };
  for (const k of ['enabled', 'confirm', 'totp', 'allDomains']) $(k).checked = s[k];
  $('domains').value = s.domains.join('\n');
  $('domains').disabled = s.allDomains;
}

async function save() {
  const domains = [...new Set($('domains').value.split('\n').map(cleanDomain).filter(Boolean))];
  const fillSettings = { enabled: $('enabled').checked, confirm: $('confirm').checked, totp: $('totp').checked, allDomains: $('allDomains').checked, domains };
  await chrome.storage.local.set({ fillSettings });
  $('domains').disabled = fillSettings.allDomains;
  $('saved').textContent = 'Saved.';
  setTimeout(() => { $('saved').textContent = ''; }, 1500);
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

async function renderHistory() {
  const { fillHistory = [] } = await chrome.storage.local.get('fillHistory');
  const body = $('history');
  body.replaceChildren(...fillHistory.map((h) => {
    const tr = document.createElement('tr');
    tr.append(cell(new Date(h.at).toLocaleString()), cell(h.domain), cell(`${h.item} (${h.source})`), cell(h.filled.join(', ')), cell(h.approval));
    return tr;
  }));
  $('empty').hidden = fillHistory.length > 0;
}

// A change counts only right after a real press or keystroke in this page: an app toggling a box through the
// accessibility tree (to turn the confirmation off, say) is undone.
let gestureAt = 0;
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, (e) => { if (e.isTrusted) gestureAt = Date.now(); }, true);
const guarded = (fn) => () => (Date.now() - gestureAt < 2000 ? fn() : load());
for (const id of ['enabled', 'confirm', 'totp', 'allDomains']) $(id).addEventListener('change', guarded(save));
$('domains').addEventListener('change', guarded(save));
$('clear').addEventListener('click', async () => { await chrome.storage.local.set({ fillHistory: [] }); renderHistory(); });
chrome.storage.onChanged.addListener((changes) => { if (changes.fillHistory) renderHistory(); });
load();
renderHistory();
