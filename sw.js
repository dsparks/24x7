/* 24×7 service worker — offline app shell.
 * Cache-first for the app's own files so it launches instantly offline.
 * Weather API calls are never cached here; the app keeps its last forecast in
 * localStorage and repaints from that on load. */
const CACHE = 'grid-v1';
const SHELL = [
  '.', 'index.html', 'styles.css', 'app.js', 'manifest.json', 'icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin app shell → cache-first, fall back to network and cache it.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('index.html')))
    );
    return;
  }
  // Cross-origin (weather/geocoding APIs): network-only, let the app handle failures.
});
