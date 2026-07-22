// sw.js — Think Beyond Practice service worker.
// Network-first for the app shell so members always get the latest platform.html,
// with a cached fallback when offline. API calls (Netlify functions) and
// cross-origin requests (Supabase, fonts) are never intercepted or cached.
const CACHE = 'tbp-v1';
const SHELL = ['/platform.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function () {}); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// ── Web Push ────────────────────────────────────────────────────────────────
// A push arrives even when no tab is open. Show the notification (required on
// every push, or the browser may show a generic "site updated" one) and, on
// click, focus an existing platform tab or open the target URL.
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = {}; }
  var title = data.title || 'Think Beyond Practice';
  var options = {
    body: data.body || '',
    tag: data.tag || 'tbp',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/platform.html' }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || '/platform.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        // Reuse an already-open platform tab if we have one.
        if (c.url.indexOf('/platform') !== -1 && 'focus' in c) {
          c.navigate(target).catch(function () {});
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // leave Supabase/fonts alone
  if (url.pathname.indexOf('/.netlify/') === 0) return;  // never cache functions

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && (req.mode === 'navigate' || SHELL.indexOf(url.pathname) !== -1)) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (r) { return r || caches.match('/platform.html'); });
    })
  );
});
