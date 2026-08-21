/* ============================================================
   WorkAlert Server v2 — OTP, Invites, Realtime
   Zero dependencies (Node built-ins only, + nodemailer for SMTP)
   ============================================================ */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');
const nodemailer = require('nodemailer');
const { PUBLIC_KEY, sendPush } = require('./push');

const PORT    = Number(process.env.PORT) || 3000;
const PUBLIC  = path.join(__dirname, 'public');
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'database.json');

/* ─── SMTP ─── */
const SMTP_USER = process.env.SMTP_USER || 'kunjbhuva301@gmail.com';
const SMTP_PASS = process.env.SMTP_PASS || 'pnjy lbtc xixh xgvr';
const SMTP_FROM = `"WorkAlert" <${SMTP_USER}>`;

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
  tls: { rejectUnauthorized: false }
});

/* ─── ALERT WORDING ─── */
const ALERT_TITLE   = 'Jamun Is Coming ⚠️';
const ALERT_MESSAGE = 'Get ready — someone in your group just raised the alert.';

/* ─── DATABASE ─── */
const EMPTY_DB = { users: {}, groups: {}, alerts: [], sessions: {}, pushSubs: {}, otps: {}, invites: [] };

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) { fs.writeFileSync(DB_FILE, JSON.stringify(EMPTY_DB, null, 2)); return structuredClone(EMPTY_DB); }
    const raw = fs.readFileSync(DB_FILE, 'utf8').trim();
    if (!raw) return structuredClone(EMPTY_DB);
    return { ...structuredClone(EMPTY_DB), ...JSON.parse(raw) };
  } catch (e) { console.error('DB read error:', e.message); return structuredClone(EMPTY_DB); }
}
function saveDB(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ─── HELPERS ─── */
const uuid = () => crypto.randomUUID();
const normEmail = v => { const s = String(v||'').toLowerCase().trim(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null; };
const genCode = () => { const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<6;i++) s+=A[crypto.randomInt(A.length)]; return s; };
const gen4 = () => String(crypto.randomInt(1000, 9999));

function sessionUser(db, token) {
  if (!token) return null;
  const uid = db.sessions[token];
  return uid ? db.users[uid] || null : null;
}
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, groups: u.groups || [] });
const publicGroup = g => ({ id: g.id, name: g.name, description: g.description, adminId: g.adminId, adminName: g.adminName, code: g.code, members: g.members, alertConfig: g.alertConfig, emoji: g.emoji || '🔔', createdAt: g.createdAt });

/* ─── LIVE CONNECTIONS ─── */
const live = new Map();
function pushTo(userId, payload) {
  const set = live.get(userId); if (!set) return 0;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  let n = 0;
  for (const res of set) { try { res.write(frame); n++; } catch(_) { set.delete(res); } }
  return n;
}

/* long-poll waiters */
const waiters = new Map();
function addWaiter(userId, res, timer) {
  if (!waiters.has(userId)) waiters.set(userId, new Set());
  const entry = { res, timer }; waiters.get(userId).add(entry); return entry;
}
function dropWaiter(userId, entry) {
  const set = waiters.get(userId); if (!set) return;
  set.delete(entry); if (!set.size) waiters.delete(userId);
}
function wakeWaiters(userId, alert) {
  const set = waiters.get(userId); if (!set || !set.size) return 0;
  let n = 0;
  for (const entry of [...set]) {
    clearTimeout(entry.timer); set.delete(entry);
    try { sendJSON(entry.res, 200, { alerts: [alert], now: Date.now() }); n++; } catch(_) {}
  }
  if (!set.size) waiters.delete(userId); return n;
}

