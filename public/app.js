/* ============================================================
   WorkAlert — Client
   ============================================================ */

/* ─────────── STATE ─────────── */
let token   = localStorage.getItem('wa_token');
let me      = null;
let groups  = [];
let current = null;
let sse     = null;
let dark    = localStorage.getItem('wa_theme') === 'dark';
let swReg   = null;
let pollId  = null;
let seenIds = new Set();

const ALARM_SECONDS = 2;                      // in-app alarm length
const ALARM_LEVEL   = 0.42;                   // medium volume (0..1)
const ALERT_TITLE   = 'Jamun Is Coming ⚠️';   // wording shown everywhere

const lastTs = {
  get()  { return Number(localStorage.getItem('wa_lastTs') || 0); },
  set(v) { if (v > this.get()) localStorage.setItem('wa_lastTs', String(v)); }
};

/* ─────────── tiny IndexedDB (shared with the Service Worker) ─────────── */
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('workalert', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', mode);
      let out;
      try { out = fn(tx.objectStore('kv')); } catch (e) { reject(e); return; }
      tx.oncomplete = () => { db.close(); resolve(out?.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
const kvSet = (k, v) => idb('readwrite', s => s.put(v, k)).catch(() => {});

/* ─────────── ALARM (2s, medium, unlocks itself) ─────────── */
class Alarm {
  constructor() { this.ctx = null; this.bus = null; this.nodes = []; this.keepAlive = null; }

  ctxReady() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.bus = this.ctx.createGain();
      this.bus.gain.value = ALARM_LEVEL;
      this.bus.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /* A silent looping source keeps the context awake on mobile */
  unlock() {
    const ctx = this.ctxReady();
    if (!ctx || this.keepAlive) return;
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(g); g.connect(ctx.destination);
    try { src.start(); this.keepAlive = src; } catch (_) {}
  }

  /* Clean two-note chime. Pure sine with soft edges — no rasp,
     no tremolo. The shaking comes from the motor, not the tone. */
  play(seconds = ALARM_SECONDS, withBuzz = true) {
    const ctx = this.ctxReady();
    if (!ctx) return;
    this.stop();

    const t0 = ctx.currentTime + 0.02;
    const note = 0.3, gap = 0.1, step = note + gap;
    const count = Math.max(1, Math.round(seconds / step));

    for (let i = 0; i < count; i++) {
      const at = t0 + i * step;
      const freq = i % 2 === 0 ? 988 : 740;     // B5 → F#5

      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);

      // Soft attack, gentle decay — reads as a chime, not a buzzer
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.85, at + 0.03);
      g.gain.setValueAtTime(0.85, at + note * 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, at + note);

      osc.connect(g); g.connect(this.bus);
      osc.start(at); osc.stop(at + note + 0.02);

      // Quiet octave above adds presence without harshness
      const top = ctx.createOscillator();
      const gt  = ctx.createGain();
      top.type = 'sine';
      top.frequency.setValueAtTime(freq * 2, at);
      gt.gain.setValueAtTime(0.0001, at);
      gt.gain.exponentialRampToValueAtTime(0.22, at + 0.03);
      gt.gain.exponentialRampToValueAtTime(0.0001, at + note * 0.8);
      top.connect(gt); gt.connect(this.bus);
      top.start(at); top.stop(at + note + 0.02);

      this.nodes.push(osc, top);
    }

    if (withBuzz) buzz();
  }

  stop() {
    this.nodes.forEach(n => { try { n.stop(); } catch (_) {} });
    this.nodes = [];
    stopBuzz();
  }
}
const alarm = new Alarm();

/* ─────────── HAPTICS ───────────
   Whole-device shake, driven by the vibration motor and completely
   separate from the audio. Long solid pulses hit far harder than
   short taps, so the phone really moves. Runs ~8s — well past the
   2s chime — so it is impossible to miss.                         */
const BUZZ_PATTERN = [
  0,
  900, 160,   // slam
  900, 160,   // slam
  900, 200,   // slam
  1400        // long finish
];
const BUZZ_CYCLE   = BUZZ_PATTERN.reduce((a, b) => a + b, 0);   // ~4.6s
const BUZZ_REPEATS = 2;                                          // ~9s total
let buzzTimer = null;

function buzz() {
  if (!navigator.vibrate) return;
  stopBuzz();
  let fired = 0;
  const fire = () => {
    try { navigator.vibrate(BUZZ_PATTERN); } catch (_) {}
    if (++fired < BUZZ_REPEATS) buzzTimer = setTimeout(fire, BUZZ_CYCLE + 120);
  };
  fire();
}

function stopBuzz() {
  clearTimeout(buzzTimer);
  buzzTimer = null;
  if (navigator.vibrate) { try { navigator.vibrate(0); } catch (_) {} }
}

/* Unlock audio on the very first interaction, and keep it warm */
['pointerdown', 'touchstart', 'keydown'].forEach(ev =>
  window.addEventListener(ev, () => alarm.unlock(), { passive: true })
);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    alarm.ctxReady();
    reviveLive();
    waitLoop();
    catchUp();
  }
});

