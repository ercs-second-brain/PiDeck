Throwaway target for the live loop: a one-module node project whose test
fails on main (`greeting()` still returns `"TODO"`) and CI runs `npm test`
on every push and PR. `docs/REVIEW.md` tunes the reviewers spawned against
it: an approval carries one non-blocking inline note, until it is addressed. PiDeck's e2e runner pushes this to a private repo
`pideck-e2e-<ts>` and seeds issues that ask for the fix — see
`tools/e2e/run.mjs`.
