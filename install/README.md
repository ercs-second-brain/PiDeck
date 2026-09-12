# install/

One-line installer, service registration and guided onboarding for PiDeck.

## Quick start

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/ercs-second-brain/PiDeck/main/install/bootstrap.sh | sh
```

When piped, the bootstrap fetches the repo tarball, re-execs itself with tty
stdin restored, and forwards your flags (`curl … | sh -s -- --dry-run`, etc.).

## What it does

1. Detects the OS (macOS or Linux only — there is no Windows path).
2. Installs dependencies if missing — git, Node 22, pnpm, gh CLI. Node and
   gh install as **user-level tarballs** under `~/.pideck/opt` with symlinks
   in `~/.local/bin`, so the main path never needs sudo.
3. Fetches the monorepo (`--repo`/`--ref`, or `--dir` for a local checkout)
   into `~/.pideck/src`.
4. Installs the pideck CLI (bins into `~/.pideck/bin`, symlink in
   `~/.local/bin`) and writes config/state to `~/.pideck/` — both BEFORE the
   build: a failed build still leaves a recoverable CLI (`pideck update`
   or a bootstrap re-run recovers) instead of `pideck: command not found`.
5. Builds daemon + webapp (`pnpm install --frozen-lockfile && pnpm build`).
6. Installs the pi coding agent (`@earendil-works/pi-coding-agent`, npm
   `--ignore-scripts`, user prefix) if not already present. It installs under
   the active node (the private runtime when one was installed), and
   `~/.local/bin` stays first on `PATH`, so pi's `#!/usr/bin/env node`
   shebang resolves the same runtime it was installed under.
7. Symlinks the pideck pi skills: `agent/skills/*` → `~/.pi/agent/skills/`.
   Pi loads them like any other skill; PiDeck has no skill plumbing of its
   own.
8. Registers the persistent service (start at login, restart on crash):
   - macOS: launchd agent `~/Library/LaunchAgents/com.pideck.daemon.plist`
     (RunAtLoad, KeepAlive)
   - Linux: systemd **user** unit
     `~/.config/systemd/user/pideck-daemon.service` (+ loginctl linger,
     best-effort)
9. Runs guided onboarding (unless `--no-onboard`).

## Flags (bootstrap)

```
--dry-run       print every mutating step instead of running it
--no-onboard    skip interactive onboarding
--repo URL      monorepo git URL        (default: this repo)
--ref REF       branch/tag to install   (default: main)
--dir PATH      build from an existing checkout
--port N        webapp port             (default: 8321)
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PD_HOME` | install home (default `~/.pideck`) |
| `PD_REPO_URL` / `PD_REPO_REF` | source repo/ref (defaults: this repo, `main`) |
| `PD_WEB_PORT` | webapp port (default `8321`) |
| `PD_NODE_VERSION` | private Node pin (default `22.23.2`) |
| `PD_NODE_MIN_VERSION` | minimum system Node accepted (default `22.19.0`) |
| `PD_PNPM_VERSION` | standalone pnpm to install (default `12`) |
| `PD_GH_VERSION` | gh tarball pin (default `2.63.2`) |
| `PD_PI_PACKAGE` | pi npm package (default `@earendil-works/pi-coding-agent`) |
| `PD_REVIEW_USER` / `PD_REVIEW_TOKEN` | review account for noninteractive onboarding |

## Guided onboarding

`install/onboard.sh` (also: `pideck onboard`) runs after install:

1. **pi auth + model** — shells out to pi's own auth (`pi auth check` for
   detection); if no credentials are found it launches pi's TUI for
   `/login`, then you pick a model from `pi --list-models` (or accept pi's
   saved startup default). No auth is reimplemented here.
2. **primary gh auth** — uses a PAT from `~/.env` (`GH_TOKEN`/`GITHUB_TOKEN`)
   when present, else runs `gh auth login`, and verifies the result.
3. **review account — required** — the review leg files real PR reviews as a
   **second GitHub account**; with a single account the loop has no review
   leg at all. Onboarding asks for the username + PAT, verifies the token
   with `gh auth status` (and that the token belongs to that username), and
   does not complete until it passes. Noninteractive runs supply it via
   `PD_REVIEW_USER` + `PD_REVIEW_TOKEN`.

