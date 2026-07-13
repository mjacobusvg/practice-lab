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
