// Bump this version string EVERY time app.html, app.js, or this file changes.
// It's used to name the cache bucket so old buckets get cleaned up on activate.
const CACHE_VERSION = "visist-crm-v5";
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

// NETWORK-FIRST for the app shell: always try to fetch the latest version
// first. Only fall back to the cached copy if the network request fails
// (i.e. genuinely offline). This means updates show up automatically on the
// next load -- no manual "clear site data" needed, even for an already-
// installed app, since the service worker checks the network every time
// instead of trusting whatever it cached previously.
self.addEventListener("fetch", event => {
  if (event.request.url.includes("firestore") || event.request.url.includes("googleapis")) {
    return; // let Firebase/Firestore calls pass straight through
  }
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});