/* ─────────── API ─────────── */
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['x-token'] = token;
  if (body)  opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

/* ─────────── UI HELPERS ─────────── */
const $ = id => document.getElementById(id);
const ICON = {
  ok:  '<svg><use href="#i-check-circle"/></svg>',
  err: '<svg><use href="#i-alert"/></svg>',
  info:'<svg><use href="#i-info"/></svg>'
};
let toastTimer;
function toast(msg, kind = 'ok') {
  const el = $('toast');
  el.innerHTML = (ICON[kind] || '') + '<span>' + msg + '</span>';
  el.className = kind + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
function setLoading(btn, on, label) {
  if (on) {
    btn.dataset.html = btn.innerHTML;
    btn.innerHTML = '<div class="spinner"></div>' + (label ? '<span>' + label + '</span>' : '');
    btn.disabled = true;
  } else {
    if (btn.dataset.html) btn.innerHTML = btn.dataset.html;
    btn.disabled = false;
  }
}
function markInvalid(fieldId, msg) {
  const f = $(fieldId); if (!f) return;
  f.classList.add('invalid');
  let e = f.querySelector('.field-err');
  if (!e) { e = document.createElement('p'); e.className = 'field-err'; f.appendChild(e); }
  e.textContent = msg;
}
function clearInvalid(...ids) {
  ids.forEach(id => {
    const f = $(id); if (!f) return;
    f.classList.remove('invalid');
    f.querySelector('.field-err')?.remove();
  });
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const initial = n => (n || '?').trim().charAt(0).toUpperCase();
function relDay(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)   return days + 'd ago';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const clockTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/* ─────────── NAVIGATION ─────────── */
function nav(id) {
  const open = ['sc-login', 'sc-signup'];
  if (!token && !open.includes(id)) id = 'sc-login';
  if (token && open.includes(id))   id = 'sc-home';

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = $(id); if (!target) return;
  target.classList.add('active');
  target.querySelector('.screen-body') && (target.querySelector('.screen-body').scrollTop = 0);

  if (id === 'sc-home')     renderHome();
  if (id === 'sc-members')  renderMembers();
  if (id === 'sc-history')  renderHistory();
  if (id === 'sc-settings') renderSettings();
  if (id === 'sc-create')   resetCreate();
  if (id === 'sc-join')     { $('jc').value = ''; clearInvalid('f-jc'); }
}

/* ─────────── AUTH ─────────── */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setHint(id, text, bad = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('bad', bad);
}
function flagInput(id, bad) { $(id).classList.toggle('bad', bad); }

function clearEmail() {
  $('authEmail').value = '';
  flagInput('authEmail', false);
  setHint('emailHint', 'Enter the email address you registered with.');
  $('authEmail').focus();
}

function goCreate() {
  $('regName').value = '';
  $('regEmail').value = $('authEmail').value.trim();
  flagInput('regName', false);
  flagInput('regEmail', false);
  setHint('regHint', 'Your name is what the group sees when you raise an alert.');
  nav('sc-signup');
  setTimeout(() => $('regName').focus(), 320);
}

/* SIGN IN — email must already exist */
$('emailForm').addEventListener('submit', async e => {
  e.preventDefault();
  alarm.unlock();

  const email = $('authEmail').value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    flagInput('authEmail', true);
    setHint('emailHint', 'That does not look like a valid email address.', true);
    return;
  }
  flagInput('authEmail', false);

  const btn = $('emailNext');
  setLoading(btn, true);
  try {
    const d = await api('POST', '/api/auth/enter', { email });
    token = d.token; me = d.user;
    localStorage.setItem('wa_token', token);
    await boot();
    toast('Welcome back, ' + me.name.split(' ')[0]);
  } catch (err) {
    flagInput('authEmail', true);
    setHint('emailHint', 'No account found for this email. Tap Create Account below.', true);
    toast('Account not found', 'err');
  } finally { setLoading(btn, false); }
});

/* CREATE ACCOUNT — name first, then email */
$('createForm2').addEventListener('submit', async e => {
  e.preventDefault();
  alarm.unlock();

  const name  = $('regName').value.trim();
  const email = $('regEmail').value.trim().toLowerCase();

  flagInput('regName', false);
  flagInput('regEmail', false);

  if (name.length < 2) {
    flagInput('regName', true);
    setHint('regHint', 'Please enter your name.', true);
    $('regName').focus();
    return;
  }
  if (!EMAIL_RE.test(email)) {
    flagInput('regEmail', true);
    setHint('regHint', 'That does not look like a valid email address.', true);
    $('regEmail').focus();
    return;
  }

  const btn = $('regNext');
  setLoading(btn, true);
  try {
    await api('POST', '/api/auth/register', { email, name });
    nav('sc-login');
    $('authEmail').value = email;
    flagInput('authEmail', false);
    setHint('emailHint', 'Account created. Tap Next to sign in.');
    toast('Account created');
  } catch (err) {
    flagInput('regEmail', true);
    setHint('regHint', err.message, true);
    toast(err.message, 'err');
  } finally { setLoading(btn, false); }
});

async function logout() {
  if (!confirm('Sign out of WorkAlert?')) return;
  try { await api('POST', '/api/logout'); } catch (_) {}
  token = null; me = null; groups = []; current = null;
  localStorage.removeItem('wa_token');
  sse?.close(); sse = null;
  stopWaitLoop();
  clearInterval(pollId); pollId = null;
  kvSet('token', null);
  swReg?.active?.postMessage({ type: 'CLEAR_TOKEN' });
  alarm.stop();
  nav('sc-login');
  toast('Signed out', 'info');
}

/* ─────────── BOOT ─────────── */
async function boot() {
  try {
    me = (await api('GET', '/api/me')).user;
    groups = (await api('GET', '/api/groups')).groups || [];
    current = groups[0] || null;
    nav('sc-home');

    kvSet('token', token);
    swReg?.active?.postMessage({ type: 'SET_TOKEN', token });

    waitLoop();            // primary: instant, proxy-proof
    reviveLive();          // bonus: SSE where it isn't buffered
    startPolling();        // safety net
    enablePush();          // asks for permission the first time
  } catch (_) {
    token = null;
    localStorage.removeItem('wa_token');
    nav('sc-login');
  }
}

/* ─────────── LIVE STREAM ─────────── */
function reviveLive() {
  if (!token) return;
  if (sse && sse.readyState !== 2) return;    // 2 = CLOSED
  sse?.close();

  sse = new EventSource('/api/events?token=' + encodeURIComponent(token));
  sse.onopen = () => setLiveStatus('Connected');
  sse.onmessage = e => {
    let d; try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.type === 'connected')     { setLiveStatus('Connected'); return; }
    if (d.type === 'member_joined') { toast(d.name + ' joined ' + d.groupName, 'info'); refreshGroups(); return; }
    receiveAlert(d);
  };
  sse.onerror = () => setLiveStatus('Reconnecting…');
}

