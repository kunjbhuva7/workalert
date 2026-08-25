/* ============================================================
   WorkAlert v2 — Client
   ============================================================ */

/* ─── STATE ─── */
let token = localStorage.getItem('wa_token');
let me = null, groups = [], current = null, sse = null, pollId = null;
let dark = localStorage.getItem('wa_theme') === 'dark';
let swReg = null, seenIds = new Set(), pendingInvite = null;
let otpEmail = '', otpTimerId = null;
const ALARM_SECONDS = 2, ALARM_LEVEL = 0.42;
const ALERT_TITLE = 'Jamun Is Coming ⚠️';
const lastTs = { get() { return Number(localStorage.getItem('wa_lastTs') || 0); }, set(v) { if (v > this.get()) localStorage.setItem('wa_lastTs', String(v)); } };

/* ─── IndexedDB (shared with SW) ─── */
function idb(mode, fn) { return new Promise((res, rej) => { const r = indexedDB.open('workalert', 1); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); }; r.onerror = () => rej(r.error); r.onsuccess = () => { const db = r.result, tx = db.transaction('kv', mode); let out; try { out = fn(tx.objectStore('kv')); } catch (e) { rej(e); return; } tx.oncomplete = () => { db.close(); res(out?.result); }; tx.onerror = () => { db.close(); rej(tx.error); }; }; }); }
const kvSet = (k, v) => idb('readwrite', s => s.put(v, k)).catch(() => {});

/* ─── ALARM ─── */
const TONE_NAMES = [
  'Classic Chime', 'Emergency Siren', 'Submarine Horn', 'Digital Beep',
  'School Bell', 'Air Raid', 'Gentle Ping', 'Police Whoop',
  'Ship Horn', 'Cricket Chirp'
];

function playTone(toneIdx = 0, seconds = ALARM_SECONDS) {
  alarm.playToneByIndex(toneIdx, seconds);
}

class Alarm {
  constructor() { this.ctx = null; this.bus = null; this.nodes = []; this.keepAlive = null; }
  ctxReady() {
    if (!this.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; this.ctx = new AC(); this.bus = this.ctx.createGain(); this.bus.gain.value = ALARM_LEVEL; this.bus.connect(this.ctx.destination); }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }
  unlock() { const ctx = this.ctxReady(); if (!ctx || this.keepAlive) return; const buf = ctx.createBuffer(1, 1, ctx.sampleRate); const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; const g = ctx.createGain(); g.gain.value = 0; src.connect(g); g.connect(ctx.destination); try { src.start(); this.keepAlive = src; } catch (_) {} }

  playToneByIndex(idx = 0, seconds = ALARM_SECONDS) {
    const ctx = this.ctxReady(); if (!ctx) return; this.stop();
    const t0 = ctx.currentTime + 0.02;
    const tones = [
      /* 0 Classic Chime */  () => this._chime(ctx, t0, seconds, 988, 740, 'sine'),
      /* 1 Emergency Siren */() => this._siren(ctx, t0, seconds, 680, 1200),
      /* 2 Submarine Horn */ () => this._horn(ctx, t0, seconds, 120, 180),
      /* 3 Digital Beep */   () => this._chime(ctx, t0, seconds, 1400, 1000, 'square'),
      /* 4 School Bell */    () => this._chime(ctx, t0, seconds, 1568, 1318, 'triangle'),
      /* 5 Air Raid */       () => this._siren(ctx, t0, seconds, 400, 900),
      /* 6 Gentle Ping */    () => this._ping(ctx, t0, seconds, 1200),
      /* 7 Police Whoop */   () => this._whoop(ctx, t0, seconds),
      /* 8 Ship Horn */      () => this._horn(ctx, t0, seconds, 85, 130),
      /* 9 Cricket Chirp */  () => this._cricket(ctx, t0, seconds),
    ];
    (tones[idx] || tones[0])();
    buzz();
  }