/* Web Push fan-out */
async function notifyOffline(userIds) {
  const db = loadDB(); const dead = [];
  await Promise.all(userIds.flatMap(uid => {
    const subs = db.pushSubs?.[uid] || [];
    return subs.map(async sub => { const r = await sendPush(sub); if (r.gone) dead.push([uid, sub.endpoint]); });
  }));
  if (dead.length) {
    const fresh = loadDB();
    for (const [uid, ep] of dead) { if (!fresh.pushSubs?.[uid]) continue; fresh.pushSubs[uid] = fresh.pushSubs[uid].filter(s => s.endpoint !== ep); if (!fresh.pushSubs[uid].length) delete fresh.pushSubs[uid]; }
    saveDB(fresh);
  }
}

function alertsFor(db, user, since = 0) {
  const mine = new Set(user.groups || []);
  return db.alerts.filter(a => mine.has(a.groupId) && a.triggeredById !== user.id && a.timestamp > since).slice(0, 20);
}

/* ─── HTTP HELPERS ─── */
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.ico':'image/x-icon', '.webmanifest':'application/manifest+json' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(body), 'Cache-Control':'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 1e6) { reject(new Error('Too large')); req.destroy(); return; } data += chunk; });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch(_) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => { if (e2) { res.writeHead(404).end('Not found'); return; } res.writeHead(200, {'Content-Type':MIME['.html']}); res.end(html); }); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60' });
    res.end(buf);
  });
}

/* ─── SEND OTP EMAIL ─── */
async function sendOTP(email, code) {
  const html = `
    <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px 24px;background:#f9fafb;border-radius:16px">
      <h2 style="color:#1a1d2e;margin:0 0 8px">Your verification code</h2>
      <p style="color:#5b6178;margin:0 0 24px;font-size:15px">Enter this code in WorkAlert to verify your email. It expires in 30 seconds.</p>
      <div style="background:#4F46E5;color:#fff;font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;padding:18px;border-radius:12px">${code}</div>
      <p style="color:#9ca3bf;font-size:12px;margin-top:20px;text-align:center">If you didn't request this, ignore this email.</p>
    </div>`;
  await transporter.sendMail({
    from: SMTP_FROM,
    to: email,
    subject: `${code} is your WorkAlert code`,
    html
  });
}

