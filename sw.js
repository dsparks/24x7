/* 24×7 service worker — offline app shell.
 * Network-first for the app's own files so installed PWAs stay current online,
 * with cache fallback so they still launch offline.
 * Weather API calls are never cached here; the app keeps its last forecast in
 * localStorage and repaints from that on load. */
const CACHE = 'grid-v113';
const SHELL = [
  '.', 'index.html', 'styles.css', 'shared.js', 'app.js', 'lightning.js', 'manifest.json', 'icon.svg', 'share-24x7.svg', 'share-ebb.svg',
  'ebb.html', 'ebb.css', 'ebb.js', 'ebb.webmanifest', 'ebb.svg',
  'fonts/cascadia-mono-400.woff2', 'fonts/cascadia-mono-500.woff2', 'fonts/cascadia-mono-600.woff2', 'fonts/cascadia-mono-700.woff2',
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

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Ebb (sibling prototype) → network-first so edits show immediately; cache as offline fallback.
  if (url.origin === location.origin && url.pathname.includes('ebb.')) {
    e.respondWith(
      fetch(req, { cache: 'reload' }).then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); return res;
      })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Same-origin app shell → network-first, fall back to cache offline.
  // This keeps the installed PWA and browser view on the latest deployed files
  // whenever the network is available.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req, { cache: 'reload' }).then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('index.html')))
    );
    return;
  }
  // Cross-origin (weather/geocoding APIs): network-only, let the app handle failures.
});