  /* Tone generators */
  _chime(ctx, t0, sec, f1, f2, type) {
    const note = 0.3, gap = 0.1, step = note + gap, count = Math.max(1, Math.round(sec / step));
    for (let i = 0; i < count; i++) {
      const at = t0 + i * step, freq = i % 2 === 0 ? f1 : f2;
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(freq, at);
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.8, at + 0.03); g.gain.setValueAtTime(0.8, at + note * 0.5); g.gain.exponentialRampToValueAtTime(0.0001, at + note);
      o.connect(g); g.connect(this.bus); o.start(at); o.stop(at + note + 0.02); this.nodes.push(o);
    }
  }
  _siren(ctx, t0, sec, lo, hi) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sawtooth';
    const cycles = Math.ceil(sec / 0.8);
    for (let i = 0; i < cycles; i++) {
      const at = t0 + i * 0.8;
      o.frequency.setValueAtTime(lo, at); o.frequency.linearRampToValueAtTime(hi, at + 0.4);
      o.frequency.linearRampToValueAtTime(lo, at + 0.8);
    }
    g.gain.setValueAtTime(0.5, t0); g.gain.setValueAtTime(0.5, t0 + sec - 0.1); g.gain.linearRampToValueAtTime(0.0001, t0 + sec);
    o.connect(g); g.connect(this.bus); o.start(t0); o.stop(t0 + sec + 0.05); this.nodes.push(o);
  }
  _horn(ctx, t0, sec, f1, f2) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime(f1, t0); o.frequency.linearRampToValueAtTime(f2, t0 + 0.3);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.7, t0 + 0.15); g.gain.setValueAtTime(0.7, t0 + sec - 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t0 + sec);
    o.connect(g); g.connect(this.bus); o.start(t0); o.stop(t0 + sec + 0.05); this.nodes.push(o);
  }
  _ping(ctx, t0, sec, freq) {
    const step = 0.6, count = Math.max(1, Math.round(sec / step));
    for (let i = 0; i < count; i++) {
      const at = t0 + i * step;
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(freq, at);
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.6, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
      o.connect(g); g.connect(this.bus); o.start(at); o.stop(at + 0.5); this.nodes.push(o);
    }
  }
  _whoop(ctx, t0, sec) {
    const step = 0.5, count = Math.max(1, Math.round(sec / step));
    for (let i = 0; i < count; i++) {
      const at = t0 + i * step;
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine';
      o.frequency.setValueAtTime(400, at); o.frequency.exponentialRampToValueAtTime(1600, at + 0.25); o.frequency.exponentialRampToValueAtTime(400, at + 0.45);
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.6, at + 0.03); g.gain.setValueAtTime(0.6, at + 0.35); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
      o.connect(g); g.connect(this.bus); o.start(at); o.stop(at + 0.48); this.nodes.push(o);
    }
  }
  _cricket(ctx, t0, sec) {
    const step = 0.18, count = Math.max(1, Math.round(sec / step));
    for (let i = 0; i < count; i++) {
      const at = t0 + i * step;
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(4200 + (i % 3) * 200, at);
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.35, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
      o.connect(g); g.connect(this.bus); o.start(at); o.stop(at + 0.1); this.nodes.push(o);
    }
  }

  play(seconds = ALARM_SECONDS, withBuzz = true) { this.playToneByIndex(0, seconds); }
  stop() { this.nodes.forEach(n => { try { n.stop(); } catch (_) {} }); this.nodes = []; stopBuzz(); }
}
const alarm = new Alarm();

/* ─── VIBRATION ─── */
const BUZZ_PATTERN = [0, 900, 160, 900, 160, 900, 200, 1400];
const BUZZ_CYCLE = BUZZ_PATTERN.reduce((a, b) => a + b, 0);
const BUZZ_REPEATS = 2;
let buzzTimer = null;
function buzz() { if (!navigator.vibrate) return; stopBuzz(); let fired = 0; const fire = () => { try { navigator.vibrate(BUZZ_PATTERN); } catch (_) {} if (++fired < BUZZ_REPEATS) buzzTimer = setTimeout(fire, BUZZ_CYCLE + 120); }; fire(); }
function stopBuzz() { clearTimeout(buzzTimer); buzzTimer = null; if (navigator.vibrate) try { navigator.vibrate(0); } catch (_) {} }

['pointerdown', 'touchstart', 'keydown'].forEach(ev => window.addEventListener(ev, () => alarm.unlock(), { passive: true }));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { alarm.ctxReady(); reviveLive(); waitLoop(); catchUp(); checkInvites(); } });

/* ─── API ─── */
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['x-token'] = token;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

