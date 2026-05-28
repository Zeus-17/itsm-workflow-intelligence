// ITSM Workflow Intelligence Tool — Service Worker Kill-Switch
// ─────────────────────────────────────────────────────────────
// The previous service worker cached the HTML file, meaning updates to
// itsm-workflow-tool-v25.html were never seen by returning users without
// Ctrl+Shift+R.
//
// This replacement SW does the opposite:
//   1. Activates immediately (skipWaiting)
//   2. Clears every cache this origin has ever created
//   3. Forces all open tabs to reload so they get the fresh HTML from the network
//   4. Unregisters itself — no service worker remains after this runs
//
// After this runs once, the page is permanently cache-free. Future visits
// always go directly to the network. No user action is required.

self.addEventListener('install', function(e) {
  // Skip the "waiting" phase — activate on the current page load, not the next one
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    // Step 1: Delete every cache this origin has
    caches.keys()
      .then(function(cacheNames) {
        return Promise.all(cacheNames.map(function(name) {
          return caches.delete(name);
        }));
      })
      // Step 2: Take control of all currently open tabs
      .then(function() {
        return self.clients.claim();
      })
      // Step 3: Reload every open tab so it gets the latest HTML from the network
      .then(function() {
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      })
      .then(function(clients) {
        clients.forEach(function(client) {
          client.navigate(client.url);
        });
      })
      // Step 4: Unregister this service worker — job done, stay out of the way forever
      .then(function() {
        return self.registration.unregister();
      })
  );
});

// Fetch handler: while the activate event above is running, any in-flight
// requests still come here. Always go to the network — never serve from cache.
self.addEventListener('fetch', function(e) {
  e.respondWith(fetch(e.request));
});
