// Records what the user does by hand while a demonstration is running, as Flintrail steps.
// Element fingerprints come from the same describe function the engine uses (fingerprint.js).
(() => {
  if (window.__flintrailContent) return;
  window.__flintrailContent = true;
  let recording = false;
  const filled = new WeakMap();
  const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'color', 'range']);

  const refresh = () => chrome.runtime.sendMessage({ type: 'isRecording' })
    .then((r) => { recording = !!r?.recording; }).catch(() => { recording = false; });
  refresh();
  chrome.storage.onChanged.addListener((c) => { if (c.recording) refresh(); });

  const describe = (el) => {
    const t = self.flintrailDescribe(el);
    if (window !== window.top) t.frameUrl = location.href.split('?')[0];
    return t;
  };
  const emit = (step) => { if (recording) chrome.runtime.sendMessage({ type: 'step', step }).catch(() => {}); };

  const isTextField = (el) =>
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type)) ||
    el?.isContentEditable;
  const isToggle = (el) => el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
  const isPassword = (el) => el instanceof HTMLInputElement && el.type === 'password';

  const fillStep = (el) => {
    const value = el.isContentEditable ? el.innerText : el.value;
    if (filled.get(el) === value) return;
    filled.set(el, value);
    emit({ do: 'fill', target: describe(el), value });
  };

  const CLICKABLE = 'a,button,summary,select,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],input[type=submit],input[type=button],input[type=reset],input[type=image],[onclick],[tabindex]';

  document.addEventListener('click', (e) => {
    if (!recording || !e.isTrusted) return;
    const raw = e.composedPath()[0];
    if (!(raw instanceof Element)) return;
    if (isTextField(raw) || isPassword(raw) || isToggle(raw) || raw instanceof HTMLSelectElement || raw instanceof HTMLOptionElement) return;
    const el = raw.closest(CLICKABLE) || raw;
    if (el instanceof HTMLLabelElement && (el.control && (isToggle(el.control) || isTextField(el.control)))) return;
    if (el instanceof HTMLSelectElement) return;
    // A pending text value must be recorded before the click that submits it.
    const active = document.activeElement;
    if (active && active !== el && isTextField(active) && !isPassword(active)) fillStep(active);
    emit({ do: e.detail === 2 ? 'dblclick' : 'click', target: describe(el) });
  }, true);

  document.addEventListener('change', (e) => {
    if (!recording || !e.isTrusted) return;
    const el = e.target;
    if (!(el instanceof Element) || isPassword(el)) return;
    if (el instanceof HTMLSelectElement) emit({ do: 'select', target: describe(el), value: el.value });
    else if (isToggle(el)) emit({ do: el.checked || el.type === 'radio' ? 'check' : 'uncheck', target: describe(el) });
    else if (isTextField(el)) fillStep(el);
  }, true);

  document.addEventListener('focusout', (e) => {
    if (recording && e.isTrusted && e.target?.isContentEditable) fillStep(e.target);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!recording || !e.isTrusted) return;
    const el = e.target;
    if (!(el instanceof Element) || isPassword(el)) return;
    if ((e.key === 'Enter' && !(el instanceof HTMLTextAreaElement)) || e.key === 'Escape' || e.key === 'Tab') {
      if (isTextField(el)) fillStep(el);
      if (e.key !== 'Tab') emit({ do: 'press', target: describe(el), key: e.key });
    }
  }, true);
})();