/* ─── UI UTILS ─── */
const $ = id => document.getElementById(id);
const ICON = { ok: '<svg><use href="#i-check-circle"/></svg>', err: '<svg><use href="#i-alert"/></svg>', info: '<svg><use href="#i-info"/></svg>' };
let toastTimer;
function toast(msg, kind = 'ok') { const el = $('toast'); el.innerHTML = (ICON[kind] || '') + '<span>' + msg + '</span>'; el.className = kind + ' show'; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000); }
function setLoading(btn, on, label) { if (on) { btn.dataset.html = btn.innerHTML; btn.innerHTML = '<div class="spinner"></div>' + (label ? '<span>' + label + '</span>' : ''); btn.disabled = true; } else { if (btn.dataset.html) btn.innerHTML = btn.dataset.html; btn.disabled = false; } }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const initial = n => (n || '?').trim().charAt(0).toUpperCase();
function relDay(ts) { const d = Math.floor((Date.now() - ts) / 86400000); if (d === 0) return 'Today'; if (d === 1) return 'Yesterday'; if (d < 7) return d + 'd ago'; return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
const clockTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function flagInput(id, bad) { $(id)?.classList.toggle('bad', bad); }
function setHint(id, text, bad = false) { const el = $(id); if (!el) return; el.textContent = text; el.classList.toggle('bad', bad); }

/* ─── NAVIGATION ─── */
function nav(id) {
  const open = ['sc-login', 'sc-signup'];
  if (!token && !open.includes(id)) id = 'sc-login';
  if (token && open.includes(id)) id = 'sc-home';
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id)?.classList.add('active');
  if (id === 'sc-home') renderHome();
  if (id === 'sc-members') renderMembers();
  if (id === 'sc-history') renderHistory();
  if (id === 'sc-settings') renderSettings();
  if (id === 'sc-create') resetCreate();
}

/* ═══════════════════════════════════════════════
   AUTH — SIGN IN
   ═══════════════════════════════════════════════ */
function clearLogin() { $('loginEmail').value = ''; flagInput('loginEmail', false); setHint('loginHint', 'Enter the email you registered with.'); $('loginEmail').focus(); }

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); alarm.unlock();
  const email = $('loginEmail').value.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) { flagInput('loginEmail', true); setHint('loginHint', 'Enter a valid email address.', true); return; }
  flagInput('loginEmail', false);
  const btn = $('loginBtn'); setLoading(btn, true);
  try {
    const d = await api('POST', '/api/auth/enter', { email });
    token = d.token; me = d.user; localStorage.setItem('wa_token', token);
    await boot(); toast('Welcome back, ' + me.name.split(' ')[0]);
  } catch (err) {
    flagInput('loginEmail', true);
    setHint('loginHint', 'No account found. Tap Create Account below.', true);
    toast('Account not found', 'err');
  } finally { setLoading(btn, false); }
});

/* ═══════════════════════════════════════════════
   AUTH — CREATE ACCOUNT (instant, no OTP)
   ═══════════════════════════════════════════════ */
$('signupForm').addEventListener('submit', async e => {
  e.preventDefault(); alarm.unlock();
  const name = $('regName').value.trim(), email = $('regEmail').value.trim().toLowerCase();
  flagInput('regName', false); flagInput('regEmail', false);
  if (name.length < 2) { flagInput('regName', true); setHint('regHint', 'Please enter your name.', true); return; }
  if (!/^\S+@\S+\.\S+$/.test(email)) { flagInput('regEmail', true); setHint('regHint', 'Enter a valid email address.', true); return; }

  const btn = $('regBtn'); setLoading(btn, true, 'Creating…');
  try {
    const d = await api('POST', '/api/auth/register', { name, email });
    token = d.token; me = d.user;
    localStorage.setItem('wa_token', token);
    localStorage.setItem('wa_email', email);
    await boot();
    toast('Account created. Welcome!');
  } catch (err) {
    flagInput('regEmail', true); setHint('regHint', err.message, true); toast(err.message, 'err');
  } finally { setLoading(btn, false); }
});

/* ─── LOGOUT ─── */
async function logout() {
  if (!confirm('Sign out of WorkAlert?')) return;
  try { await api('POST', '/api/logout'); } catch (_) {}
  token = null; me = null; groups = []; current = null;
  localStorage.removeItem('wa_token');
  sse?.close(); sse = null; stopWaitLoop(); clearInterval(pollId);
  kvSet('token', null); swReg?.active?.postMessage({ type: 'CLEAR_TOKEN' });
  alarm.stop(); nav('sc-login'); toast('Signed out', 'info');
}

/* ═══════════════════════════════════════════════
   BOOT — handles Render DB wipe by auto re-login
   ═══════════════════════════════════════════════ */
