// aflink service worker: network-first with cache fallback.
//
// Freshness is this site's whole point (overrides fix broken links), so the
// network is always tried first and every successful response replaces the
// cached copy. The cache is only read when the network fails — offline users
// get the last successfully loaded version.

const CACHE = 'aflink-v2';

// The first page load is never service-worker-controlled, so the shell must
// be cached at install time or offline fails until the second visit.
const PRECACHE = ['/', '/static/usaf.svg', '/static/github.svg', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        // Offline: serve the cached copy. For page navigations, ignore query
        // strings (/?q=search) and fall back to the cached homepage.
        caches.match(req, { ignoreSearch: req.mode === 'navigate' })
          .then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined))
          .then((hit) => hit || Response.error())
      )
  );
});
