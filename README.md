# PiDeck

A self-hosted, single-command AI coding agent orchestration platform — pi coding agent workers, driven by GitHub issues and PRs, managed from a kanban and browser terminals on your own machine.

See [docs/pideck-prd.md](docs/pideck-prd.md) for the PRD and [docs/pideck-concept.md](docs/pideck-concept.md) for the concept brief (the spec of record). Detailed operator documentation lives in [install/README.md](install/README.md); the agent integration contract in [agent/README.md](agent/README.md); PWA install support (manifest, minimal service worker, iOS caveats) in [docs/pwa.md](docs/pwa.md).

## How the pieces fit together

One daemon process serves everything on a single port (default `8321`) at the machine's own address — no auth, by design, for a trusted private network:

- **`apps/daemon/`** — the orchestration backend. It serves the REST API (`/api/...`), the kanban websocket hub (`/api/ws`), the browser-terminal bridge (`/ws`, streaming tmux panes), and the built webapp as static files. It owns tmux session control, the session registry (persistent across restarts, with resurrect-on-startup), per-project orchestrator sessions (booted automatically with the rendered orchestrator prompt), GitHub reads (issues, PRs with CI/review metadata, diffs, blocked-by links), and worker spawning into fresh git worktrees. Worker spawns are gated on pi auth readiness (`GET /api/pi-auth` probes the same `pi auth check` detection the installer uses): an unauthenticated spawn holds at `spawning` with its initial prompt queued — never typed into a dead pane, never reported as `running` — and is delivered automatically once a provider is ready. Workers can also be terminated from the webapp (`POST /api/workers/:workerId/terminate`, issue #64): the pane (and its pi process) is killed, the worker is archived — a terminal status that never resurrects on daemon restart and never counts against the concurrency cap — and the registry record is kept for history.
- **`apps/web/`** — the webapp the daemon serves: one single-page terminals app (issue #62) whose sidebar is the whole navigation — a "Projects" header (click it for the all-projects combined kanban) with a "+" button that launches the onboarding wizard (pi/gh status, clone-or-create repo with private-by-default, auto-agent settings) as a modal, per-project rows that open the project's kanban board in the main pane, and per-agent rows that attach terminals — the orchestrator first with its workers indented beneath it (issue #63) and live worker status badges; active worker rows carry a terminate affordance (✕ → confirm) and terminated workers move to a collapsed per-project "Archived" section (issue #64). PR diff review and project settings open in the same main pane.
- **`agent/`** — pi coding agent integration: the orchestrator/worker system prompts (assembled by the daemon) and the pi skills the agents use to drive the `pideck` and `gh` CLIs.
- **`install/`** — the one-line installer, service registration (launchd / systemd user unit, which is also the WSL path), guided onboarding, and the `pideck` CLI shim.
- **`packages/shared/`** — the zod contracts shared by daemon and webapp (domain model, REST endpoint map, WS events).

**Status of the automated loop:** the full PRD core loop is live — orchestrator sessions, worker spawning (manual via webapp / orchestrator chat / `pideck spawn`, **and automatic via the GitHub issue watcher**), kanban tracking of issues and PRs with CI/review state, **CI-failure auto-fix**, **review-comment addressing**, diff review, browser terminals, session persistence across daemon restarts. For a project with auto-spawn enabled (`autoAgentUsername` set), the daemon polls GitHub and: an issue created by — or assigned to — the configured auto-agent username spawns a worker automatically (unless blocked by native blocked-by links, capped by the project's `workerConcurrency`); a worker PR that goes red gets CI-fix prompts (bounded retries); new review comments are delivered to the worker. Polling runs at a 30s default interval (API-budget notes in `apps/daemon/src/pipeline/wiring.ts`); tune or disable it with `PD_WATCHER_POLL_INTERVAL_MS` / `PD_WATCHER_ENABLED=0`.

## Quickstart

On macOS or Linux (or inside a WSL2 distro):

```sh
curl -fsSL https://raw.githubusercontent.com/ercs-second-brain/agentskiss/main/install/bootstrap.sh | sh
```

On Windows, use the WSL bootstrap from PowerShell (bootstraps WSL if missing, then runs the Linux path inside it):

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install\windows\pideck-setup.ps1
```

The installer installs git/Node 22/pnpm/gh as needed (user-level, no sudo), fetches and builds the monorepo, installs the pi coding agent, links the pideck pi skills, registers the persistent service, and runs guided onboarding: pi auth + model selection, then gh CLI auth (a PAT from `~/.env` is used when present, else `gh auth login`). Details, flags, and the `--dry-run` mode: [install/README.md](install/README.md).

When onboarding finishes, open the webapp at the printed address (`pideck addr`) — the sidebar's "+" (or the first-run empty state) launches the onboarding wizard. The wizard now starts with a **pi agent** step (issue #57): it checks the daemon's pi auth probe (`GET /api/pi-auth`), shows the ready providers and configured model, and — when pi is not ready — gives the handoff (run `pideck onboard`, or launch pi and use `/login` on the daemon host) and re-verifies before you can continue. pi auth state is also surfaced persistently in the project settings page, in `pideck status`, and in `/api/status` (`piReady`); the daemon logs a warning at startup when no provider is ready. Then connect a repo: clone from git or create a new GitHub repo (private by default, toggle for public), and choose whether issues auto-create agents — registering the project opens its kanban board. From the sidebar you can then click a project to reopen its board, click the **Projects** header for the combined all-projects board, or click an agent row to talk to the project's orchestrator (if the project doesn't have one yet, hit **Start orchestrator** in the sidebar and it comes up immediately).

## Self-updates

When the upstream repo/ref advances, the webapp shows an **update available** banner (new short SHA) across the app (shell header) with a click-to-update button, and the daemon exposes the same check as `GET /api/update`. The button is disabled (with a hint) while any agent worker is in an active status — orchestrator sessions persist across updates and never block — and the daemon re-checks the gate server-side on `POST /api/update/apply` (409 when a worker is active). Applying spawns the installed `pideck update` shim detached (the daemon restarts mid-apply) and returns immediately; the banner polls until the daemon reappears reporting the new build, with a recovery hint if it stays down. Upstream checks are cached (~hourly re-check) so webapp polling never burns gh rate limit. Checks and downloads go through the `gh` CLI against the repo/ref the installer used (persisted in `~/.pideck/config.json`), so private repos and non-main dev refs update exactly like public ones:

```sh
pideck update --check   # report only: up to date, or old -> new short SHA
pideck update           # fetch (gh-authed git), rebuild, restart the service
```

`pideck update` is a no-op (no rebuild) when the installed source already matches the upstream ref; otherwise it reuses the installer's fetch/build machinery, refreshes the installed shell layer (`lib/*.sh` + `onboard.sh`, the `bin/` shim, and the service unit files — so fixes to the install scripts itself ship with updates), and restarts the daemon, leaving sessions and project state intact.

## Everyday commands

`pideck` is one entry point: a small set of service verbs handled by the installed shim, everything else forwarded to the daemon CLI (used heavily by the pi skills). The full precedence table and flag reference is in [install/README.md](install/README.md); the common shapes:

```sh
pideck service start|stop|restart|status   # manage the persistent service
pideck logs [-f]                           # daemon logs
pideck addr                                # the webapp URL for this machine
pideck onboard [--dry-run]                 # re-run guided onboarding
pideck update [--check]                    # apply upstream updates (--check reports only)

pideck status [--json]                     # daemon health
pideck project get <id> | ls [--json]      # registered projects
pideck kanban|sessions|workers|pulls --project <id> [--json]
pideck diff --project <id> <pr-number>
pideck spawn --project <id> [--issue <n>] --name <label> [--prompt <task>]
pideck send --session <id> --message <text>
```

## Environment variables

Defaults are sensible; the installer writes the first group into `~/.pideck/env` (sourced by the service and the CLI shim).

| Variable | Consumer | Default | Meaning |
| --- | --- | --- | --- |
| `PD_HOME` | installer, daemon | `~/.pideck` | State/config root |
| `PD_WEB_PORT` | daemon, service units | `8321` | HTTP/websocket port |
| `PD_WEB_HOST` | daemon, service units | `127.0.0.1` (units set `0.0.0.0`) | Bind address |
| `PD_WEB_DIST` | daemon | `<repo>/apps/web/dist` | Webapp build dir override |
| `PD_SRC` | CLI shim, service units | `~/.pideck/src` | Monorepo checkout the service runs |
| `PD_NODE` | CLI shim | system `node` | Node binary for the forwarded daemon CLI |
| `PD_DAEMON_URL` | daemon CLI | `http://127.0.0.1:$PD_WEB_PORT` (port fallback `8321`) | Daemon base URL the CLI talks to; an existing env value wins |
| `PIDECK_MODEL` | onboarding, agent sessions | unset | Model picked during onboarding |
| `PD_PI_DIR` | daemon pi auth probe | `~/.pi/agent` | pi config dir the probe reads (`settings.json` startup model; keep in sync with the installer's value) |
| `PD_SESSION_ID` | set by the daemon | — | Injected into each agent session so prompts/skills can reference their own session |

Bootstrap-only overrides (rarely needed; see `install/bootstrap.sh`): `PD_REPO_URL`, `PD_REPO_REF`, `PD_NODE_VERSION`, `PD_PI_PACKAGE`, `PD_PI_DIR`.

## Platform support

| Platform | Status |
| --- | --- |
| Linux x64 (apt-based) | **Tested.** Full bootstrap (`--dry-run`), onboarding (`--dry-run`), service unit rendering, shim forwarding tests, and live smoke of the installed shim against the built daemon. Non-apt distros and sudo-requiring git installs are reviewed but untested. |
| macOS | **Code-reviewed, not run on hardware.** launchd agent (`RunAtLoad`, `KeepAlive` on crash), `ipconfig getifaddr` URL detection, Xcode CLT install dialog are all kept in isolated functions for review. |
| Windows via WSL2 | **Code-reviewed, not tested on real Windows hardware.** The PowerShell bootstrap enables systemd in the distro and reuses the Linux installer; the service unit is the WSL service path. Host-browser access relies on WSL2 localhost forwarding; LAN access needs a Windows portproxy + firewall rule (documented with caveats in [install/README.md](install/README.md)). |
| Windows native | Not supported (explicit PRD non-goal). |

See "Tested matrix" in [install/README.md](install/README.md) for the itemized list.

## Verifying the loop

With a project connected (onboarding wizard) and auto-spawn enabled, this is what works end to end today:

1. `pideck status` — daemon is up.
2. Open the webapp → your project's board; issues and open PRs (with `ciStatus`/`reviewState`) appear as kanban cards pulled live from GitHub.
3. `pideck sessions --project <id>` — the project's orchestrator session exists; open **Terminals** in the webapp and hold a conversation with it. It can file issues (`create-issue` skill) and spawn workers (`spawn-worker` skill).
4. Watcher auto-spawn — file or assign an issue on the project's repo (created by, or assigned to, the configured auto-agent username, and not blocked via native blocked-by links). Within a poll interval the daemon spawns a worker on its own: a worker tmux session appears in **Terminals** and the issue's card moves to `in_progress`. (Manual spawning still works: from the orchestrator chat, or `pideck spawn --project <id> --issue <n> --name "my-worker"`.)
5. When the worker pushes a PR, it appears on the board (`in_review`, with combined CI status); read the full diff at `projects/:id/pulls/:n` in the webapp or `pideck diff --project <id> <n>`.
6. CI auto-fix and review addressing — if the PR's CI fails, the daemon prompts the worker to fix it (bounded retries); a new review comment is delivered to the worker for a follow-up commit. Both show up in the worker's terminal and the PR card tracks state until merge (or the attempt limit is exhausted).
7. All of the above survives a daemon restart: sessions are reconciled and resurrected from the persisted registry, and the PR loop resumes from its persisted tracker (no duplicate workers, no lost PR watch).

The PRD success metric — *issue created → worker auto-spawns → PR → CI breaks → worker fixes → CI green, zero manual commands* — holds for an auto-spawn-enabled project with a working `gh` login; CI/review follow-up is bounded (`maxFixAttempts`), after which a human takes over.

## Repository layout

TypeScript monorepo managed with [pnpm workspaces](https://pnpm.io/workspaces):

| Path              | Package                | Purpose                                                                 |
| ----------------- | ---------------------- | ----------------------------------------------------------------------- |
| `apps/daemon/`    | `@pideck/daemon`   | Orchestration backend: REST+WS API, projects, tmux session control, terminal bridge, GitHub integration, spawn/PR pipelines |
| `apps/web/`       | `@pideck/web`      | Web app: onboarding wizard, kanban board, browser terminals, diff review |
| `packages/shared/`| `@pideck/shared`   | Shared zod contracts: domain model, REST endpoint map, WS events         |
| `agent/`          | `@pideck/agent`    | pi coding agent integration: skills, extensions, prompts                 |
| `install/`        | `@pideck/install`  | One-line install, service setup (launchd/systemd/WSL), onboarding, CLI shim |

## Development setup

Prerequisites:

- Node.js >= 22
- pnpm (enabled via corepack, pinned by `packageManager` in `package.json`)

```sh
# Enable pnpm from the pinned version (one-time)
corepack enable pnpm

# Install all workspace dependencies
pnpm install

# Build every workspace package (tests need packages/shared built first)
pnpm build

# Run tests (vitest)
pnpm test

# Lint and typecheck
pnpm lint
pnpm typecheck

# Everything CI runs (lint, typecheck, build, test, kiss) in one go
pnpm check

# KISS hygiene ratchet (dead code, complexity budgets, duplication)
pnpm kiss
```

The same steps run in CI (`.github/workflows/ci.yml`) on every pull request — CI calls `pnpm check`, the same script the pre-push hook below uses.

## Git hooks

Husky hooks are installed automatically by `pnpm install` (the `prepare` script) and live in the source checkout under `.husky/` — installed copies created by the one-line installer are unaffected.

- **`pre-push`** runs `pnpm check` (lint, typecheck, build, test, kiss) — the exact same script CI runs, so what passes locally passes in CI. Bypass it with `git push --no-verify` when you really must; CI is the backstop.
- **`pre-commit`** is cheap-only: [lint-staged](https://github.com/lint-staged/lint-staged) runs `eslint --fix` on staged files only (sub-second). The expensive checks deliberately stay on push.

Full suite runtime is well under two minutes; if it ever grows past that, split `pre-push` into a documented subset rather than silently slowing every push.

## KISS hygiene (CI "kiss" checks)

The `kiss` checks in CI enforce the KISS principle mechanically, so it doesn't rely on discipline. They run three tools, each with a **ratchet baseline** checked into `kiss-baseline/`: every violation present on today's main is listed there, and the checks **fail on any violation not in the baseline** (and on baseline entries that no longer apply, so baselines may only shrink):

| Check        | Tool                                                     | What it fails on                                                        | Baseline                    |
| ------------ | -------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| Dead code    | [knip](https://knip.dev)                                 | Unused files, exports, types, dependencies, duplicate exports           | `kiss-baseline/knip.json`   |
| Complexity   | ESLint (`max-lines`, `max-lines-per-function`, `complexity`, `max-depth`) | New oversized or convoluted files/functions (rules run as warnings locally, ratcheted in CI) | `kiss-baseline/eslint.json` |
| Duplication  | [jscpd](https://github.com/kucherenko/jscpd)             | Copy-pasted blocks over `apps/ packages/ install/` (tests and fixtures ignored) | `kiss-baseline/jscpd.json`  |

Run the checks locally with:

```sh
pnpm kiss             # all three checks (what CI runs)
pnpm kiss:knip        # just dead code
pnpm kiss:complexity  # just complexity budgets
pnpm kiss:dup         # just duplication (new clones)
```

### Paying down the baseline

Baselines only shrink. When you delete an unused export, split an oversized file, or refactor a copy-pasted block, CI will fail with the exact stale baseline entries — trim them by regenerating:

```sh
pnpm kiss:baseline    # rewrites kiss-baseline/ from the current repo state
```

Commit the trimmed baseline together with your fix. Never add entries to a baseline to make a check pass for *new* code — new violations must be fixed. If some debt is genuinely tracked, it is baselined only while an open refactor issue owns it (currently #70–#73).
