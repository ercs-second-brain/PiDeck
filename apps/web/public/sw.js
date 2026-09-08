/*
 * PiDeck service worker (issue #179) — deliberately minimal.
 *
 * Constraint: NO aggressive caching. The webapp must always match the
 * running daemon (updates are a core feature — a stale app shell would
 * break the update flow #89/#95). So:
 *   - Never cache app assets. Every request goes to the network, which
 *     serves the build the running daemon actually ships.
 *   - The only cached artifact is the static offline fallback page below,
 *     shown when a navigation fails (daemon unreachable).
 *   - `updateViaCache: "none"` at registration keeps the browser from
 *     HTTP-caching this script itself, so a new SW is picked up on the
 *     next navigation and activates immediately (old caches purged in
 *     `activate`).
 *
 * Platform notes (also in docs/pwa.md):
 *   - Android/desktop Chrome & Edge: full install + notification support.
 *   - iOS Safari: no install prompt (manual "Add to Home Screen"), no web
 *     push — notifications are in-app (toasts/center) only there.
 */

const CACHE = "pideck-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
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
  // Network-first navigations only; everything else passes through untouched.
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