/* ─── ROUTER ─── */
async function handleAPI(req, res, url) {
  const route = url.pathname;
  const method = req.method;
  const token = req.headers['x-token'] || url.searchParams.get('token');

  /* ════ SSE ════ */
  if (route === '/api/events' && method === 'GET') {
    const db = loadDB(); const user = sessionUser(db, token);
    if (!user) { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache, no-store, no-transform', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' });
    res.write(':' + ' '.repeat(2048) + '\n\n');
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({type:'connected'})}\n\n`);
    if (!live.has(user.id)) live.set(user.id, new Set());
    live.get(user.id).add(res);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch(_) {} }, 15000);
    const cleanup = () => { clearInterval(hb); const set = live.get(user.id); if (set) { set.delete(res); if (!set.size) live.delete(user.id); } };
    req.on('close', cleanup); req.on('error', cleanup);
    return;
  }

  /* ════ VAPID KEY (public) ════ */
  if (route === '/api/push/key' && method === 'GET') return sendJSON(res, 200, { key: PUBLIC_KEY });

  /* ════ AUTH: SIGN IN (email must exist in DB) ════ */
  if (route === '/api/auth/enter' && method === 'POST') {
    const { email } = await readBody(req);
    const mail = normEmail(email);
    if (!mail) return sendJSON(res, 400, { error: 'Enter a valid email address' });
    const db = loadDB();
    const user = Object.values(db.users).find(u => u.email === mail);
    if (!user) return sendJSON(res, 404, { error: 'No account found. Please create one first.' });
    const tk = uuid(); db.sessions[tk] = user.id; saveDB(db);
    return sendJSON(res, 200, { token: tk, user: publicUser(user) });
  }

  /* ════ AUTH: REGISTER STEP 1 — send OTP ════ */
  if (route === '/api/auth/send-otp' && method === 'POST') {
    const { email, name } = await readBody(req);
    const mail = normEmail(email);
    if (!mail) return sendJSON(res, 400, { error: 'Enter a valid email address' });
    if (!name || String(name).trim().length < 2) return sendJSON(res, 400, { error: 'Please enter your name' });
    const db = loadDB();
    if (Object.values(db.users).some(u => u.email === mail))
      return sendJSON(res, 400, { error: 'This email is already registered. Go to Sign In.' });

    const code = gen4();
    db.otps[mail] = { code, name: String(name).trim().slice(0, 60), expiresAt: Date.now() + 30000 };
    saveDB(db);

    try { await sendOTP(mail, code); }
    catch (e) { console.error('Email send failed:', e.message, e.code); return sendJSON(res, 500, { error: 'Could not send email: ' + e.message }); }

    return sendJSON(res, 200, { ok: true, email: mail });
  }

  /* ════ AUTH: REGISTER STEP 2 — verify OTP ════ */
  if (route === '/api/auth/verify-otp' && method === 'POST') {
    const { email, code } = await readBody(req);
    const mail = normEmail(email);
    if (!mail || !code) return sendJSON(res, 400, { error: 'Email and code required' });
    const db = loadDB();
    const otp = db.otps[mail];
    if (!otp) return sendJSON(res, 400, { error: 'No code was sent to this email. Request a new one.' });
    if (Date.now() > otp.expiresAt) { delete db.otps[mail]; saveDB(db); return sendJSON(res, 400, { error: 'Code expired. Tap Resend.' }); }
    if (otp.code !== String(code).trim()) return sendJSON(res, 400, { error: 'Wrong code. Check your email.' });

    // Create the user
    const id = uuid();
    db.users[id] = { id, name: otp.name, email: mail, groups: [], createdAt: Date.now() };
    delete db.otps[mail];
    const tk = uuid(); db.sessions[tk] = id;
    saveDB(db);
    return sendJSON(res, 200, { token: tk, user: publicUser(db.users[id]) });
  }

  /* ════ AUTH: RESEND OTP ════ */
  if (route === '/api/auth/resend-otp' && method === 'POST') {
    const { email } = await readBody(req);
    const mail = normEmail(email);
    if (!mail) return sendJSON(res, 400, { error: 'Invalid email' });
    const db = loadDB();
    const prev = db.otps[mail];
    if (!prev) return sendJSON(res, 400, { error: 'Start registration again' });
    const code = gen4();
    db.otps[mail] = { ...prev, code, expiresAt: Date.now() + 30000 };
    saveDB(db);
    try { await sendOTP(mail, code); } catch(e) { return sendJSON(res, 500, { error: 'Email failed' }); }
    return sendJSON(res, 200, { ok: true });
  }

  /* ════ EVERYTHING BELOW NEEDS AUTH ════ */
  const db = loadDB();
  const user = sessionUser(db, token);
  if (!user) return sendJSON(res, 401, { error: 'Session expired. Please sign in again.' });

  /* ── LOGOUT ── */
  if (route === '/api/logout' && method === 'POST') { delete db.sessions[token]; saveDB(db); return sendJSON(res, 200, { ok: true }); }

  /* ── ME ── */
  if (route === '/api/me' && method === 'GET') return sendJSON(res, 200, { user: publicUser(user) });

  /* ── ALL REGISTERED USERS (for invite picker) ── */
  if (route === '/api/users' && method === 'GET') {
    const list = Object.values(db.users).map(u => ({ id: u.id, name: u.name, email: u.email }));
    return sendJSON(res, 200, { users: list });
  }

  /* ── MY GROUPS ── */
  if (route === '/api/groups' && method === 'GET') {
    const list = (user.groups || []).map(id => db.groups[id]).filter(Boolean).map(publicGroup);
    return sendJSON(res, 200, { groups: list });
  }

  /* ── CREATE GROUP ── */
  if (route === '/api/groups' && method === 'POST') {
    const { name, description } = await readBody(req);
    if (!name || !String(name).trim()) return sendJSON(res, 400, { error: 'Group name is required' });
    let code = genCode();
    const taken = new Set(Object.values(db.groups).map(g => g.code));
    let guard = 0; while (taken.has(code) && guard++ < 50) code = genCode();
    const id = uuid();
    db.groups[id] = { id, name: String(name).trim().slice(0,60), description: String(description||'').trim().slice(0,140), adminId: user.id, adminName: user.name, code, members: [{ id: user.id, name: user.name, email: user.email }], alertConfig: { title: ALERT_TITLE, message: ALERT_MESSAGE, tone: 0 }, emoji: '🔔', createdAt: Date.now() };
    db.users[user.id].groups = [...new Set([...(user.groups||[]), id])];
    saveDB(db);
    return sendJSON(res, 200, { group: publicGroup(db.groups[id]) });
  }

  /* ── JOIN GROUP BY CODE ── */
  if (route === '/api/groups/join' && method === 'POST') {
    const { code } = await readBody(req);
    if (!code) return sendJSON(res, 400, { error: 'Join code required' });
    const wanted = String(code).toUpperCase().trim();
    const group = Object.values(db.groups).find(g => g.code === wanted);
    if (!group) return sendJSON(res, 400, { error: 'No group with that code' });
    if (group.members.some(m => m.id === user.id)) return sendJSON(res, 400, { error: 'Already in this group' });
    group.members.push({ id: user.id, name: user.name, email: user.email });
    db.users[user.id].groups = [...new Set([...(user.groups||[]), group.id])];
    saveDB(db);
    group.members.filter(m => m.id !== user.id).forEach(m => pushTo(m.id, { type: 'member_joined', groupId: group.id, groupName: group.name, name: user.name }));
    return sendJSON(res, 200, { group: publicGroup(group) });
  }

  /* ── SEND INVITE (to another registered user) ── */
  if (route === '/api/invite' && method === 'POST') {
    const { targetUserId, groupId } = await readBody(req);
    const group = db.groups[groupId];
    if (!group) return sendJSON(res, 400, { error: 'Group not found' });
    if (!group.members.some(m => m.id === user.id)) return sendJSON(res, 403, { error: 'You are not in this group' });
    const target = db.users[targetUserId];
    if (!target) return sendJSON(res, 400, { error: 'User not found' });
    if (group.members.some(m => m.id === targetUserId)) return sendJSON(res, 400, { error: target.name + ' is already in this group' });

    // Check if invite already pending
    const existing = db.invites.find(i => i.targetId === targetUserId && i.groupId === groupId && i.status === 'pending');
    if (existing) return sendJSON(res, 400, { error: 'Invite already sent' });

    const inv = { id: uuid(), fromId: user.id, fromName: user.name, targetId: targetUserId, targetName: target.name, groupId, groupName: group.name, status: 'pending', createdAt: Date.now() };
    db.invites.push(inv);
    saveDB(db);

    // Notify the target in real-time
    pushTo(targetUserId, { type: 'invite', invite: inv });
    // Also web push
    notifyOffline([targetUserId]).catch(() => {});

    return sendJSON(res, 200, { invite: inv });
  }

  /* ── MY PENDING INVITES ── */
  if (route === '/api/invites' && method === 'GET') {
    const pending = (db.invites || []).filter(i => i.targetId === user.id && i.status === 'pending');
    return sendJSON(res, 200, { invites: pending });
  }

  /* ── RESPOND TO INVITE ── */
  if (route === '/api/invite/respond' && method === 'POST') {
    const { inviteId, accept } = await readBody(req);
    const inv = (db.invites || []).find(i => i.id === inviteId && i.targetId === user.id);
    if (!inv) return sendJSON(res, 400, { error: 'Invite not found' });
    if (inv.status !== 'pending') return sendJSON(res, 400, { error: 'Already responded' });

    inv.status = accept ? 'accepted' : 'rejected';

    if (accept) {
      const group = db.groups[inv.groupId];
      if (group && !group.members.some(m => m.id === user.id)) {
        group.members.push({ id: user.id, name: user.name, email: user.email });
        db.users[user.id].groups = [...new Set([...(user.groups||[]), group.id])];
        // Notify group
        group.members.filter(m => m.id !== user.id).forEach(m => pushTo(m.id, { type: 'member_joined', groupId: group.id, groupName: group.name, name: user.name }));
      }
    }

    // Notify the inviter
    pushTo(inv.fromId, { type: 'invite_response', invite: inv, respondedBy: user.name });
    saveDB(db);
    return sendJSON(res, 200, { ok: true, status: inv.status });
  }

  /* ── GROUP MEMBERS ── */
  let m = route.match(/^\/api\/groups\/([^/]+)\/members$/);
  if (m && method === 'GET') {
    const group = db.groups[m[1]];
    if (!group) return sendJSON(res, 404, { error: 'Group not found' });
    if (!group.members.some(x => x.id === user.id)) return sendJSON(res, 403, { error: 'Not a member' });
    return sendJSON(res, 200, { members: group.members, code: group.code, adminId: group.adminId });
  }

  /* ── UPDATE GROUP SETTINGS (admin only) ── */
  if (route.match(/^\/api\/groups\/[^/]+\/settings$/) && method === 'POST') {
    const gid = route.split('/')[3];
    const group = db.groups[gid];
    if (!group) return sendJSON(res, 404, { error: 'Group not found' });
    if (group.adminId !== user.id) return sendJSON(res, 403, { error: 'Only the admin can change settings' });
    const { emoji, alertTitle, alertMessage, tone } = await readBody(req);
    if (emoji !== undefined) group.emoji = String(emoji).slice(0, 4);
    if (alertTitle !== undefined) group.alertConfig.title = String(alertTitle).trim().slice(0, 60) || ALERT_TITLE;
    if (alertMessage !== undefined) group.alertConfig.message = String(alertMessage).trim().slice(0, 200) || ALERT_MESSAGE;
    if (tone !== undefined) group.alertConfig.tone = Math.max(0, Math.min(9, Number(tone) || 0));
    saveDB(db);
    return sendJSON(res, 200, { group: publicGroup(group) });
  }

  /* ── LEAVE GROUP (non-admin) ── */
  if (route.match(/^\/api\/groups\/[^/]+\/leave$/) && method === 'POST') {
    const gid = route.split('/')[3];
    const group = db.groups[gid];
    if (!group) return sendJSON(res, 404, { error: 'Group not found' });
    if (group.adminId === user.id) return sendJSON(res, 400, { error: 'Admin cannot leave. Transfer admin first or delete the group.' });
    if (!group.members.some(m => m.id === user.id)) return sendJSON(res, 400, { error: 'Not in this group' });
    group.members = group.members.filter(m => m.id !== user.id);
    db.users[user.id].groups = (user.groups || []).filter(g => g !== gid);
    saveDB(db);
    group.members.forEach(m => pushTo(m.id, { type: 'member_left', groupId: gid, groupName: group.name, name: user.name }));
    return sendJSON(res, 200, { ok: true });
  }

  /* ── TRIGGER ALERT ── */
  if (route === '/api/alert' && method === 'POST') {
    const { groupId } = await readBody(req);
    const group = db.groups[groupId];
    if (!group) return sendJSON(res, 400, { error: 'Group not found' });
    if (!group.members.some(x => x.id === user.id)) return sendJSON(res, 403, { error: 'Not a member' });

    const alert = { id: uuid(), groupId: group.id, groupName: group.name, triggeredBy: user.name, triggeredById: user.id, title: group.alertConfig?.title || ALERT_TITLE, message: group.alertConfig?.message || ALERT_MESSAGE, tone: group.alertConfig?.tone || 0, membersNotified: group.members.length, timestamp: Date.now() };
    db.alerts.unshift(alert);
    if (db.alerts.length > 500) db.alerts.length = 500;
    saveDB(db);

    const recipients = group.members.filter(mm => mm.id !== user.id).map(mm => mm.id);
    let woken = 0; recipients.forEach(id => { woken += wakeWaiters(id, alert); });
    let delivered = 0; recipients.forEach(id => { delivered += pushTo(id, alert); });
    notifyOffline(recipients).catch(e => console.error('push:', e.message));
    console.log(`[alert] ${user.name} → "${group.name}" · ${recipients.length} recv (${woken} poll, ${delivered} sse)`);
    return sendJSON(res, 200, { alert, memberCount: group.members.length, delivered });
  }

  /* ── PENDING ALERTS ── */
  if (route === '/api/pending' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    return sendJSON(res, 200, { alerts: alertsFor(db, user, since), now: Date.now() });
  }

  /* ── LONG POLL ── */
  if (route === '/api/wait' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const backlog = alertsFor(db, user, since);
    if (backlog.length) return sendJSON(res, 200, { alerts: backlog, now: Date.now() });
    let entry;
    const timer = setTimeout(() => { dropWaiter(user.id, entry); try { sendJSON(res, 200, { alerts: [], now: Date.now() }); } catch(_) {} }, 25000);
    entry = addWaiter(user.id, res, timer);
    req.on('close', () => { clearTimeout(timer); dropWaiter(user.id, entry); });
    return;
  }

  /* ── ALERT HISTORY ── */
  m = route.match(/^\/api\/alerts\/([^/]+)$/);
  if (m && method === 'GET') {
    const group = db.groups[m[1]];
    if (!group) return sendJSON(res, 404, { error: 'Group not found' });
    if (!group.members.some(x => x.id === user.id)) return sendJSON(res, 403, { error: 'Not a member' });
    const alerts = db.alerts.filter(a => a.groupId === group.id).slice(0, 60);
    return sendJSON(res, 200, { alerts });
  }

  /* ── PUSH SUBSCRIBE ── */
  if (route === '/api/push/subscribe' && method === 'POST') {
    const sub = await readBody(req);
    if (!sub || !sub.endpoint) return sendJSON(res, 400, { error: 'Invalid subscription' });
    if (!db.pushSubs) db.pushSubs = {};
    const list = db.pushSubs[user.id] || [];
    if (!list.some(s => s.endpoint === sub.endpoint)) list.push({ endpoint: sub.endpoint, keys: sub.keys || {}, createdAt: Date.now() });
    db.pushSubs[user.id] = list.slice(-5);
    saveDB(db);
    return sendJSON(res, 200, { ok: true });
  }

  /* ── PUSH UNSUBSCRIBE ── */
  if (route === '/api/push/unsubscribe' && method === 'POST') {
    const { endpoint } = await readBody(req);
    if (db.pushSubs?.[user.id]) { db.pushSubs[user.id] = db.pushSubs[user.id].filter(s => s.endpoint !== endpoint); if (!db.pushSubs[user.id].length) delete db.pushSubs[user.id]; saveDB(db); }
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'Unknown endpoint' });
}

/* ─── SERVER ─── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (url.pathname.startsWith('/api/')) {
    handleAPI(req, res, url).catch(err => { console.error('API error:', err); if (!res.headersSent) sendJSON(res, 500, { error: err.message || 'Server error' }); });
    return;
  }
  serveStatic(req, res, url.pathname);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.on('error', err => { if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} in use`); else console.error('Server error:', err); process.exit(1); });
server.listen(PORT, '0.0.0.0', () => {
  let ip = 'localhost';
  for (const list of Object.values(os.networkInterfaces())) for (const n of list||[]) if (n.family === 'IPv4' && !n.internal) { ip = n.address; break; }
  console.log(`\n  ✅  WorkAlert v2\n\n      Local     http://localhost:${PORT}\n      Network   http://${ip}:${PORT}\n`);
});