function setLiveStatus(text) {
  const el = $('sseStatus'); if (el) el.textContent = text;
}

/* ─────────── LONG POLL (primary transport) ───────────
   The request is held open by the server until an alert lands,
   so delivery is instant and survives proxies that buffer SSE. */
let waitAbort = null;
let waitLoopRunning = false;

async function waitLoop() {
  if (waitLoopRunning || !token) return;
  waitLoopRunning = true;

  while (token) {
    try {
      waitAbort = new AbortController();
      const res = await fetch('/api/wait?since=' + lastTs.get(), {
        headers: { 'x-token': token },
        signal: waitAbort.signal,
        cache: 'no-store'
      });

      if (res.status === 401) { break; }               // session gone
      if (!res.ok) { await sleep(3000); continue; }

      const d = await res.json();
      setLiveStatus('Connected');
      (d.alerts || []).slice().reverse().forEach(a => receiveAlert(a));
    } catch (e) {
      if (e.name === 'AbortError') break;
      setLiveStatus('Reconnecting…');
      await sleep(2500);
    }
  }

  waitLoopRunning = false;
}

function stopWaitLoop() {
  try { waitAbort?.abort(); } catch (_) {}
  waitAbort = null;
  waitLoopRunning = false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Safety net: a slow poll in case a long-poll cycle is lost */
function startPolling() {
  clearInterval(pollId);
  pollId = setInterval(() => {
    if (document.visibilityState === 'visible') catchUp();
  }, 10000);
}

async function catchUp() {
  if (!token) return;
  try {
    const d = await api('GET', '/api/pending?since=' + lastTs.get());
    (d.alerts || []).slice().reverse().forEach(a => receiveAlert(a));
  } catch (_) { /* offline — retry next tick */ }
}

/* ─────────── RECEIVE AN ALERT ─────────── */
function receiveAlert(a, quiet = false) {
  if (!a || !a.id) return;
  if (seenIds.has(a.id)) return;
  seenIds.add(a.id);
  if (seenIds.size > 200) seenIds = new Set([...seenIds].slice(-100));
  lastTs.set(a.timestamp || Date.now());
  kvSet('lastAlertTs', a.timestamp || Date.now());

  alarm.play(ALARM_SECONDS);
  showSystemNotification(a);

  $('modalTitle').textContent = a.title || 'Alert';
  $('modalMsg').textContent   = a.message || '';
  $('modalMeta').textContent  = (a.triggeredBy || 'A member') + ' · ' + (a.groupName || '');
  $('alertModal').classList.add('show');
}

function dismissAlert() {
  alarm.stop();
  $('alertModal').classList.remove('show');
}

/* A visible notification also makes the phone chime with the screen off */
function showSystemNotification(a) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = `${a.message}\n${a.triggeredBy} · ${a.groupName}`;
  const opts = {
    body,
    tag: 'workalert-' + a.id,
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: BUZZ_PATTERN,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { alert: a }
  };
  try {
    if (swReg) swReg.showNotification(a.title || ALERT_TITLE, opts);
    else new Notification(a.title || ALERT_TITLE, opts);
  } catch (_) {}
}

