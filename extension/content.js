// Records what the user does by hand while a demonstration is running, as Flintrail steps.
// Element fingerprints come from the same describe function the engine uses (fingerprint.js).
(() => {
  if (window.__flintrailContent) return;
  window.__flintrailContent = true;
  let recording = false;
  const filled = new WeakMap();
  const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'color', 'range']);

  // Another extension putting its own frame or widget in this page (a password manager's menu): the browser
  // then stops any extension from driving the tab. Said once per page, so an agent driving it is warned first.
  if (window === window.top) {
    const own = chrome.runtime.id;
    let told = false;
    let pending = 0;
    const look = () => {
      pending = 0;
      if (told) return;
      const foreign = [...document.querySelectorAll('iframe[src^="chrome-extension://"], embed[src^="chrome-extension://"]')]
        .map((f) => f.getAttribute('src').split('/')[2]).find((id) => /^[a-p]{32}$/.test(id || '') && id !== own)
        // 1Password puts its widgets at the top of the document, not deep in the page: only those are looked at.
        || ([...(document.body?.children || []), ...document.documentElement.children].some((el) => /^com-1password-/i.test(el.tagName)) ? '1password' : '');
      if (!foreign) return;
      told = true;
      watcher.disconnect();
      chrome.runtime.sendMessage({ type: 'foreignExtension', id: foreign }).catch(() => {});
    };
    // At most once a second, and never again once said: a busy page is not scanned on every change.
    const watcher = new MutationObserver(() => { if (!pending) pending = setTimeout(look, 1000); });
    watcher.observe(document, { childList: true, subtree: true });
  }

  const refresh = () => chrome.runtime.sendMessage({ type: 'isRecording' })
    .then((r) => { recording = !!r?.recording; }).catch(() => { recording = false; });
  refresh();
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (m?.type === 'recordingChanged') refresh();
    // fl_capture_secret: the values of the asked form shown in this frame (text, fields, button labels).
    // Only a frame that has some answers, so the frame that shows the secret is the one heard.
    if (m?.type === 'findSecret' && m.source) {
      let re;
      try { re = new RegExp(m.source, 'g'); } catch { return false; }
      const texts = [document.body?.innerText || ''];
      // Never a password field or a hidden one: only what the page shows.
      const shown = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.getClientRects().length);
      const plain = ':not(input[type=password]):not(input[type=hidden])';
      for (const el of document.querySelectorAll(`input${plain}, textarea`)) if (shown(el)) texts.push(el.value || '');
      for (const el of document.querySelectorAll(`[aria-label]${plain},[title]${plain},[data-clipboard-text]${plain},[value]${plain}`)) {
        if (!shown(el)) continue;
        texts.push(el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.getAttribute('data-clipboard-text') || '', el.getAttribute('value') || '');
      }
      const values = [...new Set(texts.flatMap((t) => t.match(re) || []))];
      if (!values.length) return false;
      reply({ values });
    }
    return false;
  });

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
  // Secrets are never recorded: password fields, one-time code boxes, and any field Flintrail filled with a secret.
  const isPassword = (el) => el instanceof HTMLInputElement && (el.type === 'password' || el.autocomplete === 'one-time-code'
    || el.hasAttribute('data-fl-secret') || /otp|totp|2fa|mfa|one.?time|verification.?code|security.?code/i.test(`${el.name} ${el.id}`)
    || (el.maxLength === 1 && el.inputMode === 'numeric'));

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
