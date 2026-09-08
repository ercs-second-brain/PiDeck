# install/

One-line installer, service registration and guided onboarding for PiDeck.

## Quick start

macOS or Linux (or WSL, inside the distro):

```sh
curl -fsSL https://raw.githubusercontent.com/ercs-second-brain/PiDeck/main/install/bootstrap.sh | sh
```

Windows (PowerShell, bootstraps WSL if missing, then runs the Linux path inside it):

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install\windows\pideck-setup.ps1
```

When piped, the bootstrap fetches the repo tarball, re-execs itself with tty
stdin restored, and forwards your flags (`curl … | sh -s -- --dry-run`, etc.).

## Pre-rebrand agentskiss installs

Pre-rebrand agentskiss installs: reinstall (bootstrap one-liner — see Quick start above).

## What it does

1. Detects the OS: macOS / Linux / WSL. A Windows host shell is told to run
   the WSL bootstrap instead.
2. Installs dependencies if missing — git, Node 22, pnpm (via corepack,
   honoring the monorepo's `packageManager` pin), gh CLI. Node/gh install as
   **user-level tarballs** under `~/.pideck/opt` with symlinks in
   `~/.local/bin`, so the main path never needs sudo.
3. Fetches the monorepo (`--repo`/`--ref`, or `--dir` for a local checkout).
4. Installs the pideck CLI (bins into `~/.pideck/bin`, symlink in
   `~/.local/bin`) and writes config/state to `~/.pideck/` (see layout
   below) — both BEFORE the build (issue #207): a failed build still leaves
   a recoverable CLI (`pideck status`, `pideck update`) instead of
   `pideck: command not found`.
5. Builds daemon + webapp. Build artifact production is isolated in one
   function (`build_from_source` in `lib/source.sh`) so it can switch to
   release artifacts when they exist without touching anything else.
6. Installs the pi coding agent (`@earendil-works/pi-coding-agent`, npm
   `--ignore-scripts`, user prefix) if not already present.
7. Links the pideck pi skills/extensions from `agent/` — whatever exists
   there at install time (`skills/`, `extensions/`, `commands/`,
   `prompt-templates/`, `themes/`) is symlinked into `~/.pi/agent/`. The five
   orchestration skills in `agent/skills/` are what land there today;
   `agent/prompts/` are daemon assets and stay in the checkout.
8. Registers the persistent service:
   - macOS: launchd agent `~/Library/LaunchAgents/com.pideck.daemon.plist`
     (RunAtLoad, KeepAlive on crash)
   - Linux/WSL2: systemd **user** unit
     `~/.config/systemd/user/pideck-daemon.service` (+ loginctl linger,
     best-effort). This IS the WSL path — the Windows bootstrap enables
     systemd in the distro (`/etc/wsl.conf`), then runs this installer.
9. Runs guided onboarding (unless `--no-onboard`).

## Guided onboarding

`install/onboard.sh` (also: `pideck onboard`), runs after install:

1. **pi auth + model selection** — shells out to pi's own auth (`pi auth
   check` for detection); if no credentials are found it launches pi's TUI
   and walks you through `/login`, then you pick a model from
   `pi --list-models` (or accept pi's saved startup default). No auth is
   reimplemented here.
2. **gh CLI setup** — uses a PAT from `~/.env` (`GH_TOKEN`/`GITHUB_TOKEN`)
   when present, else runs `gh auth login`. Verifies auth and the `repo`
   scope, and records the result (`canCreateRepo`) for the repo-connect flow.

Results are recorded in `~/.pideck/onboarding.json` +
`PIDECK_MODEL` in `~/.pideck/env` and remembered across restarts.
Re-run any time with `pideck onboard`.

### pi auth gating after install

Onboarding can end with pi auth incomplete (skipped flags, non-interactive
runs, an aborted `/login`); `bootstrap.sh` prints a warning when
`onboarding.json` records it. The running daemon never treats that as
healthy either (issue #57): it logs a warning at startup, reports the ready
providers via `GET /api/pi-auth` (same `pi auth check` detection onboard.sh
uses), exposes `piReady` in `GET /api/status` / `pideck status`, shows a
persistent banner in the webapp settings, and gates worker spawns (issue
#56): a spawn made before any provider is ready holds at `spawning` with its
initial prompt queued and delivers it automatically once auth completes.

## WSL: reaching the webapp from Windows

Under WSL2, the daemon runs inside the Linux distro and is reached from the
Windows host browser like this:

1. **Bind address.** The service units set `PD_WEB_HOST=0.0.0.0`
   (also written to `~/.pideck/env`), so the daemon listens on all
   interfaces. A `localhost`-only bind also works for host-browser access
   via localhost forwarding, but 0.0.0.0 keeps the LAN/portproxy path open.
2. **From the Windows host browser** open `http://localhost:<port>` — WSL2
   forwards localhost connections from Windows into the distro by default
   (requires a reasonably recent Windows 10/11 build; `wsl --update` if
   not). `pideck addr` and the installer summary print this URL.
