# PiDeck PWA

PiDeck is installable to a phone's home screen (spec §5: "PWA for phones"). This
page documents what ships and the known caveats.

## What ships

- `apps/web/public/manifest.webmanifest` — standalone display, dark
  `theme_color` / `background_color` (`#0c0d10`), 192px and 512px icons
  (`any maskable`).
- `apps/web/public/sw.js` — a minimal **app-shell** service worker:
  - Precaches `/`, the manifest, and the icons.
  - Serves hashed build assets (`/assets/*`) cache-first — filenames change
    with deploys, so a cache hit is never stale.
  - Serves documents network-first with the cached copy as offline fallback,
    so a new deploy is picked up on the first online load.
  - **Never intercepts `/api` or `/ws`.** REST reads and terminal streams must
    always hit the live daemon; terminals are meaningless offline.
- `apps/web/index.html` — manifest link, `theme-color`, apple touch meta, and
  a small bootstrap script: it registers the service worker and pins the
  shell's height to `visualViewport.height` on phones (below 900px), so the
  on-screen keyboard shrinks the shell instead of scrolling the page. The key
  row and composer (from the terminal pane) therefore stay visible above the
  keyboard.

The static server (daemon) already serves `.webmanifest`, `.png` and everything
else under the built app directory; `apps/web/public/**` is copied into the
build verbatim by Vite.

## Installing

- **Android Chrome:** open the daemon URL, menu → *Add to home screen* /
  *Install app*. Launches standalone, own window, dark theme colour in the
  status bar.
- **iOS Safari:** share → *Add to Home Screen*. Launches standalone via the
  `apple-mobile-web-app-capable` meta (iOS does not use the manifest's
  `display` for this); the status bar stays dark-transparent.

## Caveats

- **iOS:** there is no install prompt; adding happens only through the share
  sheet. `apple-mobile-web-app-capable` is required in addition to the
  manifest because iOS ignores `display: standalone` for home-screen web apps.
  In-app browsers (e.g. opening the URL from another app) cannot install.
- **iOS keyboard:** the visual-viewport sync runs on the resize event; with
  some third-party keyboards it can fire late, briefly leaving the shell one
  frame tall. It self-corrects on the next event.
- **Offline:** the shell opens from cache, but the page shows the terminal's
  "Connecting…" state — there is intentionally no offline terminal (out of
  scope; see docs/SPEC.md §5). Push notifications are equally out of scope.
- **Updates:** documents are network-first, so a reload after a daemon update
  picks up the new build; a cached deep link is refreshed on the next online
  navigation.
- **Multiple tabs/windows:** the service worker is shared per origin; the
  cache holds at most one shell generation (old caches are deleted on
  activation).
