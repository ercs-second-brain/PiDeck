/*
 * PiDeck app-shell service worker. Caches the shell (documents, hashed build
 * assets, icons, manifest) so an installed PWA opens while the daemon is
 * briefly unreachable. It never touches /api or /ws — REST and terminal
 * traffic must always hit the live daemon, and terminals are meaningless
 * offline. See docs/pwa.md.
 */

const CACHE = "pideck-shell";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

function isDaemonTraffic(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/ws" || pathname.startsWith("/ws");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isDaemonTraffic(url.pathname)) return;

  // Documents: network-first so a new deploy is picked up immediately; the
  // cached index is the offline fallback. The daemon serves index.html for
  // every SPA route, so caching per request URL keeps deep links working.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/"))),
    );
    return;
  }

  // Static assets (hashed bundle files, icons): cache-first — a hit never
  // goes to the network, a miss is fetched and cached.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
