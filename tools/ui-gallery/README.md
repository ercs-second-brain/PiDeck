# UI gallery

`pnpm ui-gallery` boots the real daemon against the fake `gh` (tools/fake-gh)
and a fake tmux, seeds a realistic state — two projects, workers in all eight
states, a reviewer under its worker, an archived session with captured log and
trace, the global agent, an update pill, a review account, and one prompt
override — then drives headless Playwright through every route at 1280×800 and
390×844 and writes `runs/ui/<timestamp>/index.html` (a labelled grid of PNGs)
plus `manifest.json`. A run takes about a minute.

```
pnpm build            # the gallery runs the built daemon and web app
pnpm ui-gallery       # gallery only
pnpm ui-gallery --assert   # + the layout assertions below
pnpm ui-gallery --keep     # keep the temp state dir for debugging
```

First run needs a Chromium: `npx playwright install chromium`. Not part of CI.

## Reading it

Open `runs/ui/<timestamp>/index.html`. Every shot is labelled route · viewport
· state, with the `docs/DESIGN.md` section it should be judged against. Read
the gallery against that document before opening any web PR.

## Layout assertions (`--assert`)

`assert.spec.mjs` runs against the already-running gallery daemon:

- no horizontal page overflow at 1280×800 or 390×844;
- every interactive control ≥ 40×40 CSS px at 390 (touch viewport);
- `.xterm-screen` fully inside its container after attach, after a sidebar
  toggle, and on the mobile list → session → back path;
- focus ring visible on the first Tab;
- every route renders without console errors.

Controls already below the 40px floor are allow-listed in `KNOWN_SMALL`
(assert.spec.mjs) — each is a finding to fix in the web app, not something to
normalize here. Findings spotted while reading the gallery or the assertions
become their own issues; this tool changes only when the shot list or the
assertions need to.
