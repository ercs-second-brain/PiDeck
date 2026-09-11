# PiDeck vs Pi: where the line is

PiDeck is **not** a customized agent. It is plumbing around one: project
management, orchestration, configuration, and remote access to agents —
simple and unopinionated. Pi is the agent itself; users customize it with
tools, skills, and extensions to fit their needs.

## What this means in practice

- **Capability customization lives in Pi, not PiDeck.** Example: browser
  control for testing, via a pi package like `pi-agent-browser-native`, is a
  Pi-level choice the user makes. PiDeck never installs, ships, or assumes
  such capabilities.
- **PiDeck personas stay basic and behavioral.** The four hardcoded prompts
  in `agent/prompts/` (global, orchestrator, worker, reviewer) define how an
  agent behaves *within the loop* — coordination, delegation, review
  discipline, reporting — not what it can do.
- **Shipped skills are methodology, not plumbing.** The skills PiDeck ships
  (`agent/skills/`: `concept-brief`, `prd`, `spec-to-issues`, `bash-triage`)
  are loaded by pi from `~/.pi/agent/skills/` like any other skill. PiDeck
  has no skill plumbing of its own; releasing work happens by assigning a
  GitHub issue, never by a PiDeck CLI.
- **Repo rules live with the repo.** Per-project coding conventions and
  constraints belong in the project's own `AGENTS.md`, which pi reads
  natively; living project memory belongs in `docs/`, maintained by the
  orchestrator. PiDeck has no opinion and no override layer.
- **GitHub is the only control plane.** Issues are the work queue, assignment
  is the spawn trigger, comments are the steering channel, PRs and reviews
  are the state. No kanban, no dashboards, no diff viewer.

## Where does X go?

| X | Goes in |
| --- | --- |
| Agent abilities and tools (e.g. browser control) | pi — user installs packages/skills/extensions |
| Project/session lifecycle (spawn on assignment, restart, terminals) | PiDeck daemon (`apps/daemon/`) |
| Persona behavior (global / orchestrator / worker / reviewer) | the four prompts in `agent/prompts/` |
| Orchestrator methodology (briefs, PRDs, issue triage) | shipped skills in `agent/skills/`, loaded by pi |
| Dashboard / UI | PiDeck webapp (`apps/web/`) |
| Living project memory (decisions, briefs, review guidance) | the project's own `docs/` |
| Repo rules and conventions | the project's own `AGENTS.md` |

When a feature request lands, ask first: is this plumbing PiDeck already
owns, or is it a capability the user should add to their pi setup? Ship the
former; point to the latter.