/* ─────────── PUSH (screen-off delivery) ─────────── */
async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    navigator.serviceWorker.addEventListener('message', e => {
      const d = e.data || {};
      if (d.type === 'ALERT') {
        if (d.alert) receiveAlert(d.alert);
        else { alarm.play(ALARM_SECONDS); catchUp(); }
      }
    });
    if (token) swReg.active?.postMessage({ type: 'SET_TOKEN', token });
    return swReg;
  } catch (e) {
    console.warn('SW registration failed:', e.message);
    return null;
  }
}

function urlB64ToU8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function enablePush(interactive = false) {
  if (!('Notification' in window)) { if (interactive) toast('Notifications not supported here', 'err'); return; }
  if (!swReg) await registerSW();
  if (!swReg) { if (interactive) toast('Background alerts unavailable', 'err'); return; }

  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    updatePushRow();
    if (interactive) toast('Notifications blocked — enable them in browser settings', 'err');
    return;
  }

  try {
    const { key } = await (await fetch('/api/push/key')).json();
    let sub = await swReg.pushManager.getSubscription();
    if (!sub) {
      sub = await swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToU8(key)
      });
    }
    await api('POST', '/api/push/subscribe', sub.toJSON());
    updatePushRow();
    if (interactive) toast('Background alerts are on');
  } catch (e) {
    console.warn('push subscribe failed:', e.message);
    updatePushRow();
    if (interactive) toast('Could not enable background alerts', 'err');
  }
}

