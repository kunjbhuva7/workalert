/* ============================================================
   WorkAlert Server — zero dependencies (Node built-ins only)
   ============================================================ */
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');
const { PUBLIC_KEY, sendPush } = require('./push');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC   = path.join(__dirname, 'public');
const DB_FILE  = path.join(process.env.DATA_DIR || __dirname, 'database.json');

/* ─────────── ALERT WORDING ─────────── */
const ALERT_TITLE   = 'Jamun Is Coming ⚠️';
const ALERT_MESSAGE = 'Get ready — someone in your group just raised the alert.';

/* ─────────── DATABASE (JSON file) ─────────── */
const EMPTY_DB = { users: {}, groups: {}, alerts: [], sessions: {}, pushSubs: {} };

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(EMPTY_DB, null, 2));
      return structuredClone(EMPTY_DB);
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8').trim();
    if (!raw) return structuredClone(EMPTY_DB);
    const db = JSON.parse(raw);
    return { ...structuredClone(EMPTY_DB), ...db };
  } catch (e) {
    console.error('DB read failed, starting fresh:', e.message);
    return structuredClone(EMPTY_DB);
  }
}

function saveDB(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ─────────── HELPERS ─────────── */
function normEmail(v) {
  const s = String(v || '').toLowerCase().trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

const uuid = () => crypto.randomUUID();
const genCode = () => {
  // Unambiguous alphabet (no O/0, I/1)
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)];
  return s;
};

/* ─────────── LIVE CONNECTIONS (SSE) ─────────── */
const live = new Map();   // userId -> Set<res>

function pushTo(userId, payload) {
  const set = live.get(userId);
  if (!set) return 0;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  let n = 0;
  for (const res of set) {
    try { res.write(frame); n++; } catch (_) { set.delete(res); }
  }
  return n;
}

/* ─────────── LONG-POLL WAITERS ───────────
   SSE gets buffered by some reverse proxies (Cloudflare quick
   tunnels among them). A held request that answers once and
   closes passes through any proxy, so this is the primary
   transport and SSE is a bonus on local networks.            */
const waiters = new Map();   // userId -> Set<{ res, timer }>

function addWaiter(userId, res, timer) {
  if (!waiters.has(userId)) waiters.set(userId, new Set());
  const entry = { res, timer };
  waiters.get(userId).add(entry);
  return entry;
}

function dropWaiter(userId, entry) {
  const set = waiters.get(userId);
  if (!set) return;
  set.delete(entry);
  if (!set.size) waiters.delete(userId);
}

function wakeWaiters(userId, alert) {
  const set = waiters.get(userId);
  if (!set || !set.size) return 0;
  let n = 0;
  for (const entry of [...set]) {
    clearTimeout(entry.timer);
    set.delete(entry);
    try { sendJSON(entry.res, 200, { alerts: [alert], now: Date.now() }); n++; } catch (_) {}
  }
  if (!set.size) waiters.delete(userId);
  return n;
}

/* ─────────── WEB PUSH FAN-OUT (works with screen off) ─────────── */
async function notifyOffline(userIds) {
  const db = loadDB();
  const dead = [];

  await Promise.all(userIds.flatMap(uid => {
    const subs = db.pushSubs?.[uid] || [];
    return subs.map(async sub => {
      const r = await sendPush(sub);
      if (r.gone) dead.push([uid, sub.endpoint]);
    });
  }));

  if (dead.length) {
    const fresh = loadDB();
    for (const [uid, endpoint] of dead) {
      if (!fresh.pushSubs?.[uid]) continue;
      fresh.pushSubs[uid] = fresh.pushSubs[uid].filter(s => s.endpoint !== endpoint);
      if (!fresh.pushSubs[uid].length) delete fresh.pushSubs[uid];
    }
    saveDB(fresh);
  }
}