async function boot() {
  try {
    me = (await api('GET', '/api/me')).user;
    groups = (await api('GET', '/api/groups')).groups || [];
    current = groups[0] || null;
    // Save email for auto re-login if server restarts
    if (me?.email) localStorage.setItem('wa_email', me.email);
    nav('sc-home');
    kvSet('token', token); swReg?.active?.postMessage({ type: 'SET_TOKEN', token });
    waitLoop(); reviveLive(); startPolling(); enablePush(); checkInvites();
  } catch (e) {
    // Session expired (server restarted / DB wiped). Try auto re-login.
    const savedEmail = localStorage.getItem('wa_email');
    if (savedEmail) {
      try {
        const d = await api('POST', '/api/auth/enter', { email: savedEmail });
        token = d.token; me = d.user;
        localStorage.setItem('wa_token', token);
        return boot(); // retry
      } catch (_) {
        // Account doesn't exist anymore (DB wiped). Clear everything.
      }
    }
    token = null;
    localStorage.removeItem('wa_token');
    nav('sc-login');
  }
}

/* ═══════════════════════════════════════════════
   LIVE STREAM + LONG POLL
   ═══════════════════════════════════════════════ */
function reviveLive() {
  if (!token) return; if (sse && sse.readyState !== 2) return;
  sse?.close();
  sse = new EventSource('/api/events?token=' + encodeURIComponent(token));
  sse.onopen = () => setLiveStatus('Connected');
  sse.onmessage = e => {
    let d; try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.type === 'connected') { setLiveStatus('Connected'); return; }
    if (d.type === 'member_joined') { toast(d.name + ' joined ' + d.groupName, 'info'); refreshGroups(); return; }
    if (d.type === 'invite') { showInvitePopup(d.invite); return; }
    if (d.type === 'invite_response') { toast(d.respondedBy + (d.invite.status === 'accepted' ? ' accepted' : ' declined') + ' the invite', 'info'); refreshGroups(); return; }
    receiveAlert(d);
  };
  sse.onerror = () => setLiveStatus('Reconnecting…');
}
function setLiveStatus(t) { const el = $('sseStatus'); if (el) el.textContent = t; }

let waitAbort = null, waitLoopRunning = false;
async function waitLoop() {
  if (waitLoopRunning || !token) return; waitLoopRunning = true;
  while (token) {
    try {
      waitAbort = new AbortController();
      const res = await fetch('/api/wait?since=' + lastTs.get(), { headers: { 'x-token': token }, signal: waitAbort.signal, cache: 'no-store' });
      if (res.status === 401) break;
      if (!res.ok) { await sleep(3000); continue; }
      const d = await res.json(); setLiveStatus('Connected');
      (d.alerts || []).slice().reverse().forEach(a => receiveAlert(a));
    } catch (e) { if (e.name === 'AbortError') break; setLiveStatus('Reconnecting…'); await sleep(2500); }
  }
  waitLoopRunning = false;
}
function stopWaitLoop() { try { waitAbort?.abort(); } catch (_) {} waitAbort = null; waitLoopRunning = false; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startPolling() { clearInterval(pollId); pollId = setInterval(() => { if (document.visibilityState === 'visible') catchUp(); }, 10000); }
async function catchUp() { if (!token) return; try { const d = await api('GET', '/api/pending?since=' + lastTs.get()); (d.alerts || []).slice().reverse().forEach(a => receiveAlert(a)); } catch (_) {} }

/* ─── RECEIVE ALERT ─── */
function receiveAlert(a) {
  if (!a || !a.id) return; if (seenIds.has(a.id)) return;
  seenIds.add(a.id); if (seenIds.size > 200) seenIds = new Set([...seenIds].slice(-100));
  lastTs.set(a.timestamp || Date.now()); kvSet('lastAlertTs', a.timestamp || Date.now());
  alarm.playToneByIndex(a.tone || 0, ALARM_SECONDS); showSystemNotification(a);
  $('modalTitle').textContent = a.title || ALERT_TITLE;
  $('modalMsg').textContent = a.message || '';
  $('modalMeta').textContent = (a.triggeredBy || 'A member') + ' · ' + (a.groupName || '');
  $('alertModal').classList.add('show');
}
function dismissAlert() { alarm.stop(); $('alertModal').classList.remove('show'); }

function showSystemNotification(a) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body: `${a.triggeredBy} raised the alert in ${a.groupName}`, tag: 'workalert', renotify: true, requireInteraction: true, silent: false, vibrate: BUZZ_PATTERN, icon: '/icon-192.png', badge: '/icon-192.png', data: { alert: a } };
  try { if (swReg) swReg.showNotification(a.title || ALERT_TITLE, opts); else new Notification(a.title || ALERT_TITLE, opts); } catch (_) {}
}