3. **From other devices on the LAN** (optional) you need a Windows-side
   port proxy plus a firewall rule, run in an elevated PowerShell:

   ```powershell
   $wslIp = (wsl hostname -I).Trim().Split(' ')[0]
   netsh interface portproxy add v4tov4 listenport=8321 connectaddress=$wslIp connectport=8321
   New-NetFirewallRule -DisplayName pideck -Direction Inbound -LocalPort 8321 -Protocol TCP -Action Allow
   ```

   Note: the distro IP changes across WSL restarts; re-run the portproxy
   after reboots (or script it). Windows Defender Firewall may also prompt
   to allow the port on first access.

⚠️ This whole path is **code-reviewed but untested on real Windows
hardware** — see "Tested matrix" below. If localhost access fails, check
`wsl --version`, that the daemon is listening (`ss -tlnp` inside the
distro), and the portproxy/firewall notes above.

## Config/state layout (`~/.pideck/`)

| Path                     | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `env`                    | Sourceable env (`PD_HOME/SRC/NODE/WEB_PORT/WEB_HOST/MODEL`) for the service + CLI |
| `config.json`            | Install metadata (paths, port, os, ref)            |
| `onboarding.json`        | pi + gh onboarding results (consumed by repo-connect) |
| `state/onboard-complete` | Marker so the daemon can skip/flag onboarding      |
| `src/`                   | Monorepo clone (built artifacts the service runs)  |
| `opt/`                   | Private node/gh/pnpm installs (when not on system) |
| `bin/`                   | `pideck` CLI (service control + daemon-CLI forwarder), `pideck-daemon` service launcher |
| `lib/`                   | Installed installer libs + `onboard.sh`            |
| `log/`                   | daemon stdout/stderr                               |

## CLI

`pideck` is one entry point with two surfaces: service control is handled
by the installed shim itself; **every other subcommand is forwarded verbatim
(args intact, exit code propagated) to the daemon CLI**
(`apps/daemon/src/cli`), resolved from the install layout
(`$PD_SRC/apps/daemon/dist/cli/main.js`):

```
# service control — always handled by the shim
pideck service start|stop|restart|status
pideck start|stop|restart        bare shortcuts, same as `service ...`
pideck addr                      webapp URL for this machine
pideck onboard [--dry-run|--noninteractive|--skip-pi|--skip-gh]
pideck update [--check]          apply upstream updates (--check reports only)
pideck logs [-f]
pideck help

# agent CLI — forwarded to the daemon (used by the pi skills)
pideck status [--json]
pideck project get <id> | ls [--json]
pideck kanban|sessions|workers|pulls --project <id> [--json]
pideck diff --project <id> <pr-number>
pideck spawn --project <id> [--issue <n>] --name <label> [--prompt <task>]
pideck send --session <id> --message <text>
```

### Command precedence

The shim owns a small, fixed set of verbs; anything else goes to the daemon
CLI untouched:

