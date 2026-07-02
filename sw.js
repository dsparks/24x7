/* 24×7 service worker — offline app shell.
 * Versioned shell files are cache-first for instant repeat loads. The page checks
 * sw.js separately and activates a fresh cache whenever this version changes.
 * Weather API calls are never cached here; the app keeps its last forecast in
 * localStorage and repaints from that on load. */
const CACHE = 'grid-b87628a94f'; /* sw-cache-hash */
const SHELL = [
  '.', 'index.html', 'styles.css', 'shared.js', 'app.js', 'lightning.js', 'manifest.json', 'icon.svg', 'share-24x7.svg', 'share-ebb.svg',
  'ebb.html', 'ebb.css', 'ebb.js', 'ebb.webmanifest', 'ebb.svg',
  'html2canvas.min.js',
  'icon-24x7-180.png', 'icon-ebb-180.png',
  'fonts/cascadia-mono-400.woff2', 'fonts/cascadia-mono-600.woff2', 'fonts/cascadia-mono-700.woff2',
];

self.addEventListener('install', e => {
  // cache:'reload' bypasses the HTTP cache so a freshly-versioned shell can never
  // be filled with the previous release's assets (GitHub Pages serves max-age=600).
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
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

// Offline navigations fall back to the shell of the app actually being opened.
const navFallback = url => /(^|\/)ebb\.html$/.test(url.pathname) ? 'ebb.html' : 'index.html';

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Versioned app-shell assets are immutable within a service-worker release.
  // Serve them immediately from cache; registerFreshServiceWorker() separately
  // checks sw.js for updates and activates a newly versioned shell.
  // ignoreSearch: deep links like index.html?lat=… / ebb.html?q=… must still hit
  // the precached shell (cache keys have no query string).
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
        if (res.ok){
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })).catch(() => req.mode === 'navigate' ? caches.match(navFallback(url)) : Response.error())
    );
    return;
  }
  // Cross-origin (weather/geocoding APIs): network-only, let the app handle failures.
});
