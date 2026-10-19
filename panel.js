'use strict';
// AirType panel: camera -> MediaPipe Hands -> pinch / dwell on an on-screen keyboard -> keys posted to the page.

const $ = (s) => document.querySelector(s);
const post = (m) => parent.postMessage({ airtype: 1, ...m }, '*');

const SIZES = [560, 720, 900];
const S = { dark: 'auto', mode: 'pinch', size: 1, boost: 1 };
const store = {
  async load() { try { const v = await chrome.storage.local.get('airtype'); Object.assign(S, v.airtype || {}); } catch (_) {} },
  save() { try { chrome.storage.local.set({ airtype: S }); } catch (_) {} },
};

// ---------- keyboard ----------
const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', { k: 'Backspace', l: '⌫', w: 1.6 }],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', { k: 'Enter', l: '⏎', w: 1.8 }],
  [{ k: 'Shift', l: '⇧', w: 1.5 }, 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '?'],
  ['@', '-', "'", { k: ' ', l: 'space', w: 5 }, '/', '!'],
];
const SHIFT = { 1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')', ',': ';', '.': ':', '-': '_', "'": '"', '/': '\\' };

const stage = $('#stage'), kb = $('#kb'), view = $('#view'), fx = $('#fx'), video = $('#video'), statusEl = $('#status');
const vctx = view.getContext('2d'), fctx = fx.getContext('2d');
const cam = document.createElement('canvas'); cam.width = 640; cam.height = 480;
const cctx = cam.getContext('2d', { willReadFrequently: true });
const luma = document.createElement('canvas'); luma.width = 32; luma.height = 24;
const lctx = luma.getContext('2d', { willReadFrequently: true });

const keyEls = [];
let rects = [];
let shift = false;

function build() {
  kb.innerHTML = ''; keyEls.length = 0;
  for (const row of ROWS) {
    const r = document.createElement('div'); r.className = 'row';
    for (const def of row) {
      const d = typeof def === 'string' ? { k: def } : def;
      const el = document.createElement('div');
      el.className = 'key'; el.style.flex = `${d.w || 1} 1 0`; el._def = d;
      r.appendChild(el); keyEls.push(el);
    }
    kb.appendChild(r);
  }
  labels();
}
function labels() {
  for (const el of keyEls) {
    const d = el._def;
    let t = d.l || d.k;
    if (!d.l && shift) t = /^[a-z]$/.test(d.k) ? d.k.toUpperCase() : (SHIFT[d.k] || d.k);
    el.textContent = t;
    if (d.k === 'Shift') el.classList.toggle('on', shift);
  }
}

// ---------- layout / mapping ----------
let stageW = 1, stageH = 1;
const reg = { x: 0.08, y: 0.3, w: 0.84, h: 0.5 }; // part of the camera frame that maps onto the keyboard

function layout() {
  stageW = stage.clientWidth; stageH = stage.clientHeight;
  view.width = fx.width = stageW; view.height = fx.height = stageH;
  const A = stageW / stageH;
  reg.w = 0.84;
  reg.h = Math.min(0.92, reg.w * (cam.width / cam.height) / A);
  reg.x = (1 - reg.w) / 2;
  reg.y = Math.min(0.3, 1 - reg.h);
  const sb = stage.getBoundingClientRect();
  rects = keyEls.map((el) => { const b = el.getBoundingClientRect(); return { el, x: b.left - sb.left, y: b.top - sb.top, w: b.width, h: b.height }; });
}
new ResizeObserver(layout).observe(stage);

function keyAt(x, y) {
  let best = null, bd = 1e9;
  for (const r of rects) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
    const d = Math.hypot(x - (r.x + r.w / 2), y - (r.y + r.h / 2));
    if (d < bd) { bd = d; best = r; }
  }
  return bd < 45 ? best : null;
}

// ---------- feedback ----------
let ac;
function click() {
  try {
    ac = ac || new AudioContext(); ac.resume();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.04);
  } catch (_) {}
}
function setStatus(t, cls = '') { statusEl.textContent = t; statusEl.className = cls; }

// ---------- pressing keys ----------
function press(el) {
  const k = el._def.k;
  el.classList.add('down'); setTimeout(() => el.classList.remove('down'), 160);
  click();
  if (k === 'Shift') { shift = !shift; labels(); return; }
  let out = k;
  if (k.length === 1 && shift) out = /^[a-z]$/.test(k) ? k.toUpperCase() : (SHIFT[k] || k);
  post({ type: 'key', key: out });
  if (k.length === 1 && shift) { shift = false; labels(); }
}

