# PRD: agentsKISS

**One-liner:** A self-hosted, single-command AI coding agent orchestration platform — pi coding agent workers, driven by GitHub issues and PRs, managed from a kanban and browser terminals on your own machine.

## Problem
Running coding agents on real repos means constantly shepherding: reading issues, spawning agents, watching CI, replying to review comments, updating a board. That loop is repetitive and manual. agentsKISS automates the loop the way agent-orchestrator does, but as one install command and a webapp — no desktop or mobile apps.

## Users
- **Owner (you):** runs it on a machine in your private network, connects repos, creates issues, reviews PRs, chats with the orchestrator and workers through terminals.

## Goals
- An issue on GitHub becomes a PR with green CI and addressed review comments without you touching a terminal
- Full visibility and control from the browser: kanban for state, tmux terminals for conversation
- Install-to-running in one command on Mac, Linux, or Windows (via WSL)

## Non-goals
- Hosted service, user accounts, or webapp authentication (trusted private network, like pi itself)
- Desktop/mobile apps, landing page, cost analysis
- Chat UI in the webapp — all agent conversation happens in tmux terminals
- Multi-agent swarms beyond orchestrator-spawns-workers
- Native (non-WSL) Windows support

## Features

### P0 — must ship
- **One-line install**: single command sets up daemon + webapp + pi coding agent + custom pi skills/extensions; runs as a persistent service (launchd/systemd/WSL service) — *done when* a fresh Mac, Linux, or WSL machine goes from paste-command to reachable webapp with no other manual steps
- **Guided onboarding**: pi auth flow + model selection, then gh CLI auth (PAT, typically already in `~/.env`) — *done when* a first run walks through both and remembers them
- **Repo connection**: if gh auth has sufficient permissions, choose clone-from-git or create-new-repo (defaults private, toggle to public) — *done when* a repo is cloned/created and registered as a project
- **Issue watcher + auto-spawn**: when an issue is created or assigned to the configured username, and it's not blocked via GitHub's native "blocked by" relationship links, spawn a worker in that project — *done when* a fresh unblocked issue produces a running worker with no manual action
- **Orchestrator agent**: per-project orchestrator in its own tmux session that can create issues and spawn workers through chat — *done when* asking it in a terminal results in a new issue and/or spawned worker
- **Kanban board**: project list → board per project, tracking issues and PRs through agent-orchestrator-style columns — *done when* spawning a worker and opening a PR both visibly move cards
- **Web terminal**: attach to orchestrator and worker tmux sessions from the browser (done well — first-class, not a status page) — *done when* you can hold a working conversation with a worker from a browser on another device, including after reconnect
- **Diff review**: view a worker's/PR's diff in the webapp — *done when* an open PR's diff is readable in the browser
- **CI watching & auto-fix**: worker watches its PR's CI, fixes failures, pushes again — *done when* a PR that starts red ends green with no manual commands
- **Review comment addressing**: worker addresses review comments on its PR — *done when* a review comment produces a follow-up commit without manual prompting

### P1 — should ship
- Per-project worker concurrency limits
- Daemon survives reboot/restart with sessions resumable

### P2 — later
- Non-GitHub forges (the "MRs" instinct — e.g., GitLab)
- Native Windows without WSL

## Success metric
One full loop — issue created → worker spawns → PR opened → CI breaks → worker fixes → CI green — completing with zero manual commands beyond creating the issue.

## Risks & open questions
- **Web terminal is the biggest engineering item** (websocket↔tmux bridge, browser terminal emulator, reconnect/resume) — treat as its own workstream
- **Prompt porting**: agent-orchestrator's prompts are the base but reference their tooling; they must be adapted to agentsKISS's commands, not dropped in
- **WSL friction**: install, service management, and webapp access from the Windows host need a tested path
- **Worker concurrency**: unbounded (every unblocked issue spawns a worker) vs. capped — needs a decision before implementation
- **Blocking semantics**: exact handling of GitHub relationship links ("blocked by: #123") to be pinned down against the real API