Results: `~/.pideck/onboarding.json` (record) and `~/.pideck/settings.json`
(review account + model per persona, chmod 600 — read by the daemon). The
settings shape is the shared `GlobalSettingsSchema` in
`packages/shared/src/settings.ts`; `install/test/fixtures/settings.json` is
the example fixture both the install shell test and the daemon test read.
Re-run any time with `pideck onboard`.

## CLI

`pideck` is one entry point with two surfaces: service verbs are handled by
the shim itself; everything else is forwarded verbatim (args intact, exit
code propagated) to the daemon CLI (`apps/daemon/dist/cli.js`):

```
# service verbs — always handled by the shim
pideck service start|stop|restart|status
pideck logs [-f]
pideck addr                      webapp URL for this machine
pideck onboard [--dry-run|--noninteractive|--skip-pi|--skip-gh]
pideck update                    fetch ref, rebuild, refresh shim + units,
                                 restart service; no-op if already at the ref
pideck help

# agent CLI — forwarded to the daemon (verb names per docs/SPEC.md §4)
pideck status
pideck project ls | project get <id>
pideck sessions
pideck workers
pideck send --session <id> --message <text>
```

There is no `pideck spawn`: assignment spawns.

`pideck update` compares the local source HEAD with the tracked ref, then
fetches, rebuilds, refreshes the installed shell layer (`bin/`, `lib/`,
service unit files) and restarts the service. Up to date → no-op.

## Config/state layout (`~/.pideck/`)

| Path | Purpose |
| --- | --- |
| `env` | sourceable env (`PD_HOME/SRC/NODE/WEB_PORT`, `PIDECK_MODEL`) for the service + CLI |
| `config.json` | install metadata (paths, port, os, ref) |
| `settings.json` | review account + model per persona, read by the daemon, chmod 600 (shape: `packages/shared/src/settings.ts`) |
| `onboarding.json` | pi + gh + review onboarding record |
| `state/onboard-complete` | marker: onboarding finished with a verified review account |
| `src/` | monorepo clone (built artifacts the service runs) |
| `opt/` | private node/gh/pnpm/pi installs (when not on system) |
| `bin/` | `pideck` CLI (service control + daemon-CLI forwarder), `pideck-daemon` service launcher |
| `lib/` | installed installer libs + `onboard.sh` |
| `log/` | daemon stdout/stderr |

## Shell lint & tests

`pnpm build` in this package runs `shellcheck` over all scripts (skipped
with a note when shellcheck isn't installed; CI runners have it) and the
plain-shell tests in `test/` via `test/run-all.sh` (no bats dependency):

- `test/shim-routing.sh` — shim verb routing, daemon-CLI forwarding with
  args + exit codes, missing-build error path (stub daemon CLI, fake node)
- `test/unit-render.sh` — launchd + systemd unit rendering (placeholders,
  restart-on-crash, start-at-login)
- `test/bootstrap-order.sh` — dry-run bootstrap: CLI + config land before
  the build
- `test/bootstrap-dry-run.sh` — dry-run on a BARE box (node/gh/pi/pnpm
  absent from PATH): every step printed, exit 0
- `test/onboard.sh` — review-account requirement, verification, settings
  contract (the written file must match `test/fixtures/settings.json`, the
  same fixture the daemon test loads)

No daemons, no network, no systemd.

## Tested matrix

- **Tested (Linux x64):** `shellcheck` clean on all scripts; all five test
  suites green (via `test/run-all.sh`, also a CI job); shim forwarding
  against a stub daemon CLI; `--dry-run` bootstrap with no toolchain on
  PATH (bare box).
- **Reviewed, untested (needs hardware):** the macOS paths — launchd
  bootstrap, `ipconfig getifaddr`, Xcode CLT install dialog, `plutil` lint.
  The OS-specific paths are kept in clearly separated functions
  (`_register_launchd`, `_register_systemd`, `_install_node_tarball`) for
  review.

## Daemon service

The service units start the daemon via `~/.pideck/bin/pideck-daemon` (which
sources `~/.pideck/env` and execs `apps/daemon/dist/index.js`).
`KeepAlive`/`Restart=on-failure` bring it back if it crashes; `RunAtLoad` /
`WantedBy=default.target` (+ linger) start it at login.