/* ═══════════════════════════════════════════════
   INVITES
   ═══════════════════════════════════════════════ */
async function checkInvites() {
  if (!token) return;
  try {
    const d = await api('GET', '/api/invites');
    if (d.invites && d.invites.length) showInvitePopup(d.invites[0]);
  } catch (_) {}
}

function showInvitePopup(inv) {
  pendingInvite = inv;
  $('invTitle').textContent = 'Group Invite';
  $('invMsg').textContent = `${inv.fromName} invited you to join "${inv.groupName}"`;
  $('inviteModal').classList.add('show');
}

async function respondInvite(accept) {
  $('inviteModal').classList.remove('show');
  if (!pendingInvite) return;
  try {
    await api('POST', '/api/invite/respond', { inviteId: pendingInvite.id, accept });
    if (accept) { toast('Joined ' + pendingInvite.groupName); refreshGroups(); }
    else toast('Invite declined', 'info');
  } catch (err) { toast(err.message, 'err'); }
  pendingInvite = null;
}

/* ═══════════════════════════════════════════════
   HOME
   ═══════════════════════════════════════════════ */
function renderHome() {
  $('homeGreet').textContent = 'Hey ' + (me?.name?.split(' ')[0] || 'there');
  if (!groups.length) { $('homeContent').classList.add('hidden'); $('homeEmpty').classList.remove('hidden'); $('homeSub').textContent = 'Get started below'; return; }
  $('homeContent').classList.remove('hidden'); $('homeEmpty').classList.add('hidden');
  $('homeSub').textContent = groups.length + (groups.length === 1 ? ' group' : ' groups') + ' · ready';
  $('groupPills').innerHTML = groups.map(g => `<button class="pill${g.id === current?.id ? ' active' : ''}" onclick="pickGroup('${g.id}')">${g.id === current?.id ? '<svg style="width:14px;height:14px"><use href="#i-check"/></svg>' : '<span style="margin-right:2px">' + (g.emoji || '🔔') + '</span>'}${esc(g.name)}</button>`).join('');
  if (current) {
    const isAdmin = current.adminId === me?.id, n = current.members?.length || 0;
    $('groupCard').innerHTML = `<div class="group-card"><div class="group-card-top"><div style="min-width:0"><h3>${esc(current.name)}</h3>${current.description ? `<p class="desc">${esc(current.description)}</p>` : ''}</div>${isAdmin ? '<span class="tag tag-admin"><svg><use href="#i-star"/></svg>Admin</span>' : ''}</div><div class="group-stats"><button class="stat-chip" onclick="nav('sc-members')"><svg><use href="#i-users"/></svg>${n} member${n === 1 ? '' : 's'}</button><button class="stat-chip" onclick="nav('sc-history')"><svg><use href="#i-clock"/></svg>History</button></div></div>`;
    $('alertHint').textContent = n > 1 ? `Alerts ${n - 1} other member${n === 2 ? '' : 's'} instantly` : 'Invite teammates so they get your alerts';
  }
}
function pickGroup(id) { current = groups.find(g => g.id === id) || current; renderHome(); }
async function refreshGroups() { try { groups = (await api('GET', '/api/groups')).groups || []; if (current) current = groups.find(g => g.id === current.id) || groups[0] || null; else current = groups[0] || null; if ($('sc-home').classList.contains('active')) renderHome(); } catch (_) {} }

/* ─── ALERT TRIGGER ─── */
let sending = false;
async function triggerAlert() {
  if (!current || sending) return; alarm.unlock(); sending = true;
  const btn = $('alertBtn'), orig = btn.dataset.original || btn.innerHTML; btn.dataset.original = orig;
  btn.className = 'alert-btn sending'; btn.innerHTML = '<div class="spinner" style="width:34px;height:34px;border-width:4px"></div>';
  try {
    const d = await api('POST', '/api/alert', { groupId: current.id });
    lastTs.set(d.alert?.timestamp || Date.now()); if (d.alert?.id) seenIds.add(d.alert.id);
    btn.className = 'alert-btn sent'; btn.innerHTML = '<svg style="width:56px;height:56px"><use href="#i-check"/></svg>';
    const others = Math.max(0, (d.memberCount || 1) - 1);
    toast(others ? `Alert sent to ${others} member${others === 1 ? '' : 's'}` : 'Alert logged — invite teammates');
  } catch (err) { btn.className = 'alert-btn'; btn.innerHTML = orig; toast(err.message, 'err'); sending = false; return; }
  setTimeout(() => { btn.className = 'alert-btn'; btn.innerHTML = orig; sending = false; }, 2400);
}

