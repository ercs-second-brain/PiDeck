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
- **PiDeck personas stay basic and behavioral.** The prompts in
  `agent/prompts/` (global agent, orchestrator, worker, review, researcher,
  devex/kiss audits) define how an agent behaves *within the loop* —
  coordination, delegation, CI-fix discipline, reporting — not what it can do.
- **Shipped skills/prompts are integration-level.** Everything PiDeck ships
  (`agent/skills/`) is about how agents talk to PiDeck: the `pideck` and
  `gh` CLIs, issue creation, PR reporting, status lookups. Never capability.
- **Repo rules live with the repo.** Per-project coding conventions and
  constraints belong in the project's own `AGENTS.md`, which pi reads
  natively. PiDeck has no opinion and no override layer.

## Where does X go?

| X | Goes in |
| --- | --- |
| Agent abilities and tools (e.g. browser control) | pi — user installs packages/skills/extensions |
| Project/session lifecycle (spawn, kanban, restart, terminals) | PiDeck daemon |
| Persona behavior (orchestrator/worker/review/audit roles) | basic prompts in `agent/prompts/` |
| Dashboard / UI | PiDeck webapp (`apps/web/`) |
| Repo rules and conventions | the project's own `AGENTS.md` |

When a feature request lands, ask first: is this plumbing PiDeck already
owns, or is it a capability the user should add to their pi setup? Ship the
former; point to the latter.
