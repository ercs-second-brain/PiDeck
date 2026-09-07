# agentsKISS

A self-hosted, single-command AI coding agent orchestration platform — pi coding agent workers, driven by GitHub issues and PRs, managed from a kanban and browser terminals on your own machine.

See [docs/agentskiss-prd.md](docs/agentskiss-prd.md) for the PRD and [docs/agentskiss-concept.md](docs/agentskiss-concept.md) for the concept brief (the spec of record). Detailed operator documentation lives in [install/README.md](install/README.md); the agent integration contract in [agent/README.md](agent/README.md).

## How the pieces fit together

One daemon process serves everything on a single port (default `8321`) at the machine's own address — no auth, by design, for a trusted private network:

- **`apps/daemon/`** — the orchestration backend. It serves the REST API (`/api/...`), the kanban websocket hub (`/api/ws`), the browser-terminal bridge (`/ws`, streaming tmux panes), and the built webapp as static files. It owns tmux session control, the session registry (persistent across restarts, with resurrect-on-startup), per-project orchestrator sessions (booted automatically with the rendered orchestrator prompt), GitHub reads (issues, PRs with CI/review metadata, diffs, blocked-by links), and worker spawning into fresh git worktrees.
- **`apps/web/`** — the webapp the daemon serves: project list → onboarding wizard (pi/gh status, clone-or-create repo with private-by-default, auto-agent settings) → per-project kanban board, PR diff review, settings — plus the browser terminal page for orchestrator and worker tmux sessions.
- **`agent/`** — pi coding agent integration: the orchestrator/worker system prompts (assembled by the daemon) and the pi skills the agents use to drive the `agentskiss` and `gh` CLIs.
- **`install/`** — the one-line installer, service registration (launchd / systemd user unit, which is also the WSL path), guided onboarding, and the `agentskiss` CLI shim.
- **`packages/shared/`** — the zod contracts shared by daemon and webapp (domain model, REST endpoint map, WS events).