/* ═══════════════════════════════════════════════
   CREATE GROUP
   ═══════════════════════════════════════════════ */
function resetCreate() { $('createBody').classList.remove('hidden'); $('createSuccess').classList.add('hidden'); $('cn').value = ''; $('cd').value = ''; }
$('createForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('cn').value.trim(); if (!name) { toast('Name required', 'err'); return; }
  const btn = $('createBtn'); setLoading(btn, true, 'Creating…');
  try { const d = await api('POST', '/api/groups', { name, description: $('cd').value.trim() }); groups.push(d.group); current = d.group; $('newCode').textContent = d.group.code; $('createBody').classList.add('hidden'); $('createSuccess').classList.remove('hidden'); toast('Group created'); } catch (err) { toast(err.message, 'err'); } finally { setLoading(btn, false); }
});
function copyCode() { navigator.clipboard?.writeText($('newCode').textContent).then(() => toast('Code copied')).catch(() => toast('Copy failed', 'err')); }

/* (join by code removed — invite only) */

/* ═══════════════════════════════════════════════
   MEMBERS + INVITE
   ═══════════════════════════════════════════════ */
async function renderMembers() {
  const box = $('membersBody');
  if (!current) { $('memGroupName').textContent = ''; box.innerHTML = emptyBlock('i-users', 'No group selected', 'Create or join a group first.'); return; }
  $('memGroupName').textContent = current.name;
  box.innerHTML = '<div class="skel" style="height:100px;border-radius:22px"></div><div class="skel mt-3" style="height:70px;border-radius:16px"></div>';

  try {
    const [membersData, usersData] = await Promise.all([
      api('GET', '/api/groups/' + current.id + '/members'),
      api('GET', '/api/users')
    ]);
    const d = membersData;
    const allUsers = usersData.users || [];
    const memberIds = new Set(d.members.map(m => m.id));
    const nonMembers = allUsers.filter(u => !memberIds.has(u.id));
    const isAdmin = current.adminId === me?.id;

    const idx = groups.findIndex(g => g.id === current.id);
    if (idx > -1) { groups[idx].members = d.members; current = groups[idx]; }

    let html = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:var(--s4) var(--s5);background:var(--brand-50);border-radius:var(--r-lg);margin-bottom:var(--s4)">
        <p style="font-size:15px;font-weight:700;color:var(--ink)">${d.members.length} Member${d.members.length === 1 ? '' : 's'}</p>
        <button class="btn btn-secondary" style="width:auto;height:36px;padding:0 14px;font-size:12px" onclick="renderMembers()"><svg style="width:14px;height:14px"><use href="#i-refresh"/></svg><span>Refresh</span></button>
      </div>`;

    // Admin: group settings
    if (isAdmin) {
      const emojis = ['🔔','🚨','⚡','🔥','💀','🎯','🫡','🏴','☠️','🆘'];
      html += `
        <p class="section-label">Group Settings (Admin)</p>
        <div class="card card-pad">
          <div style="margin-bottom:14px">
            <label class="field-label">Group Emoji</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
              ${emojis.map(e => `<button onclick="setGroupEmoji('${e}')" style="width:40px;height:40px;border-radius:10px;font-size:20px;border:2px solid ${current.emoji === e ? 'var(--brand-600)' : 'var(--line)'};background:${current.emoji === e ? 'var(--brand-50)' : 'var(--surface-2)'};cursor:pointer">${e}</button>`).join('')}
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label class="field-label">Alert Tone</label>
            <select id="toneSelect" onchange="setGroupTone(Number(this.value))" style="width:100%;height:50px;border-radius:12px;border:2px solid var(--line);background:var(--surface-2);color:var(--ink);font-size:14px;font-weight:600;padding:0 16px;margin-top:6px;font-family:inherit;cursor:pointer;appearance:auto">
              ${TONE_NAMES.map((name, i) => `<option value="${i}" ${(current.alertConfig?.tone || 0) === i ? 'selected' : ''}>${name}</option>`).join('')}
            </select>
            <button class="btn btn-secondary mt-3" style="width:auto;padding:0 20px;height:40px;font-size:13px" onclick="previewTone()"><svg style="width:16px;height:16px"><use href="#i-volume"/></svg><span>Preview</span></button>
          </div>
          <div>
            <label class="field-label">Alert Title</label>
            <input id="adminTitle" class="sheet-input" value="${esc(current.alertConfig?.title || ALERT_TITLE)}" placeholder="Jamun Is Coming ⚠️" style="height:48px;font-size:14px;margin-top:6px">
          </div>
          <button class="btn btn-primary mt-4" onclick="saveGroupSettings()"><svg><use href="#i-check"/></svg><span>Save Settings</span></button>
        </div>`;
    }

    html += `<p class="section-label">Group Members</p>`;
    html += d.members.map(m => {
      const admin = m.id === d.adminId, you = m.id === me?.id;
      return `<div class="list-item">
        <div class="avatar ${admin ? 'avatar-brand' : 'avatar-neutral'}">${esc(initial(m.name))}</div>
        <div class="list-body"><p class="list-title">${esc(m.name)}${you ? '<span class="tag tag-you">You</span>' : ''}</p><p class="list-sub">${esc(m.email)}</p></div>
        ${admin ? '<span class="tag tag-admin"><svg><use href="#i-shield"/></svg>Admin</span>' : ''}
      </div>`;
    }).join('');

    // Invite section
    if (nonMembers.length) {
      html += `<p class="section-label" style="margin-top:var(--s7)">Invite People</p>`;
      html += nonMembers.map(u => `
        <div class="list-item">
          <div class="avatar avatar-neutral">${esc(initial(u.name))}</div>
          <div class="list-body"><p class="list-title">${esc(u.name)}</p><p class="list-sub">${esc(u.email)}</p></div>
          <button class="invite-btn" onclick="sendInvite('${u.id}', this)"><svg><use href="#i-send"/></svg>Invite</button>
        </div>`).join('');
    }

    // Leave group (non-admin only)
    if (!isAdmin) {
      html += `<button class="btn btn-danger-outline mt-7" onclick="leaveGroup()"><svg><use href="#i-logout"/></svg><span>Leave Group</span></button>`;
    }

    box.innerHTML = html;
  } catch (err) { box.innerHTML = emptyBlock('i-alert', 'Could not load members', err.message); }
}

async function setGroupEmoji(emoji) {
  try { const d = await api('POST', '/api/groups/' + current.id + '/settings', { emoji }); current = d.group; const idx = groups.findIndex(g => g.id === current.id); if (idx > -1) groups[idx] = current; toast('Emoji set to ' + emoji); renderMembers(); } catch (e) { toast(e.message, 'err'); }
}

async function setGroupTone(tone) {
  try { const d = await api('POST', '/api/groups/' + current.id + '/settings', { tone }); current = d.group; const idx = groups.findIndex(g => g.id === current.id); if (idx > -1) groups[idx] = current; toast('Tone set: ' + TONE_NAMES[tone]); } catch (e) { toast(e.message, 'err'); }
}

function previewTone() {
  const sel = $('toneSelect');
  const idx = sel ? Number(sel.value) : 0;
  alarm.unlock(); alarm.playToneByIndex(idx, 2);
  toast('Playing: ' + TONE_NAMES[idx], 'info');
}

async function saveGroupSettings() {
  const title = $('adminTitle')?.value?.trim();
  try { const d = await api('POST', '/api/groups/' + current.id + '/settings', { alertTitle: title }); current = d.group; const idx = groups.findIndex(g => g.id === current.id); if (idx > -1) groups[idx] = current; toast('Settings saved'); } catch (e) { toast(e.message, 'err'); }
}

async function leaveGroup() {
  if (!confirm('Leave ' + current.name + '? You will stop receiving alerts.')) return;
  try { await api('POST', '/api/groups/' + current.id + '/leave'); groups = groups.filter(g => g.id !== current.id); current = groups[0] || null; toast('Left the group'); nav('sc-home'); } catch (e) { toast(e.message, 'err'); }
}

async function sendInvite(targetUserId, btn) {
  btn.disabled = true; btn.textContent = '…';
  try {
    await api('POST', '/api/invite', { targetUserId, groupId: current.id });
    btn.outerHTML = '<span class="invite-sent"><svg><use href="#i-check"/></svg>Sent</span>';
    toast('Invite sent');
  } catch (err) { btn.disabled = false; btn.innerHTML = '<svg><use href="#i-send"/></svg>Invite'; toast(err.message, 'err'); }
}

/* ═══════════════════════════════════════════════
   HISTORY
   ═══════════════════════════════════════════════ */
async function renderHistory() {
  const box = $('historyBody');
  if (!current) { $('histGroupName').textContent = ''; box.innerHTML = emptyBlock('i-clock', 'No group selected', 'Create or join first.'); return; }
  $('histGroupName').textContent = current.name;
  box.innerHTML = '<div class="skel" style="height:88px;border-radius:16px"></div>';
  try {
    const list = (await api('GET', '/api/alerts/' + current.id)).alerts || [];
    if (!list.length) { box.innerHTML = emptyBlock('i-clock', 'Nothing yet', 'Alerts will appear here.'); return; }
    const now = Date.now(), today = list.filter(a => now - a.timestamp < 86400000).length, week = list.filter(a => now - a.timestamp < 604800000).length;
    box.innerHTML = `<div class="stats-grid"><div class="stat-box"><p class="n">${list.length}</p><p class="l">Total</p></div><div class="stat-box"><p class="n">${week}</p><p class="l">7 days</p></div><div class="stat-box"><p class="n">${today}</p><p class="l">Today</p></div></div><p class="section-label">Recent alerts</p>${list.map(a => `<div class="list-item"><div class="avatar avatar-danger"><svg style="width:20px;height:20px"><use href="#i-bell-ring"/></svg></div><div class="list-body"><p class="list-title">${esc(a.title)}</p><p class="list-sub">${esc(a.message)}</p><p class="list-sub" style="color:var(--ink-4);margin-top:3px">${esc(a.triggeredBy)} · ${a.membersNotified} notified</p></div><div class="list-meta"><p class="t">${clockTime(a.timestamp)}</p><p class="d">${relDay(a.timestamp)}</p></div></div>`).join('')}`;
  } catch (err) { box.innerHTML = emptyBlock('i-alert', 'Error', err.message); }
}
function emptyBlock(icon, title, text) { return `<div class="empty" style="min-height:52vh"><div class="empty-art"><svg><use href="#${icon}"/></svg></div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`; }

/* ═══════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════ */
function renderSettings() { $('setAvatar').textContent = initial(me?.name); $('setName').textContent = me?.name || ''; $('setEmail').textContent = me?.email || ''; applyThemeUI(); setLiveStatus(sse && sse.readyState === 1 ? 'Connected' : 'Connecting…'); updatePushRow(); }
function toggleTheme() { dark = !dark; localStorage.setItem('wa_theme', dark ? 'dark' : 'light'); applyThemeUI(); }
function applyThemeUI() { document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light'); $('themeToggle')?.classList.toggle('on', dark); document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0A0C14' : '#4F46E5'); }
function testSound() { alarm.unlock(); alarm.playToneByIndex(current?.alertConfig?.tone || 0, ALARM_SECONDS); toast('Playing tone: ' + TONE_NAMES[current?.alertConfig?.tone || 0], 'info'); }

/* ─── PUSH ─── */
async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); await navigator.serviceWorker.ready;
    navigator.serviceWorker.addEventListener('message', e => { const d = e.data || {}; if (d.type === 'ALERT') { if (d.alert) receiveAlert(d.alert); else { alarm.play(ALARM_SECONDS); catchUp(); } } });
    if (token) swReg.active?.postMessage({ type: 'SET_TOKEN', token }); return swReg; } catch (e) { return null; }
}
function urlB64ToU8(b) { const pad = '='.repeat((4 - (b.length % 4)) % 4); const raw = atob((b + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map(c => c.charCodeAt(0))); }
async function enablePush(interactive = false) {
  if (!('Notification' in window)) { if (interactive) toast('Not supported', 'err'); return; }
  if (!swReg) await registerSW(); if (!swReg) { if (interactive) toast('Unavailable', 'err'); return; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') { updatePushRow(); if (interactive) toast('Blocked in settings', 'err'); return; }
  try { const { key } = await (await fetch('/api/push/key')).json(); let sub = await swReg.pushManager.getSubscription(); if (!sub) sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(key) }); await api('POST', '/api/push/subscribe', sub.toJSON()); updatePushRow(); if (interactive) toast('Background alerts on'); } catch (e) { updatePushRow(); if (interactive) toast('Could not enable', 'err'); }
}
function updatePushRow() { const el = $('pushStatus'); if (!el) return; if (!('Notification' in window)) { el.textContent = 'Not supported'; return; } if (Notification.permission === 'granted') el.textContent = 'On — alerts even with screen off'; else if (Notification.permission === 'denied') el.textContent = 'Blocked in browser'; else el.textContent = 'Off — tap to enable'; }

/* ─── INIT ─── */
applyThemeUI();
registerSW().then(() => { if (token) boot(); else nav('sc-login'); });
window.addEventListener('online', () => { reviveLive(); waitLoop(); catchUp(); });
