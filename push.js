/* ============================================================
   Minimal Web Push (VAPID) — Node built-ins only.
   Sends payload-less "tickle" pushes; the Service Worker then
   fetches alert details. Avoids payload encryption entirely.
   ============================================================ */
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const KEY_FILE = path.join(__dirname, 'vapid.json');
const SUBJECT  = 'mailto:admin@workalert.local';

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ---------- key management ---------- */
function loadKeys() {
  if (fs.existsSync(KEY_FILE)) {
    try { return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch (_) {}
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });

  // Uncompressed EC point: 0x04 || X || Y
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const pub = Buffer.concat([Buffer.from([0x04]), x, y]);

  const keys = {
    publicKey: b64url(pub),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  };
  fs.writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

const KEYS = loadKeys();
const PUBLIC_KEY = KEYS.publicKey;

/* ---------- VAPID JWT (ES256) ---------- */
function makeJWT(audience) {
  const header  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: SUBJECT
  }));
  const signingInput = `${header}.${payload}`;

  // ieee-p1363 gives the raw r||s form that JWS ES256 requires
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(KEYS.privatePem),
    dsaEncoding: 'ieee-p1363'
  });

  return `${signingInput}.${b64url(sig)}`;
}

/* ---------- send one push ---------- */
function sendPush(subscription, { ttl = 60, urgency = 'high' } = {}) {
  return new Promise(resolve => {
    let endpoint;
    try { endpoint = new URL(subscription.endpoint); }
    catch (_) { return resolve({ ok: false, status: 0, reason: 'bad endpoint' }); }

    const audience = `${endpoint.protocol}//${endpoint.host}`;
    let jwt;
    try { jwt = makeJWT(audience); }
    catch (e) { return resolve({ ok: false, status: 0, reason: e.message }); }

    const lib = endpoint.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'POST',
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'http:' ? 80 : 443),
      path: endpoint.pathname + endpoint.search,
      headers: {
        'TTL': String(ttl),
        'Urgency': urgency,
        'Content-Length': '0',
        'Authorization': `vapid t=${jwt}, k=${PUBLIC_KEY}`
      },
      timeout: 8000
    }, res => {
      res.resume();
      const status = res.statusCode || 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        // 404/410 mean the subscription is dead and should be removed
        gone: status === 404 || status === 410
      });
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, reason: 'timeout' }); });
    req.on('error', err => resolve({ ok: false, status: 0, reason: err.message }));
    req.end();
  });
}

module.exports = { PUBLIC_KEY, sendPush };