| Invoked as                       | Handled by   |
| -------------------------------- | ------------ |
| `service start\|stop\|restart\|status`, bare `start\|stop\|restart` | shim (service control) |
| `addr`, `onboard`, `update`, `logs`, `help`, `-h`, `--help` | shim |
| `status`                         | **daemon CLI** (daemon health — the pi skills' health check) |
| anything else                    | **daemon CLI**, verbatim |

Notes:

- `status` is the one verb that exists on both surfaces. It deliberately
  resolves to the **daemon CLI** (that is what the skills call); for service
  status use `pideck service status`. This is a change from earlier
  installer-only releases, where bare `status` printed service status.
- `start`/`stop`/`restart` have no daemon-CLI counterpart, so the bare
  shortcuts are unambiguous; `service start` etc. are the canonical form.
- `update` (issue #55) checks the installed source at `$PD_SRC` against
  the upstream repo/ref the installer used (`$PD_HOME/config.json`, falling back
  to the git remote), via `gh api repos/:owner/:repo/commits/<ref>` — so private
  repos and non-main dev refs check and update like public ones. With an update
  available it fetches the new source with gh-authed git (the installer's
  `resolve_source`, including `_retry_with_gh_auth` semantics), rebuilds
  (`build_from_source`), refreshes the installed shell layer — `bin/*` into
  `$PD_HOME/bin` (the `~/.local/bin/pideck` symlink is preserved),
  `lib/*.sh` + `onboard.sh` flat into `$PD_HOME/lib`, and the rendered
  service unit files via a `register_service` pass, all copied exactly like
  bootstrap.sh installs them (issue #66: fixes to the install scripts
  themselves reach machines that update via the CLI; the running shim keeps
  its in-memory copies — the refreshed files apply from the next invocation
  on) — and restarts the service (`svc_restart`). Up to date →
  no-op. `--check` reports without touching anything. The daemon exposes the
  same check as `GET /api/update` (shared contract `getUpdateStatus`), which the
  webapp renders as an update banner on the projects/settings pages.
- The forwarded CLI reaches the daemon at `http://127.0.0.1:$PD_WEB_PORT`
  by default (set as `PD_DAEMON_URL` by the shim; a `PD_DAEMON_URL`
  already present in your environment wins). If the daemon build output is
  missing, the shim says so and points at re-running the installer.

## Flags (bootstrap)

```
--dry-run       print mutating commands instead of running them
--no-onboard    skip interactive onboarding
--repo URL      monorepo git URL        (default: this repo)
--ref REF       branch/tag to install   (default: main)
--dir PATH      build from an existing checkout
--port N        webapp port             (default: 8321)
```

## Shell lint & shim tests

`pnpm build` in this package runs `shellcheck` over all scripts (skipped
with a note when shellcheck isn't installed; CI runners have it) and the
plain-shell tests in `test/cli-forwarding.sh` (service verbs,
daemon-CLI forwarding with args + exit codes, `status` precedence, missing-
build error path), `test/update.sh` (update check against fake git/gh,
`update --check` shim wiring, the apply path's reuse of the installer
machinery + shell-layer refresh — installed lib/bin/onboard match the fetched
source afterwards — and service restart), and `test/onboard.sh` (onboarding
from the flat installed layout — the bootstrap.sh flat copy into `lib/` — and
from the source-tree layout, via `--dry-run --skip-pi --skip-gh`) — no
daemons, no network, no systemd. CI runs the same shellcheck pass + shell
suites as a dedicated job step.

## Tested matrix

- **Tested here (Linux x64):** `shellcheck` clean on all scripts; `--dry-run`
  full-bootstrap run; `onboard.sh --dry-run`; service unit rendering;
  `pideck-daemon` smoke against the built daemon; shim
  forwarding tests (`test/cli-forwarding.sh`), self-update tests
  (`test/update.sh`, mock git/gh), and onboarding layout tests
  (`test/onboard.sh`, flat installed + source-tree `lib/` sourcing); live
  smoke of the installed
  shim forwarding to the real built daemon CLI (its errors and exit codes
  surface unchanged).
- **Untested (needs hardware/VMs):** the real fresh-machine runs — macOS
  (launchd bootstrap, `ipconfig getifaddr`, Xcode CLT install dialog),
  non-apt Linux distros, sudo-requiring git installs, and the whole
  Windows/WSL path (`windows/pideck-setup.ps1` — WSL install, distro
  bootstrap, systemd enablement, logon task, and Windows-host browser
  access to the webapp; the localhost-forwarding and portproxy/firewall
  steps in "WSL: reaching the webapp from Windows" are unverified). The
  OS-specific paths are kept in clearly separated functions
  (`_register_launchd`, `_register_systemd`, `_install_node_tarball`, the
  PS1 file) for review.

## Daemon service

`apps/daemon` is the real daemon: its `main()` runs persistently (REST API,
websocket hub, terminal bridge, static webapp serving) until it receives
`SIGINT`/`SIGTERM`. Both service units start it via the documented entrypoint
(`~/.pideck/bin/pideck-daemon` → `apps/daemon/dist/index.js`), and
`KeepAlive`/`Restart=on-failure` bring it back if it crashes. As a smoke
check, the built entrypoint can also be run directly
(`node apps/daemon/dist/index.js`): it detects that it is the main module and
starts the daemon; stop it with Ctrl-C.