/* ─────────── HTTP HELPERS ─────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1e6) { reject(new Error('Payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Prevent path traversal
  const filePath = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return; }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60'
    });
    res.end(buf);
  });
}

function sessionUser(db, token) {
  if (!token) return null;
  const uid = db.sessions[token];
  if (!uid) return null;
  return db.users[uid] || null;
}

/* Alerts in this user's groups that they did not send themselves */
function alertsFor(db, user, since = 0) {
  const mine = new Set(user.groups || []);
  return db.alerts.filter(a =>
    mine.has(a.groupId) &&
    a.triggeredById !== user.id &&
    a.timestamp > since
  ).slice(0, 20);
}

const publicUser = u => ({ id: u.id, name: u.name, email: u.email, groups: u.groups || [] });
const publicGroup = g => ({
  id: g.id, name: g.name, description: g.description,
  adminId: g.adminId, adminName: g.adminName, code: g.code,
  members: g.members, alertConfig: g.alertConfig, createdAt: g.createdAt
});

/* ─────────── ROUTER ─────────── */
async function handleAPI(req, res, url) {
  const route = url.pathname;
  const method = req.method;
  const token = req.headers['x-token'] || url.searchParams.get('token');

  /* ---- SSE stream ---- */
  if (route === '/api/events' && method === 'GET') {
    const db = loadDB();
    const user = sessionUser(db, token);
    if (!user) { res.writeHead(401).end(); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Reverse proxies (Cloudflare, nginx) hold small responses in a buffer.
    // A 2 KB comment pushes past that buffer so events flush immediately.
    res.write(':' + ' '.repeat(2048) + '\n\n');
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    if (typeof res.flush === 'function') res.flush();

    if (!live.has(user.id)) live.set(user.id, new Set());
    live.get(user.id).add(res);

    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
    const cleanup = () => {
      clearInterval(hb);
      const set = live.get(user.id);
      if (set) { set.delete(res); if (!set.size) live.delete(user.id); }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    return;
  }

  /* ---- STEP 1: does this email already have an account? ---- */
  if (route === '/api/auth/check' && method === 'POST') {
    const { email } = await readBody(req);
    const mail = normEmail(email);
    if (!mail) return sendJSON(res, 400, { error: 'Enter a valid email address' });

    const db = loadDB();
    const user = Object.values(db.users).find(u => u.email === mail);
    return sendJSON(res, 200, { exists: !!user, name: user ? user.name : null });
  }

  /* ---- STEP 2a: existing account → sign in ---- */
  if (route === '/api/auth/enter' && method === 'POST') {
    const { email } = await readBody(req);
    const mail = normEmail(email);
    if (!mail) return sendJSON(res, 400, { error: 'Enter a valid email address' });

    const db = loadDB();
    const user = Object.values(db.users).find(u => u.email === mail);
    if (!user) return sendJSON(res, 404, { error: 'No account for this email' });

    const tk = uuid();
    db.sessions[tk] = user.id;
    saveDB(db);
    return sendJSON(res, 200, { token: tk, user: publicUser(user) });
  }

  /* ---- STEP 2b: new email → create the account ---- */
  if (route === '/api/auth/register' && method === 'POST') {
    const { email, name } = await readBody(req);
    const mail = normEmail(email);
    if (!mail) return sendJSON(res, 400, { error: 'Enter a valid email address' });

    const db = loadDB();
    if (Object.values(db.users).some(u => u.email === mail))
      return sendJSON(res, 400, { error: 'This email is already registered' });

    const clean = String(name || '').trim().slice(0, 60);
    if (clean.length < 2) return sendJSON(res, 400, { error: 'Please enter your name' });

    const id = uuid();
    db.users[id] = {
      id,
      name: clean,
      email: mail,
      groups: [],
      createdAt: Date.now()
    };
    saveDB(db);
    // No token on purpose — the client returns to the email screen to sign in.
    return sendJSON(res, 200, { ok: true, email: mail });
  }

  /* ---- VAPID public key (open) ---- */
  if (route === '/api/push/key' && method === 'GET') {
    return sendJSON(res, 200, { key: PUBLIC_KEY });
  }

  /* ---- Everything below needs auth ---- */
  const db = loadDB();
  const user = sessionUser(db, token);
  if (!user) return sendJSON(res, 401, { error: 'Session expired. Please sign in again.' });

  /* ---- LOGOUT ---- */
  if (route === '/api/logout' && method === 'POST') {
    delete db.sessions[token];
    saveDB(db);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- ME ---- */
  if (route === '/api/me' && method === 'GET') {
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  /* ---- MY GROUPS ---- */
  if (route === '/api/groups' && method === 'GET') {
    const list = (user.groups || []).map(id => db.groups[id]).filter(Boolean).map(publicGroup);
    return sendJSON(res, 200, { groups: list });
  }

  /* ---- CREATE GROUP ---- */
  if (route === '/api/groups' && method === 'POST') {
    const { name, description } = await readBody(req);
    if (!name || !String(name).trim()) return sendJSON(res, 400, { error: 'Group name is required' });

    let code = genCode();
    const taken = new Set(Object.values(db.groups).map(g => g.code));
    let guard = 0;
    while (taken.has(code) && guard++ < 50) code = genCode();

    const id = uuid();
    db.groups[id] = {
      id,
      name: String(name).trim().slice(0, 60),
      description: String(description || '').trim().slice(0, 140),
      adminId: user.id,
      adminName: user.name,
      code,
      members: [{ id: user.id, name: user.name, email: user.email }],
      alertConfig: {
        title: ALERT_TITLE,
        message: ALERT_MESSAGE
      },
      createdAt: Date.now()
    };
    db.users[user.id].groups = [...new Set([...(user.groups || []), id])];
    saveDB(db);
    return sendJSON(res, 200, { group: publicGroup(db.groups[id]) });
  }

  /* ---- JOIN GROUP ---- */
  if (route === '/api/groups/join' && method === 'POST') {
    const { code } = await readBody(req);
    if (!code) return sendJSON(res, 400, { error: 'Join code is required' });

    const wanted = String(code).toUpperCase().trim();
    const group = Object.values(db.groups).find(g => g.code === wanted);
    if (!group) return sendJSON(res, 400, { error: 'No group found with that code' });
    if (group.members.some(m => m.id === user.id))
      return sendJSON(res, 400, { error: 'You are already in this group' });

    group.members.push({ id: user.id, name: user.name, email: user.email });
    db.users[user.id].groups = [...new Set([...(user.groups || []), group.id])];
    saveDB(db);

    // Notify existing members that someone joined
    group.members
      .filter(m => m.id !== user.id)
      .forEach(m => pushTo(m.id, { type: 'member_joined', groupId: group.id, groupName: group.name, name: user.name }));

    return sendJSON(res, 200, { group: publicGroup(group) });
  }

  /* ---- GROUP MEMBERS ---- */
  let m = route.match(/^\/api\/groups\/([^/]+)\/members$/);
  if (m && method === 'GET') {
    const group = db.groups[m[1]];
    if (!group) return sendJSON(res, 404, { error: 'Group not found' });
    if (!group.members.some(x => x.id === user.id))
      return sendJSON(res, 403, { error: 'You are not a member of this group' });
    return sendJSON(res, 200, { members: group.members, code: group.code, adminId: group.adminId });
  }

  /* ---- TRIGGER ALERT ---- */
  if (route === '/api/alert' && method === 'POST') {
    const { groupId } = await readBody(req);
    const group = db.groups[groupId];
    if (!group) return sendJSON(res, 400, { error: 'Group not found' });
    if (!group.members.some(x => x.id === user.id))
      return sendJSON(res, 403, { error: 'You are not a member of this group' });

    const alert = {
      id: uuid(),
      groupId: group.id,
      groupName: group.name,
      triggeredBy: user.name,
      triggeredById: user.id,
      title: ALERT_TITLE,
      message: group.alertConfig?.message || ALERT_MESSAGE,
      membersNotified: group.members.length,
      timestamp: Date.now()
    };
    db.alerts.unshift(alert);
    if (db.alerts.length > 500) db.alerts.length = 500;
    saveDB(db);

    // Recipients = every group member except the sender
    const recipients = group.members.filter(m => m.id !== user.id).map(m => m.id);

    // 1) Wake anyone holding a long-poll — works through every proxy
    let woken = 0;
    recipients.forEach(id => { woken += wakeWaiters(id, alert); });

    // 2) Also push down open SSE streams (instant on local networks)
    let delivered = 0;
    recipients.forEach(id => { delivered += pushTo(id, alert); });

    // 3) Web Push — reaches phones with the screen off
    notifyOffline(recipients).catch(e => console.error('push fan-out:', e.message));

    console.log(`[alert] ${user.name} → "${group.name}" · ${recipients.length} recipients (${woken} long-poll, ${delivered} sse)`);
    return sendJSON(res, 200, { alert, memberCount: group.members.length, delivered });
  }

  /* ---- PENDING ALERTS (instant catch-up) ---- */
  if (route === '/api/pending' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    return sendJSON(res, 200, { alerts: alertsFor(db, user, since), now: Date.now() });
  }

  /* ---- LONG POLL: hold until an alert arrives ---- */
  if (route === '/api/wait' && method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);

    // Anything already waiting? Answer straight away.
    const backlog = alertsFor(db, user, since);
    if (backlog.length) return sendJSON(res, 200, { alerts: backlog, now: Date.now() });

    let entry;
    const timer = setTimeout(() => {
      dropWaiter(user.id, entry);
      try { sendJSON(res, 200, { alerts: [], now: Date.now() }); } catch (_) {}
    }, 25000);

    entry = addWaiter(user.id, res, timer);
    req.on('close', () => { clearTimeout(timer); dropWaiter(user.id, entry); });
    return;
  }

  /* ---- SAVE PUSH SUBSCRIPTION ---- */
  if (route === '/api/push/subscribe' && method === 'POST') {
    const sub = await readBody(req);
    if (!sub || !sub.endpoint) return sendJSON(res, 400, { error: 'Invalid subscription' });

    if (!db.pushSubs) db.pushSubs = {};
    const list = db.pushSubs[user.id] || [];
    if (!list.some(s => s.endpoint === sub.endpoint)) {
      list.push({ endpoint: sub.endpoint, keys: sub.keys || {}, createdAt: Date.now() });
    }
    db.pushSubs[user.id] = list.slice(-5);   // cap devices per user
    saveDB(db);
    return sendJSON(res, 200, { ok: true, devices: db.pushSubs[user.id].length });
  }

  /* ---- REMOVE PUSH SUBSCRIPTION ---- */
  if (route === '/api/push/unsubscribe' && method === 'POST') {
    const { endpoint } = await readBody(req);
    if (db.pushSubs?.[user.id]) {
      db.pushSubs[user.id] = db.pushSubs[user.id].filter(s => s.endpoint !== endpoint);
      if (!db.pushSubs[user.id].length) delete db.pushSubs[user.id];
      saveDB(db);
    }
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- ALERT HISTORY ---- */
  m = route.match(/^\/api\/alerts\/([^/]+)$/);
  if (m && method === 'GET') {
    const group = db.groups[m[1]];
    if (!group) return sendJSON(res, 404, { error: 'Group not found' });
    if (!group.members.some(x => x.id === user.id))
      return sendJSON(res, 403, { error: 'You are not a member of this group' });
    const alerts = db.alerts.filter(a => a.groupId === group.id).slice(0, 60);
    return sendJSON(res, 200, { alerts });
  }

  return sendJSON(res, 404, { error: 'Unknown endpoint' });
}

/* ─────────── SERVER ─────────── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (url.pathname.startsWith('/api/')) {
    handleAPI(req, res, url).catch(err => {
      console.error('API error:', err);
      if (!res.headersSent) sendJSON(res, 500, { error: err.message || 'Server error' });
    });
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.keepAliveTimeout = 65000;
server.headersTimeout   = 66000;

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use.\n    Try:  PORT=3001 node server.js\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  let ip = 'localhost';
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) { ip = n.address; break; }
    }
  }
  console.log('');
  console.log('  ✅  WorkAlert is running');
  console.log('');
  console.log(`      Local     http://localhost:${PORT}`);
  console.log(`      Network   http://${ip}:${PORT}`);
  console.log('');
  console.log('      Share the Network URL with people on the same Wi-Fi.');
  console.log('');
});
