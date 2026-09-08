# PWA support (issue #179)

PiDeck is installable as a Progressive Web App: on Android/desktop Chrome or
Edge, open the dashboard and use the browser's **Install app** (or "Add to
Home Screen" on Android) entry. The app then runs in its own window with the
PiDeck icon.

## What ships

- `apps/web/public/manifest.webmanifest` — name, standalone display, theme
  color, and 192/512 px icons (generated once by a small rasterizer script;
  `icon.svg` is the vector source and favicon).
- `apps/web/public/sw.js` — a **deliberately minimal** service worker.
- `apps/web/public/offline.html` — static fallback page.
- Registration in `apps/web/src/main.tsx` (production builds only; the
  daemon serves `public/` files from the webapp dist root, so the SW sits at
  scope root `/sw.js`).

## Caching policy (hard constraint)

**No aggressive caching.** The webapp must always match the running daemon —
stale shells would break the update flow (#89/#95). Therefore:

- App assets are **never** cached by the service worker; every request goes
  to the network and reflects exactly the build the daemon serves.
- The only cached artifact is the static `offline.html` fallback, shown when
  a navigation fails because the daemon is unreachable.
- The SW registers with `updateViaCache: "none"`, so a new service worker is
  fetched on each navigation and activates immediately; `activate` purges
  any cache other than the current offline page.

## Platform limitations

| Platform | Install | Notifications |
| --- | --- | --- |
| Android Chrome/Edge | Install prompt / Add to Home Screen; standalone window | Browser notifications supported — enable via the notification center's **Enable browser notifications** (permission prompt) plus the daemon-side `browserMergeNotifications` toggle (issue #111) |
| Desktop Chrome/Edge | Install prompt; standalone window | Supported (same flow) |
| iOS Safari | **No install prompt** — manual Share → "Add to Home Screen"; standalone via `apple-mobile-web-app-*` metas | **No web push.** The `Notification` API is unavailable in regular iOS Safari tabs, so the permission flow hides itself and notifications are **in-app only** (toasts + notification center, #178/#180). An installed home-screen web app on iOS 16.4+ exposes the API and can ask for permission like Android |

## Mobile behavior (issue #180)

- Toasts span the viewport width at the bottom edge on small screens
  (`≤ 640px`), so merged-PR popups stay readable and tappable.
- The notification center (bell, top-right of the header) is reachable from
  the mobile header on every viewport; the dropdown clamps to the screen
  width.
- The **Enable browser notifications** button appears only where the
  platform can actually deliver them (`Notification` in `"default"` state):
  Android (best inside the installed PWA) and desktop; iOS in-browser stays
  in-app-only by design, as documented above.

No offline-first behavior: offline you get the static fallback page, by
design — a self-hosted dashboard without its daemon has nothing to show.
