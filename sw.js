/**
 * ============================================================
 *  Logix — service worker
 * ============================================================
 *  One job: make sure the page still loads when the campus WiFi
 *  drops, so a member of staff can tap Clock In and have it held
 *  locally rather than staring at a browser error.
 *
 *  What is NOT cached, deliberately:
 *    - anything to Supabase. Attendance, leave and staff records
 *      must never be served stale, and a cached POST would be a
 *      lie. Those requests go to the network or they fail, and
 *      the app queues them itself.
 */

// Bump this on every deploy that changes a shell file, or browsers
// will keep serving the previous one.
const CACHE = 'logix-shell-v2';

const SHELL = [
  '/',
  '/index.html',
  '/admin.html',
  '/css/style.css',
  '/js/theme.js',
  '/js/helpers.js',
  '/js/employee.js',
  '/js/admin.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing; one 404 would leave no cache at all,
      // so each file is added on its own and failures are tolerated.
      .then(cache => Promise.all(
        SHELL.map(url => cache.add(url).catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only our own origin. Supabase and the CDN go straight to the network.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, so a deploy is picked up immediately,
  // falling back to the cached shell when there is no connection.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(request).then(hit => hit || caches.match('/index.html')))
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(request).then(hit => {
      const network = fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
