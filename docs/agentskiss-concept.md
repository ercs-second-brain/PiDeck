# Concept Brief: agentsKISS

**Description:**
A simple, self-hosted AI coding agent orchestration platform that uses the pi coding agent as its coding agent. Installed with a single command on Mac, Windows, or Linux, it installs a daemon + web app and follows the orchestration patterns of agent-orchestrator (project list, kanban, issue/PR watching, CI watching, orchestrator agents spawning workers) — but radically simplified, with a webapp frontend instead of desktop/mobile apps.

## Mentioned
- Simple AI coding agent orchestration platform
- Uses the pi coding agent as the coding agent
- Single-line install command that runs on Mac, Windows, or Linux
- Install sets up the daemon + web app
- Install also installs the orchestrator and the pi coding agent, including any custom skills/extensions we need to add to pi for orchestration
- Leverage the orchestration prompts and setup of https://github.com/Untrivial-ai/agent-orchestrator
- Follow agent-orchestrator's same pattern for watching issues and PRs, kanban, project list with orchestrator agents that can spawn workers
- PR flow included too: automatically watching CI and fixing failures, and automatically addressing review comments — following the same pattern as agent-orchestrator
- It's a super simplified version of agent-orchestrator
- Instead of a desktop app and mobile app, use a webapp accessed at the address of the machine it was installed on
- Secured by the user; sandboxed like pi; typically run within a private network
- During install: go through the pi auth flow and model selection
- Then during install: set up the gh CLI and its auth (typically a PAT already in `~/.env`)
- If the gh auth has the right permissions, offer the user 2 options: clone from git, or create a new git repo
- Create-new-repo flow defaults to private, with a toggle during creation
- After repo setup: ask the user if they want issues to auto-create agents, and if so, what username
- When an issue is created or assigned to that user, and it is not blocked in GitHub, auto-spawn a worker in that project
- Blocking determined via GitHub's native issue relationship links ("blocked by: #123" and similar semantics that create an actual relationship link on the issue)
- MRs (PRs) are watched and tracked in the kanban just like agent-orchestrator
- Explicitly not needed: landing page, multi-agent stuff, desktop apps, mobile app, cost analysis

## Signals
- Simplicity is the core value proposition ("super simplified", "keep it simple", repeatedly cutting features)
- Security posture is assumed to be the user's own: private network, sandboxed, no hosted service implied
- Treats agent-orchestrator as the reference implementation to copy patterns from, not to fork wholesale
- Wants to lean on native GitHub mechanisms (relationship links) rather than inventing custom conventions
- Assumes typical user environment details (PAT already sitting in `~/.env`), suggesting a developer-first audience
- Said "MRs" while describing GitHub — suggesting familiarity with GitLab terminology or possible multi-forge interest

## Not clarified
- "multi-agent stuff" excluded — recorded as-is; how that differs from orchestrator-spawning-workers isn't specified
- Working name assumed to be **agentsKISS** (from the project/repo name) — confirmed by user
