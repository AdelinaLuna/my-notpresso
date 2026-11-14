const CACHE_NAME = 'notpresso-v0.4.2';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=0.4.2',
  './app.js?v=0.4.2',
  './manifest.json',
  './documentation/NespressoExpertEN350G.pdf'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((response) => {
      return response || fetch(event.request).catch(() => caches.match('./index.html'));
    })
  );
});
