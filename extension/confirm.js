// The confirmation window: shows what is about to be filled, and sends the user's click to the extension.
const id = location.hash.slice(1);
const $ = (x) => document.getElementById(x);

chrome.runtime.sendMessage({ type: 'fillRequest', id }).then(({ request }) => {
  if (!request) { window.close(); return; }
  if (request.title) {
    document.querySelector('h1').textContent = request.title;
    document.title = request.title;
  }
  // A capture or a paste is not a login: its own words for each line.
  const [domainLabel, itemLabel, fieldsLabel] = request.labels || [];
  if (domainLabel) $('l-domain').textContent = domainLabel;
  if (itemLabel) $('l-item').textContent = itemLabel;
  if (fieldsLabel) $('l-fields').textContent = fieldsLabel;
  if (request.note) $('note').textContent = request.note;
  $('domain').textContent = request.domain;
  $('item').textContent = `${request.item} (${request.source})`;
  $('fields').textContent = request.fields.filter((f) => request.totp || f !== 'one-time code').join(', ');
  fit();
  // A click already on its way when the window appeared does not count: the buttons wake up after a moment.
  setTimeout(() => {
    for (const b of ['allow', 'deny']) $(b).disabled = false;
    $('deny').focus();
  }, 800);
}).catch(() => window.close());

const answer = (ok) => chrome.runtime.sendMessage({ type: 'fillAnswer', id, ok }).finally(() => window.close());

// A click counts only after a real press on that same button: a pointer, or Enter / Space on the keyboard.
// An app pressing the button through the accessibility tree sends a bare click, which is ignored.
let pressed = null;
for (const b of ['allow', 'deny']) {
  $(b).addEventListener('pointerdown', (e) => { if (e.isTrusted && ['mouse', 'pen', 'touch'].includes(e.pointerType)) pressed = b; });
  $(b).addEventListener('keydown', (e) => { if (e.isTrusted && (e.key === 'Enter' || e.key === ' ')) pressed = b; });
  $(b).addEventListener('click', (e) => {
    if (!e.isTrusted || pressed !== b) return;
    answer(b === 'allow');
  });
}

// The window takes the height of what it shows: a long vault name, or the browser's own "is debugging" bar
// appearing above the page, must never hide the question or the buttons.
async function fit() {
  const needed = document.documentElement.scrollHeight;
  if (needed <= window.innerHeight) return;
  const win = await chrome.windows.getCurrent();
  const frame = window.outerHeight - window.innerHeight;
  await chrome.windows.update(win.id, { height: Math.min(screen.availHeight, needed + frame + 4) }).catch(() => {});
}
window.addEventListener('resize', () => { fit(); });
