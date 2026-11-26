// Keeps the app opening offline, and shows phone alerts sent by the class server.
const VERSION = 'f28';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open('app-' + VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('app-') && k !== 'app-' + VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// The page itself: try the network first so updates arrive, fall back to the saved copy offline.
// Libraries on a CDN: saved copy first.
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  const same = url.origin === self.location.origin;
  e.respondWith(
    same
      ? fetch(req).then(res => { if (res && res.ok) { const copy = res.clone(); caches.open('app-' + VERSION).then(c => c.put(req, copy)); } return res; }).catch(() => caches.match(req))
      : caches.match(req).then(hit => hit || fetch(req).then(res => { if (res && res.ok) { const copy = res.clone(); caches.open('app-' + VERSION).then(c => c.put(req, copy)); } return res; }))
  );
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'ClassFeed', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'ClassFeed', { body: d.body || '', tag: d.tag, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
