# install/

One-line installer, service registration and guided onboarding for agentsKISS.

## Quick start

macOS or Linux (or WSL, inside the distro):

```sh
curl -fsSL https://raw.githubusercontent.com/ercs-second-brain/agentsKISS/main/install/bootstrap.sh | sh
```

Windows (PowerShell, bootstraps WSL if missing, then runs the Linux path inside it):

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install\windows\agentskiss-setup.ps1
```

When piped, the bootstrap fetches the repo tarball, re-execs itself with tty
stdin restored, and forwards your flags (`curl … | sh -s -- --dry-run`, etc.).

## What it does

1. Detects the OS: macOS / Linux / WSL. A Windows host shell is told to run
   the WSL bootstrap instead.
2. Installs dependencies if missing — git, Node 22, pnpm (via corepack,
   honoring the monorepo's `packageManager` pin), gh CLI. Node/gh install as
   **user-level tarballs** under `~/.agentskiss/opt` with symlinks in
   `~/.local/bin`, so the main path never needs sudo.
3. Fetches the monorepo (`--repo`/`--ref`, or `--dir` for a local checkout)
   and builds daemon + webapp. Build artifact production is isolated in one
   function (`build_from_source` in `lib/source.sh`) so it can switch to
   release artifacts when they exist without touching anything else.
4. Installs the pi coding agent (`@earendil-works/pi-coding-agent`, npm
   `--ignore-scripts`, user prefix) if not already present.
5. Links the agentskiss pi skills/extensions from `agent/` — whatever exists
   there at install time (`skills/`, `extensions/`, `commands/`,
   `prompt-templates/`, `themes/`) is symlinked into `~/.pi/agent/`. Empty
   today (assets land in a separate issue); the step needs no changes then.
6. Writes config/state to `~/.agentskiss/` (see layout below) — the daemon
   reads this later; results survive restarts.
7. Registers the persistent service:
   - macOS: launchd agent `~/Library/LaunchAgents/com.agentskiss.daemon.plist`
     (RunAtLoad, KeepAlive on crash)
   - Linux/WSL2: systemd **user** unit
     `~/.config/systemd/user/agentskiss.service` (+ loginctl linger,
     best-effort). This IS the WSL path — the Windows bootstrap enables
     systemd in the distro (`/etc/wsl.conf`), then runs this installer.
8. Runs guided onboarding (unless `--no-onboard`).

## Guided onboarding

`install/onboard.sh` (also: `agentskiss onboard`), runs after install:

1. **pi auth + model selection** — shells out to pi's own auth (`pi auth
   check` for detection); if no credentials are found it launches pi's TUI
   and walks you through `/login`, then you pick a model from
   `pi --list-models` (or accept pi's saved startup default). No auth is
   reimplemented here.
2. **gh CLI setup** — uses a PAT from `~/.env` (`GH_TOKEN`/`GITHUB_TOKEN`)
   when present, else runs `gh auth login`. Verifies auth and the `repo`
   scope, and records the result (`canCreateRepo`) for the repo-connect flow.

Results are recorded in `~/.agentskiss/onboarding.json` +
`AGENTSKISS_MODEL` in `~/.agentskiss/env` and remembered across restarts.
Re-run any time with `agentskiss onboard`.

## WSL: reaching the webapp from Windows

Under WSL2, the daemon runs inside the Linux distro and is reached from the
Windows host browser like this:

1. **Bind address.** The service units set `AGENTSKISS_WEB_HOST=0.0.0.0`
   (also written to `~/.agentskiss/env`), so the daemon listens on all
   interfaces. A `localhost`-only bind also works for host-browser access
   via localhost forwarding, but 0.0.0.0 keeps the LAN/portproxy path open.
2. **From the Windows host browser** open `http://localhost:<port>` — WSL2
   forwards localhost connections from Windows into the distro by default
   (requires a reasonably recent Windows 10/11 build; `wsl --update` if
   not). `agentskiss addr` and the installer summary print this URL.