// ---------- hand tracking ----------
let hands, running = false, frameN = 0, track = null, stream = null;
let gain = 1, lastL = 128, darkOn = false, lowCount = 0;
let hover = null, hist = [], lastSeen = 0, lastPress = 0, pinching = false;
let sx = 0, sy = 0, hasSmooth = false;
let dwellEl = null, dwellStart = 0, lockEl = null;
const DWELL_MS = 750;

function setHover(el) {
  if (hover === el) return;
  if (hover) { hover.classList.remove('hover'); hover.style.removeProperty('--dwell'); }
  hover = el; if (el) el.classList.add('hover');
}

function posAt(t) {
  let best = hist[hist.length - 1];
  for (const h of hist) if (Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
  return best;
}

function onResults(res) {
  const now = performance.now();
  fctx.clearRect(0, 0, stageW, stageH);
  const lm = res.multiHandLandmarks && res.multiHandLandmarks[0];
  if (!lm) {
    if (now - lastSeen > 500) {
      setHover(null); pinching = false; dwellEl = null; hasSmooth = false; hist = [];
      if (!statusEl.classList.contains('err')) setStatus('Show your hand to the camera', darkOn ? 'ok' : '');
    }
    return;
  }
  lastSeen = now;
  const map = (p) => ({
    x: Math.max(0, Math.min(stageW, (1 - (p.x - reg.x) / reg.w) * stageW)),
    y: Math.max(0, Math.min(stageH, ((p.y - reg.y) / reg.h) * stageH)),
  });
  const tip = map(lm[8]), thumb = map(lm[4]);
  if (!hasSmooth) { sx = tip.x; sy = tip.y; hasSmooth = true; }
  else { sx += (tip.x - sx) * 0.55; sy += (tip.y - sy) * 0.55; }

  const W = cam.width, H = cam.height;
  const pinchD = Math.hypot((lm[4].x - lm[8].x) * W, (lm[4].y - lm[8].y) * H);
  const palm = Math.hypot((lm[0].x - lm[9].x) * W, (lm[0].y - lm[9].y) * H) || 1;
  const ratio = pinchD / palm;

  hist.push({ t: now, x: sx, y: sy });
  while (hist.length && now - hist[0].t > 400) hist.shift();

  const hit = keyAt(sx, sy);
  setHover(hit ? hit.el : null);

  if (S.mode === 'pinch') {
    if (!pinching && ratio < 0.3 && now - lastPress > 250) {
      pinching = true; lastPress = now;
      const p = posAt(now - 140);
      const r = keyAt(p.x, p.y);
      if (r) press(r.el);
    } else if (pinching && ratio > 0.45) pinching = false;
    setStatus(ratio < 0.45 ? 'Pinch!' : 'Point at a key, then pinch thumb + index', darkOn ? 'ok' : '');
  } else {
    const el = hit ? hit.el : null;
    if (el !== dwellEl) { if (dwellEl) dwellEl.style.removeProperty('--dwell'); dwellEl = el; dwellStart = now; if (el !== lockEl) lockEl = null; }
    if (el) {
      const p = Math.min(1, (now - dwellStart) / DWELL_MS);
      el.style.setProperty('--dwell', p);
      if (p >= 1 && lockEl !== el) { lockEl = el; press(el); }
    }
    setStatus('Hold your fingertip on a key', darkOn ? 'ok' : '');
  }

  // fingertip cursor + thumb dot
  fctx.lineWidth = 3;
  fctx.strokeStyle = darkOn ? '#0a7a52' : '#7cf5c4';
  fctx.fillStyle = fctx.strokeStyle;
  fctx.beginPath(); fctx.moveTo(sx, sy); fctx.lineTo(thumb.x, thumb.y); fctx.stroke();
  fctx.beginPath(); fctx.arc(thumb.x, thumb.y, 6, 0, 7); fctx.fill();
  fctx.beginPath(); fctx.arc(sx, sy, ratio < 0.45 ? 9 : 14, 0, 7); fctx.stroke();
}

// ---------- low light ----------
function measureLuma() {
  lctx.drawImage(video, 0, 0, 32, 24);
  const d = lctx.getImageData(0, 0, 32, 24).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  lastL = s / (d.length / 4);
  darkTick();
}
function setDark(on) {
  if (on === darkOn) return;
  darkOn = on;
  document.body.classList.toggle('light', on);
  applyCaps(on);
}
function darkTick() {
  if (S.dark === 'on') return setDark(true);
  if (S.dark === 'off') return setDark(false);
  if (!darkOn) { if (lastL < 60) { if (++lowCount >= 3) setDark(true); } else lowCount = 0; }
  else if (lastL > 140) setDark(false);
}
async function applyCaps(dark) {
  if (!track) return;
  try {
    const c = (track.getCapabilities && track.getCapabilities()) || {};
    const adv = {};
    if (c.exposureMode && c.exposureMode.includes('continuous')) adv.exposureMode = 'continuous';
    if (c.exposureCompensation) adv.exposureCompensation = dark ? c.exposureCompensation.max : 0;
    if (c.frameRate) adv.frameRate = dark ? Math.min(15, c.frameRate.max) : Math.min(30, c.frameRate.max); // slower fps = longer exposure
    await track.applyConstraints({ advanced: [adv] });
  } catch (_) {}
}

// ---------- main loop ----------
async function loop() {
  if (!running) return;
  if (video.readyState >= 2) {
    frameN++;
    if (frameN % 8 === 0) {
      measureLuma();
      const target = Math.max(1, Math.min(5, 105 / Math.max(lastL, 6)));
      gain += (target - gain) * 0.35;
    }
    cctx.filter = `brightness(${(gain * S.boost).toFixed(2)}) contrast(1.15)`;
    cctx.drawImage(video, 0, 0, cam.width, cam.height);
    cctx.filter = 'none';
    vctx.drawImage(cam, reg.x * cam.width, reg.y * cam.height, reg.w * cam.width, reg.h * cam.height, 0, 0, stageW, stageH);
    try { await hands.send({ image: cam }); } catch (e) { console.warn(e); }
  }
  requestAnimationFrame(loop);
}

// ---------- camera ----------
function camError(e) {
  const msg = e && e.name === 'NotFoundError' ? 'No camera found.' :
    e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'Camera access is blocked. Click “Allow camera”, press Allow, then reopen AirType.' :
    'Could not start the camera: ' + (e && e.message);
  $('#camErrMsg').textContent = msg;
  $('#camErr').hidden = false;
  setStatus('Camera unavailable', 'err');
}

async function startCam() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false,
    });
  } catch (e) { camError(e); return false; }
  video.srcObject = stream;
  await video.play();
  track = stream.getVideoTracks()[0];
  return true;
}