function updatePushRow() {
  const el = $('pushStatus'); if (!el) return;
  if (!('Notification' in window)) { el.textContent = 'Not supported on this browser'; return; }
  if (Notification.permission === 'granted') el.textContent = 'On — you will be alerted with the screen off';
  else if (Notification.permission === 'denied') el.textContent = 'Blocked in browser settings';
  else el.textContent = 'Off — tap to turn on';
}

/* ─────────── HOME ─────────── */
function renderHome() {
  $('homeGreet').textContent = 'Hey ' + (me?.name?.split(' ')[0] || 'there');

  if (!groups.length) {
    $('homeContent').classList.add('hidden');
    $('homeEmpty').classList.remove('hidden');
    $('homeSub').textContent = 'Get started below';
    return;
  }
  $('homeContent').classList.remove('hidden');
  $('homeEmpty').classList.add('hidden');
  $('homeSub').textContent = groups.length + (groups.length === 1 ? ' group' : ' groups') + ' · ready';

  $('groupPills').innerHTML = groups.map(g => `
    <button class="pill${g.id === current?.id ? ' active' : ''}" onclick="pickGroup('${g.id}')">
      ${g.id === current?.id ? '<svg style="width:14px;height:14px"><use href="#i-check"/></svg>' : ''}
      ${esc(g.name)}
    </button>`).join('');

  if (current) {
    const isAdmin = current.adminId === me?.id;
    const n = current.members?.length || 0;
    $('groupCard').innerHTML = `
      <div class="group-card">
        <div class="group-card-top">
          <div style="min-width:0">
            <h3>${esc(current.name)}</h3>
            ${current.description ? `<p class="desc">${esc(current.description)}</p>` : ''}
          </div>
          ${isAdmin ? '<span class="tag tag-admin"><svg><use href="#i-star"/></svg>Admin</span>' : ''}
        </div>
        <div class="group-stats">
          <button class="stat-chip" onclick="nav('sc-members')"><svg><use href="#i-users"/></svg>${n} member${n === 1 ? '' : 's'}</button>
          <button class="stat-chip" onclick="nav('sc-history')"><svg><use href="#i-clock"/></svg>History</button>
          <button class="stat-chip" onclick="nav('sc-join')"><svg><use href="#i-key"/></svg>Join</button>
        </div>
      </div>`;
    const others = Math.max(0, n - 1);
    $('alertHint').textContent = others
      ? `Alerts ${others} other member${others === 1 ? '' : 's'} instantly`
      : 'Invite teammates so they get your alerts';
  }
}
function pickGroup(id) { current = groups.find(g => g.id === id) || current; renderHome(); }

async function refreshGroups() {
  try {
    groups = (await api('GET', '/api/groups')).groups || [];
    if (current) current = groups.find(g => g.id === current.id) || groups[0] || null;
    else current = groups[0] || null;
    if ($('sc-home').classList.contains('active')) renderHome();
  } catch (_) {}
}

/* ─────────── TRIGGER ALERT ─────────── */
let sending = false;
async function triggerAlert() {
  if (!current || sending) return;
  alarm.unlock();
  sending = true;
  const btn = $('alertBtn');
  const original = btn.dataset.original || btn.innerHTML;
  btn.dataset.original = original;

  btn.className = 'alert-btn sending';
  btn.innerHTML = '<div class="spinner" style="width:34px;height:34px;border-width:4px"></div>';

  try {
    const d = await api('POST', '/api/alert', { groupId: current.id });
    lastTs.set(d.alert?.timestamp || Date.now());
    if (d.alert?.id) seenIds.add(d.alert.id);       // don't re-alert ourselves

    btn.className = 'alert-btn sent';
    btn.innerHTML = '<svg style="width:56px;height:56px"><use href="#i-check"/></svg>';

    const others = Math.max(0, (d.memberCount || 1) - 1);
    toast(others ? `Alert sent to ${others} member${others === 1 ? '' : 's'}` : 'Alert logged — no other members yet');
    // The sender stays silent on purpose — no chime, no vibration.
  } catch (err) {
    btn.className = 'alert-btn';
    btn.innerHTML = original;
    toast(err.message, 'err');
    sending = false;
    return;
  }

  setTimeout(() => {
    btn.className = 'alert-btn';
    btn.innerHTML = original;
    sending = false;
  }, 2400);
}

