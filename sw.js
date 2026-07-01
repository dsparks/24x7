/* 24×7 service worker — offline app shell.
 * Versioned shell files are cache-first for instant repeat loads. The page checks
 * sw.js separately and activates a fresh cache whenever this version changes.
 * Weather API calls are never cached here; the app keeps its last forecast in
 * localStorage and repaints from that on load. */
const CACHE = 'grid-v173';
const SHELL = [
  '.', 'index.html', 'styles.css', 'shared.js', 'app.js', 'lightning.js', 'manifest.json', 'icon.svg', 'share-24x7.svg', 'share-ebb.svg',
  'ebb.html', 'ebb.css', 'ebb.js', 'ebb.webmanifest', 'ebb.svg',
  'fonts/cascadia-mono-400.woff2', 'fonts/cascadia-mono-600.woff2', 'fonts/cascadia-mono-700.woff2',
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

  // Versioned app-shell assets are immutable within a service-worker release.
  // Serve them immediately from cache; registerFreshServiceWorker() separately
  // checks sw.js for updates and activates a newly versioned shell.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok){
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })).catch(() => req.mode === 'navigate' ? caches.match('index.html') : Response.error())
    );
    return;
  }
  // Cross-origin (weather/geocoding APIs): network-only, let the app handle failures.
});