3. **From other devices on the LAN** (optional) you need a Windows-side
   port proxy plus a firewall rule, run in an elevated PowerShell:

   ```powershell
   $wslIp = (wsl hostname -I).Trim().Split(' ')[0]
   netsh interface portproxy add v4tov4 listenport=8321 connectaddress=$wslIp connectport=8321
   New-NetFirewallRule -DisplayName agentskiss -Direction Inbound -LocalPort 8321 -Protocol TCP -Action Allow
   ```

   Note: the distro IP changes across WSL restarts; re-run the portproxy
   after reboots (or script it). Windows Defender Firewall may also prompt
   to allow the port on first access.

⚠️ This whole path is **code-reviewed but untested on real Windows
hardware** — see "Tested matrix" below. If localhost access fails, check
`wsl --version`, that the daemon is listening (`ss -tlnp` inside the
distro), and the portproxy/firewall notes above.

## Config/state layout (`~/.agentskiss/`)

| Path                     | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `env`                    | Sourceable env (`AGENTSKISS_HOME/SRC/NODE/WEB_PORT/WEB_HOST/MODEL`) for the service + CLI |
| `config.json`            | Install metadata (paths, port, os, ref)            |
| `onboarding.json`        | pi + gh onboarding results (consumed by repo-connect) |
| `state/onboard-complete` | Marker so the daemon can skip/flag onboarding      |
| `src/`                   | Monorepo clone (built artifacts the service runs)  |
| `opt/`                   | Private node/gh/pnpm installs (when not on system) |
| `bin/`                   | `agentskiss` CLI, `agentskiss-daemon` service launcher |
| `lib/`                   | Installed installer libs + `onboard.sh`            |
| `log/`                   | daemon stdout/stderr                               |

## CLI

```
agentskiss start|stop|restart|status   service control
agentskiss addr                        webapp URL for this machine
agentskiss onboard [--dry-run|--skip-pi|--skip-gh]
agentskiss logs [-f]
```

## Flags (bootstrap)

```
--dry-run       print mutating commands instead of running them
--no-onboard    skip interactive onboarding
--repo URL      monorepo git URL        (default: this repo)
--ref REF       branch/tag to install   (default: main)
--dir PATH      build from an existing checkout
--port N        webapp port             (default: 8321)
```

## Shell lint

`pnpm build` in this package runs `shellcheck` over all scripts (skipped
with a note when shellcheck isn't installed; CI runners have it).

## Tested matrix

- **Tested here (Linux x64):** `shellcheck` clean on all scripts; `--dry-run`
  full-bootstrap run; `onboard.sh --dry-run`; service unit rendering;
  `agentskiss-daemon` smoke against the built placeholder daemon.
- **Untested (needs hardware/VMs):** the real fresh-machine runs — macOS
  (launchd bootstrap, `ipconfig getifaddr`, Xcode CLT install dialog),
  non-apt Linux distros, sudo-requiring git installs, and the whole
  Windows/WSL path (`windows/agentskiss-setup.ps1` — WSL install, distro
  bootstrap, systemd enablement, logon task, and Windows-host browser
  access to the webapp; the localhost-forwarding and portproxy/firewall
  steps in "WSL: reaching the webapp from Windows" are unverified). The
  OS-specific paths are kept in clearly separated functions
  (`_register_launchd`, `_register_systemd`, `_install_node_tarball`, the
  PS1 file) for review.

## Known limitation

`apps/daemon` is still a placeholder: its `main()` exits immediately (and
only runs under `AGENTSKESS_DAEMON_RUN=1`). Both service units are wired to
the documented entrypoint (`~/.agentskiss/bin/agentskiss-daemon` →
`apps/daemon/dist/index.js`), so they start running the real daemon with no
installer changes once it lands. Until then `KeepAlive`/`Restart=on-failure`
correctly leave the service down after the placeholder exits 0.
