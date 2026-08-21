/* ============================================================
   WorkAlert — Service Worker v4
   Background delivery: push notification with OS sound + vibrate
   ============================================================ */

const SW_VERSION = 'wa-v4';
const ALERT_TITLE = 'Jamun Is Coming ⚠️';
const BUZZ_PATTERN = [0, 900, 160, 900, 160, 900, 200, 1400];

/* ─── IndexedDB ─── */
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('workalert', 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv'); };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction('kv', mode), store = tx.objectStore('kv');
      let out; try { out = fn(store); } catch (e) { reject(e); return; }
      tx.oncomplete = () => { db.close(); resolve(out?.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
const kvGet = k => idb('readonly', s => s.get(k));
const kvSet = (k, v) => idb('readwrite', s => s.put(v, k));

/* ─── Lifecycle ─── */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* ─── Messages from the page ─── */
self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type === 'SET_TOKEN') kvSet('token', d.token);
  if (d.type === 'CLEAR_TOKEN') kvSet('token', null);
});

/* ─── PUSH: fires even when app is completely closed ─── */
self.addEventListener('push', event => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let alert = null;

  // Try to get payload from the push event
  try { if (event.data) alert = event.data.json(); } catch (_) {}

  // If no payload, fetch the latest missed alert from the server
  if (!alert) {
    try {
      const token = await kvGet('token');
      if (token) {
        const since = (await kvGet('lastAlertTs')) || 0;
        const res = await fetch('/api/pending?since=' + since, { headers: { 'x-token': token } });
        if (res.ok) {
          const data = await res.json();
          alert = (data.alerts || [])[0] || null;
        }
      }
    } catch (_) {}
  }

  const title = ALERT_TITLE;
  const body = alert
    ? `${alert.triggeredBy} raised the alert in ${alert.groupName}`
    : 'Someone in your group just raised the alert.';

  if (alert?.timestamp) await kvSet('lastAlertTs', alert.timestamp);

  // Show notification — silent:false forces the OS to play its notification sound
  // This is the ONLY way to make sound when the app is fully closed
  await self.registration.showNotification(title, {
    body,
    tag: 'workalert',
    renotify: true,            // re-alert even if same tag
    requireInteraction: true,  // stays visible until user taps
    silent: false,             // ← KEY: tells OS to play its default notification sound
    vibrate: BUZZ_PATTERN,     // strong vibration pattern
    badge: '/icon-192.png',
    icon: '/icon-192.png',
    data: { alert, url: '/' },
    actions: [
      { action: 'open', title: 'Open App' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  });

  // If any tabs are open, tell them to play the in-app alarm too
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'ALERT', alert }));
}

/* ─── Notification click ─── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const alert = event.notification.data?.alert || null;
  const action = event.action;

  if (action === 'dismiss') return;

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { await c.focus(); c.postMessage({ type: 'ALERT', alert, fromClick: true }); return; }
    }
    const w = await self.clients.openWindow('/');
    if (w) setTimeout(() => w.postMessage({ type: 'ALERT', alert, fromClick: true }), 1200);
  })());
});

/* ─── Push subscription change ─── */
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const token = await kvGet('token');
      const keyRes = await fetch('/api/push/key');
      const { key } = await keyRes.json();
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToU8(key)
      });
      if (token) {
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-token': token },
          body: JSON.stringify(sub.toJSON())
        });
      }
    } catch (_) {}
  })());
});

function b64ToU8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
