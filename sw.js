// ITSM Workflow Intelligence Tool — Service Worker
// Caches the tool for full offline use after first visit

const CACHE_NAME = 'itsm-tool-v25';
const TOOL_FILES = [
  '/itsm-workflow-intelligence/',
  '/itsm-workflow-intelligence/index.html',
  '/itsm-workflow-intelligence/itsm-showcase.html',
  '/itsm-workflow-intelligence/itsm-demo-v25.html',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(TOOL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type === 'error') return response;
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
        return response;
      }).catch(() => caches.match('/itsm-workflow-intelligence/index.html'));
    })
  );
});