// ---------- UI wiring ----------
function paintButtons() {
  $('#bDark').textContent = '🌙 ' + { auto: 'Auto', on: 'On', off: 'Off' }[S.dark];
  $('#bMode').textContent = S.mode === 'pinch' ? 'Pinch' : 'Dwell';
  $('#boost').value = S.boost;
}
$('#bDark').onclick = () => { S.dark = { auto: 'on', on: 'off', off: 'auto' }[S.dark]; paintButtons(); store.save(); lowCount = 0; darkTick(); };
$('#bMode').onclick = () => { S.mode = S.mode === 'pinch' ? 'dwell' : 'pinch'; pinching = false; paintButtons(); store.save(); };
$('#bSize').onclick = () => { S.size = (S.size + 1) % SIZES.length; post({ type: 'resize', w: SIZES[S.size] }); store.save(); };
$('#bClose').onclick = () => post({ type: 'close' });
$('#boost').oninput = (e) => { S.boost = +e.target.value; store.save(); };
$('#bAllow').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });

const bar = $('#bar');
let drag = null;
bar.addEventListener('pointerdown', (e) => { if (e.target.closest('button,input')) return; drag = { x: e.screenX, y: e.screenY }; bar.setPointerCapture(e.pointerId); });
bar.addEventListener('pointermove', (e) => { if (!drag) return; post({ type: 'move', dx: e.screenX - drag.x, dy: e.screenY - drag.y }); drag = { x: e.screenX, y: e.screenY }; });
bar.addEventListener('pointerup', () => { drag = null; });

window.addEventListener('message', (e) => {
  if (e.source !== parent || !e.data || e.data.airtype !== 1) return;
  if (e.data.type === 'notarget') setStatus('Click a text box on the page first', 'warn');
});

// ---------- boot ----------
(async function init() {
  await store.load();
  paintButtons();
  build();
  post({ type: 'resize', w: SIZES[S.size] });
  layout();
  setStatus('Starting camera…');
  if (!(await startCam())) return;
  if (typeof Hands === 'undefined') { setStatus('Hand model failed to load', 'err'); return; }
  setStatus('Loading hand model…');
  hands = new Hands({ locateFile: (f) => chrome.runtime.getURL('lib/' + f) });
  hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.4, minTrackingConfidence: 0.4, selfieMode: false });
  hands.onResults(onResults);
  try { await hands.initialize(); } catch (e) { setStatus('Hand model failed: ' + e.message, 'err'); return; }
  setStatus('Show your hand to the camera');
  running = true;
  loop();
})();

window.addEventListener('pagehide', () => { running = false; if (stream) stream.getTracks().forEach((t) => t.stop()); });