/* ─────────── CREATE GROUP ─────────── */
function resetCreate() {
  $('createBody').classList.remove('hidden');
  $('createSuccess').classList.add('hidden');
  $('cn').value = ''; $('cd').value = '';
  clearInvalid('f-cn');
}
$('createForm').addEventListener('submit', async e => {
  e.preventDefault();
  clearInvalid('f-cn');
  const name = $('cn').value.trim();
  if (!name) { markInvalid('f-cn', 'Give your group a name'); return; }
  const btn = $('createBtn');
  setLoading(btn, true, 'Creating…');
  try {
    const d = await api('POST', '/api/groups', { name, description: $('cd').value.trim() });
    groups.push(d.group); current = d.group;
    $('newCode').textContent = d.group.code;
    $('createBody').classList.add('hidden');
    $('createSuccess').classList.remove('hidden');
    toast('Group created');
  } catch (err) { toast(err.message, 'err'); }
  finally { setLoading(btn, false); }
});
function copyCode() {
  const code = $('newCode').textContent;
  navigator.clipboard?.writeText(code)
    .then(() => toast('Code copied'))
    .catch(() => toast('Copy failed — select manually', 'err'));
}

/* ─────────── JOIN GROUP ─────────── */
$('jc').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  clearInvalid('f-jc');
});
$('joinForm').addEventListener('submit', async e => {
  e.preventDefault();
  clearInvalid('f-jc');
  const code = $('jc').value.trim();
  if (code.length !== 6) { markInvalid('f-jc', 'Code must be 6 characters'); return; }
  const btn = $('joinBtn');
  setLoading(btn, true, 'Joining…');
  try {
    const d = await api('POST', '/api/groups/join', { code });
    if (!groups.find(g => g.id === d.group.id)) groups.push(d.group);
    current = d.group;
    toast('Joined ' + d.group.name);
    enablePush();
    setTimeout(() => nav('sc-home'), 500);
  } catch (err) {
    markInvalid('f-jc', err.message);
    toast(err.message, 'err');
  } finally { setLoading(btn, false); }
});

/* ─────────── MEMBERS ─────────── */
async function renderMembers() {
  const box = $('membersBody');
  if (!current) {
    $('memGroupName').textContent = '';
    box.innerHTML = emptyBlock('i-users', 'No group selected', 'Create or join a group first.');
    return;
  }
  $('memGroupName').textContent = current.name;
  box.innerHTML = '<div class="skel" style="height:100px;border-radius:22px"></div>'
                + '<div class="skel mt-3" style="height:70px;border-radius:16px"></div>';
  try {
    const d = await api('GET', '/api/groups/' + current.id + '/members');
    const idx = groups.findIndex(g => g.id === current.id);
    if (idx > -1) { groups[idx].members = d.members; current = groups[idx]; }

    box.innerHTML = `
      <div class="code-display">
        <div><p class="lbl">Join code</p><p class="val">${esc(d.code)}</p></div>
        <div class="count-box"><p class="n">${d.members.length}</p><p class="l">Members</p></div>
      </div>
      <button class="btn btn-secondary mt-4" onclick="shareCode('${esc(d.code)}')">
        <svg><use href="#i-copy"/></svg><span>Share invite</span>
      </button>
      <p class="section-label">Everyone in this group</p>
      ${d.members.map(m => {
        const admin = m.id === d.adminId, you = m.id === me?.id;
        return `<div class="list-item">
          <div class="avatar ${admin ? 'avatar-brand' : 'avatar-neutral'}">${esc(initial(m.name))}</div>
          <div class="list-body">
            <p class="list-title">${esc(m.name)}${you ? '<span class="tag tag-you">You</span>' : ''}</p>
            <p class="list-sub">${esc(m.email)}</p>
          </div>
          ${admin ? '<span class="tag tag-admin"><svg><use href="#i-shield"/></svg>Admin</span>' : ''}
        </div>`;
      }).join('')}`;
  } catch (err) {
    box.innerHTML = emptyBlock('i-alert', 'Could not load members', err.message);
  }
}
function shareCode(code) {
  const text = `Join my WorkAlert group with code ${code}\n${location.origin}`;
  if (navigator.share) navigator.share({ title: 'WorkAlert invite', text }).catch(() => {});
  else navigator.clipboard?.writeText(text).then(() => toast('Invite copied')).catch(() => {});
}

