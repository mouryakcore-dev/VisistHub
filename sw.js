// Bump this version string EVERY time app.html, app.js, or this file changes,
// so phones/browsers pick up the new version instead of serving a stale cache.
const CACHE_VERSION = "visist-crm-v4";
const CORE_ASSETS = [
  "./app.html",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./logo-mark.png"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  // Network-first for Firebase/Firestore calls, cache-first for app shell.
  if (event.request.url.includes("firestore") || event.request.url.includes("googleapis")) {
    return; // let these pass straight through to the network
  }
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});