**Status of the automated loop:** the interactive parts of the PRD core loop are live — orchestrator sessions, manual worker spawn (webapp / orchestrator chat / `agentskiss spawn`), kanban tracking of issues and PRs with CI/review state, diff review, browser terminals, session persistence across daemon restarts. The fully automatic steps — issue-watcher auto-spawn on unblocked issues, CI-failure auto-fix, and review-comment addressing — are implemented and tested as daemon modules but **not yet wired into the running daemon**, so they do not fire today. This is tracked in [ercs-second-brain/agentsKISS#46](https://github.com/ercs-second-brain/agentsKISS/issues/46); until it lands, workers are spawned manually and CI/review follow-up is prompted by you or the orchestrator through the terminal.

## Quickstart

On macOS or Linux (or inside a WSL2 distro):

```sh
curl -fsSL https://raw.githubusercontent.com/ercs-second-brain/agentskiss/main/install/bootstrap.sh | sh
```

On Windows, use the WSL bootstrap from PowerShell (bootstraps WSL if missing, then runs the Linux path inside it):

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install\windows\agentskiss-setup.ps1
```

The installer installs git/Node 22/pnpm/gh as needed (user-level, no sudo), fetches and builds the monorepo, installs the pi coding agent, links the agentskiss pi skills, registers the persistent service, and runs guided onboarding: pi auth + model selection, then gh CLI auth (a PAT from `~/.env` is used when present, else `gh auth login`). Details, flags, and the `--dry-run` mode: [install/README.md](install/README.md).

When onboarding finishes, open the webapp at the printed address (`agentskiss addr`) and walk the onboarding wizard to connect a repo: clone from git or create a new GitHub repo (private by default, toggle for public), and choose whether issues auto-create agents. Then head to **Terminals** to talk to the project's orchestrator.

## Everyday commands

`agentskiss` is one entry point: a small set of service verbs handled by the installed shim, everything else forwarded to the daemon CLI (used heavily by the pi skills). The full precedence table and flag reference is in [install/README.md](install/README.md); the common shapes:

```sh
agentskiss service start|stop|restart|status   # manage the persistent service
agentskiss logs [-f]                           # daemon logs
agentskiss addr                                # the webapp URL for this machine
agentskiss onboard [--dry-run]                 # re-run guided onboarding

agentskiss status [--json]                     # daemon health
agentskiss project get <id> | ls [--json]      # registered projects
agentskiss kanban|sessions|workers|pulls --project <id> [--json]
agentskiss diff --project <id> <pr-number>
agentskiss spawn --project <id> [--issue <n>] --name <label> [--prompt <task>]
agentskiss send --session <id> --message <text>
```

## Environment variables

Defaults are sensible; the installer writes the first group into `~/.agentskiss/env` (sourced by the service and the CLI shim).

| Variable | Consumer | Default | Meaning |
| --- | --- | --- | --- |
| `AGENTSKISS_HOME` | installer, daemon | `~/.agentskiss` | State/config root |
| `AGENTSKISS_WEB_PORT` | daemon, service units | `8321` | HTTP/websocket port |
| `AGENTSKISS_WEB_HOST` | daemon, service units | `127.0.0.1` (units set `0.0.0.0`) | Bind address |
| `AGENTSKISS_WEB_DIST` | daemon | `<repo>/apps/web/dist` | Webapp build dir override |
| `AGENTSKISS_SRC` | CLI shim, service units | `~/.agentskiss/src` | Monorepo checkout the service runs |
| `AGENTSKISS_NODE` | CLI shim | system `node` | Node binary for the forwarded daemon CLI |
| `AGENTSKISS_DAEMON_URL` | daemon CLI | `http://127.0.0.1:$AGENTSKISS_WEB_PORT` (port fallback `8321`) | Daemon base URL the CLI talks to; an existing env value wins |
| `AGENTSKISS_MODEL` | onboarding, agent sessions | unset | Model picked during onboarding |
| `AGENTSKISS_SESSION_ID` | set by the daemon | — | Injected into each agent session so prompts/skills can reference their own session |

Bootstrap-only overrides (rarely needed; see `install/bootstrap.sh`): `AGENTSKISS_REPO_URL`, `AGENTSKISS_REPO_REF`, `AGENTSKISS_NODE_VERSION`, `AGENTSKISS_PI_PACKAGE`, `AGENTSKISS_PI_DIR`. Development-only: `AGENTSKISS_PORT`/`AGENTSKISS_STATE_DIR` configure the standalone terminal server in `apps/daemon/src/terminal/standalone.ts`.

## Platform support

| Platform | Status |
| --- | --- |
| Linux x64 (apt-based) | **Tested.** Full bootstrap (`--dry-run`), onboarding (`--dry-run`), service unit rendering, shim forwarding tests, and live smoke of the installed shim against the built daemon. Non-apt distros and sudo-requiring git installs are reviewed but untested. |
| macOS | **Code-reviewed, not run on hardware.** launchd agent (`RunAtLoad`, `KeepAlive` on crash), `ipconfig getifaddr` URL detection, Xcode CLT install dialog are all kept in isolated functions for review. |
| Windows via WSL2 | **Code-reviewed, not tested on real Windows hardware.** The PowerShell bootstrap enables systemd in the distro and reuses the Linux installer; the service unit is the WSL service path. Host-browser access relies on WSL2 localhost forwarding; LAN access needs a Windows portproxy + firewall rule (documented with caveats in [install/README.md](install/README.md)). |
| Windows native | Not supported (explicit PRD non-goal). |

See "Tested matrix" in [install/README.md](install/README.md) for the itemized list.

## Verifying the loop

With a project connected (onboarding wizard), this is what works end to end today:

1. `agentskiss status` — daemon is up.
2. Open the webapp → your project's board; issues and open PRs (with `ciStatus`/`reviewState`) appear as kanban cards pulled live from GitHub.
3. `agentskiss sessions --project <id>` — the project's orchestrator session exists; open **Terminals** in the webapp and hold a conversation with it. It can file issues (`create-issue` skill) and spawn workers (`spawn-worker` skill).
4. Spawn a worker for an issue — from the orchestrator chat, or directly:
   `agentskiss spawn --project <id> --issue <n> --name "my-worker"`.
   The worker gets its own tmux session and git worktree; the issue's card moves to `in_progress`; watch it work in the terminal.
5. When the worker pushes a PR, it appears on the board (`in_review`, with combined CI status); read the full diff at `projects/:id/pulls/:n` in the webapp or `agentskiss diff --project <id> <n>`.
6. All of the above survives a daemon restart: sessions are reconciled and resurrected from the persisted registry.

The PRD success metric — *issue created → worker auto-spawns → PR → CI breaks → worker fixes → CI green, zero manual commands* — requires the watcher/pipeline wiring from [issue #46](https://github.com/ercs-second-brain/agentsKISS/issues/46); steps 4 and CI/review follow-up are manual until then.

## Repository layout

TypeScript monorepo managed with [pnpm workspaces](https://pnpm.io/workspaces):

| Path              | Package                | Purpose                                                                 |
| ----------------- | ---------------------- | ----------------------------------------------------------------------- |
| `apps/daemon/`    | `@agentskiss/daemon`   | Orchestration backend: REST+WS API, projects, tmux session control, terminal bridge, GitHub integration, spawn/PR pipelines |
| `apps/web/`       | `@agentskiss/web`      | Web app: onboarding wizard, kanban board, browser terminals, diff review |
| `packages/shared/`| `@agentskiss/shared`   | Shared zod contracts: domain model, REST endpoint map, WS events         |
| `agent/`          | `@agentskiss/agent`    | pi coding agent integration: skills, extensions, prompts                 |
| `install/`        | `@agentskiss/install`  | One-line install, service setup (launchd/systemd/WSL), onboarding, CLI shim |

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
```

The same steps run in CI (`.github/workflows/ci.yml`) on every pull request.