/* ─────────── HISTORY ─────────── */
async function renderHistory() {
  const box = $('historyBody');
  if (!current) {
    $('histGroupName').textContent = '';
    box.innerHTML = emptyBlock('i-clock', 'No group selected', 'Create or join a group first.');
    return;
  }
  $('histGroupName').textContent = current.name;
  box.innerHTML = '<div class="skel" style="height:88px;border-radius:16px"></div>';
  try {
    const list = (await api('GET', '/api/alerts/' + current.id)).alerts || [];
    if (!list.length) {
      box.innerHTML = emptyBlock('i-clock', 'Nothing yet', 'Every alert sent in this group will appear here.');
      return;
    }
    const now = Date.now();
    const today = list.filter(a => now - a.timestamp < 86400000).length;
    const week  = list.filter(a => now - a.timestamp < 604800000).length;
    box.innerHTML = `
      <div class="stats-grid">
        <div class="stat-box"><p class="n">${list.length}</p><p class="l">Total</p></div>
        <div class="stat-box"><p class="n">${week}</p><p class="l">7 days</p></div>
        <div class="stat-box"><p class="n">${today}</p><p class="l">Today</p></div>
      </div>
      <p class="section-label">Recent alerts</p>
      ${list.map(a => `
        <div class="list-item">
          <div class="avatar avatar-danger"><svg style="width:20px;height:20px"><use href="#i-bell-ring"/></svg></div>
          <div class="list-body">
            <p class="list-title">${esc(a.title)}</p>
            <p class="list-sub">${esc(a.message)}</p>
            <p class="list-sub" style="color:var(--ink-4);margin-top:3px">${esc(a.triggeredBy)} · ${a.membersNotified} notified</p>
          </div>
          <div class="list-meta"><p class="t">${clockTime(a.timestamp)}</p><p class="d">${relDay(a.timestamp)}</p></div>
        </div>`).join('')}`;
  } catch (err) {
    box.innerHTML = emptyBlock('i-alert', 'Could not load history', err.message);
  }
}

function emptyBlock(icon, title, text) {
  return `<div class="empty" style="min-height:52vh">
    <div class="empty-art"><svg><use href="#${icon}"/></svg></div>
    <h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
}

/* ─────────── SETTINGS ─────────── */
function renderSettings() {
  $('setAvatar').textContent = initial(me?.name);
  $('setName').textContent   = me?.name  || '';
  $('setEmail').textContent  = me?.email || '';
  applyThemeUI();
  setLiveStatus(sse && sse.readyState === 1 ? 'Connected' : 'Connecting…');
  updatePushRow();
}
function toggleTheme() {
  dark = !dark;
  localStorage.setItem('wa_theme', dark ? 'dark' : 'light');
  applyThemeUI();
}
function applyThemeUI() {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  $('themeToggle')?.classList.toggle('on', dark);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0A0C14' : '#4F46E5');
}
function testSound() {
  alarm.unlock();
  alarm.play(ALARM_SECONDS);
  toast('Playing alarm', 'info');
}

async function testNotification() {
  if (!('Notification' in window)) { toast('Not supported here', 'err'); return; }
  if (Notification.permission !== 'granted') { await enablePush(true); return; }
  showSystemNotification({
    id: 'test-' + Date.now(),
    title: ALERT_TITLE,
    message: 'This is what a real alert looks like.',
    triggeredBy: me?.name || 'You',
    groupName: current?.name || 'your group',
    timestamp: Date.now()
  });
  buzz();
  toast('Notification sent', 'info');
}

/* ─────────── INIT ─────────── */
applyThemeUI();
registerSW().then(() => { if (token) boot(); else nav('sc-login'); });
window.addEventListener('online', () => { reviveLive(); waitLoop(); catchUp(); });
