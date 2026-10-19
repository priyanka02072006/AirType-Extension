// Injected into the active page. Hosts the AirType panel (an iframe from the extension,
// which owns the camera + hand tracking) and types the keys it sends into the focused field.
(() => {
  if (window.__airtype) { window.__airtype.toggle(); return; }

  const PANEL_URL = chrome.runtime.getURL('panel.html');
  const EXT_ORIGIN = new URL(PANEL_URL).origin;
  let frame = null;
  let lastEditable = null;
  let pos = null;
  let width = 720;

  // ---------- finding the field to type into ----------
  const BAD_INPUT = /^(checkbox|radio|button|submit|reset|file|image|range|color|hidden)$/i;
  const isEditable = (el) =>
    !!el && ((el.tagName === 'INPUT' && !BAD_INPUT.test(el.type)) || el.tagName === 'TEXTAREA' || el.isContentEditable);

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  document.addEventListener('focusin', (e) => {
    const t = e.composedPath()[0];
    if (isEditable(t)) lastEditable = t;
  }, true);

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function target() {
    const a = deepActive();
    if (isEditable(a)) { lastEditable = a; return a; }
    if (lastEditable && lastEditable.isConnected) { lastEditable.focus({ preventScroll: true }); return lastEditable; }
    const cands = document.querySelectorAll(
      'textarea[name=q],input[name=q],input[type=search],input[type=text],input:not([type]),textarea,[contenteditable=""],[contenteditable="true"]'
    );
    for (const el of cands) {
      if (visible(el)) { el.focus({ preventScroll: true }); lastEditable = el; return el; }
    }
    return null;
  }

  // ---------- typing ----------
  function setNative(el, val) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function insertText(el, text) {
    if (document.execCommand('insertText', false, text)) return;
    if (el.isContentEditable) return;
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? s;
    setNative(el, el.value.slice(0, s) + text + el.value.slice(e));
    try { el.setSelectionRange(s + text.length, s + text.length); } catch (_) {}
  }

  function backspace(el) {
    if (document.execCommand('delete')) return;
    if (el.isContentEditable) return;
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? s;
    if (s !== e) {
      setNative(el, el.value.slice(0, s) + el.value.slice(e));
      try { el.setSelectionRange(s, s); } catch (_) {}
    } else if (s > 0) {
      setNative(el, el.value.slice(0, s - 1) + el.value.slice(s));
      try { el.setSelectionRange(s - 1, s - 1); } catch (_) {}
    }
  }

  function enter(el) {
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const notHandled = el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
    if (!notHandled) return; // the site handled Enter itself (chat apps, search boxes...)
    const form = el.form || el.closest('form');
    if (el.isContentEditable) { document.execCommand('insertParagraph'); return; }
    if (el.tagName === 'TEXTAREA' && !(form && el.name === 'q')) { insertText(el, '\n'); return; }
    if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
  }

  function handleKey(key) {
    const el = target();
    if (!el) { toPanel({ type: 'notarget' }); return; }
    if (key === 'Backspace') backspace(el);
    else if (key === 'Enter') enter(el);
    else insertText(el, key);
  }

  // ---------- panel iframe ----------
  const toPanel = (m) => frame && frame.contentWindow && frame.contentWindow.postMessage({ airtype: 1, ...m }, EXT_ORIGIN);

  function heightFor(w) { return Math.round(w * 0.45) + 36; }

  function place() {
    if (!frame) return;
    const w = Math.min(width, window.innerWidth - 16);
    const h = heightFor(w);
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    if (!pos) pos = { x: (window.innerWidth - w) / 2, y: window.innerHeight - h - 16 };
    pos.x = Math.max(0, Math.min(window.innerWidth - w, pos.x));
    pos.y = Math.max(0, Math.min(window.innerHeight - h, pos.y));
    frame.style.left = pos.x + 'px';
    frame.style.top = pos.y + 'px';
  }

  function create() {
    frame = document.createElement('iframe');
    frame.src = PANEL_URL;
    frame.setAttribute('allow', 'camera');
    frame.setAttribute('title', 'AirType');
    frame.style.cssText =
      'position:fixed!important;z-index:2147483647!important;border:0!important;border-radius:14px!important;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.55)!important;color-scheme:dark!important;background:transparent!important;margin:0!important;padding:0!important;';
    document.documentElement.appendChild(frame);
    place();
    target(); // pre-focus a search box if nothing is focused yet
  }

  function destroy() {
    if (frame) { frame.remove(); frame = null; } // removing the iframe also releases the camera
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== EXT_ORIGIN || !frame || e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.airtype !== 1) return;
    if (m.type === 'key' && typeof m.key === 'string') handleKey(m.key);
    else if (m.type === 'close') destroy();
    else if (m.type === 'resize') { width = +m.w || 720; place(); }
    else if (m.type === 'move') { pos = pos || { x: 0, y: 0 }; pos.x += m.dx; pos.y += m.dy; place(); }
  });

  window.addEventListener('resize', place);

  window.__airtype = { toggle() { frame ? destroy() : create(); } };
  create();
})();
