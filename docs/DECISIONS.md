# Decisions

The reasoning behind SPEC.md, in the order the questions were settled. Each entry is a decision
taken with the project owner; change one here before changing the spec.

| # | Decision | Why |
|---|---|---|
| 1 | Single user, self-hosted, portable | One person per install. Nothing hardcoded to an account or repo. |
| 2 | The loop is: talk → issue → assign → worker → PR → reviewer → orchestrator alignment → merge | This is the product. Everything else is support. |
| 3 | Assignment is the only spawn trigger | Unifies manual and orchestrator flows; GitHub is truth for "in progress". `pideck spawn` is gone. |
| 4 | Reviewer uses a second GitHub account (required) | Real `gh pr review` verdicts; GitHub's `reviewDecision` is the state. No single-account mode. |
| 5 | Merge is per-project configurable (`autoMerge`) | Auto: orchestrator merges after alignment check. Off: it recommends, you approve. |
| 6 | Orchestrator is steered on: approved+green, worker failed/exhausted, worker stalled, worker follow-up | Everything else is visible in GitHub. Steering = queued message for pi's next turn, never an interrupt. |
| 7 | Blockers → issue comment + idle. Follow-ups → `## Follow-ups` in PR body | GitHub-native, audit trail, no daemon parsing. |
| 8 | Orchestrator answers via issue/PR comments; a comment wakes an idle worker; a deleted worker is respawned fresh | Symmetric, one control plane. |
| 9 | Worker lives assignment → merge; replaced on death, deletion, or context % | Keeps context across CI/review rounds. Exhausted fix attempts = blocker path; orchestrator judges. |
| 10 | Project memory in `docs/` (living) and `AGENTS.md` (immutable); daemon delivers a relaunch briefing | Orchestrator never starts cold; decisions are versioned and visible to workers. |
| 11 | Four personas, hardcoded: global, orchestrator, worker, reviewer. No researcher, no audits, no agent-kind registry | Cut the largest over-abstraction. Prompts stay editable/resettable. |
| 12 | Keep methodology skills; cut `using-pideck`; cut all skill plumbing | Pi loads skills from `~/.pi/agent/skills/`; PiDeck ships files, nothing more. |
| 13 | No kanban, no diff viewer | GitHub does both better. |
| 14 | Eight worker states, all daemon-derived from platform facts | Agent-reported status was the root of most state bugs. |
| 15 | Prompts: short, role + loop + boundaries + judgment; no confidentiality/publishing blocks | Strong-model assumption. Daemon fixes plumbing; prose does not. |
| 16 | Reviewer: correctness + bugs + maintainability, reads the issue for context, blocks only on substance; per-repo tuning via `docs/REVIEW.md` | Style strictness belongs in CI. Alignment belongs to the orchestrator. |
| 17 | Global agent: cross-repo, status, policy; top-down only | Upper management, not another orchestrator. |
| 18 | Polling only; reconciliation every poll; nothing blocked-by-related persisted | Webhooks need a public endpoint. Restart = first poll. |
| 19 | Review account required in onboarding; model per persona; macOS + Linux; in-UI updates | Loop cannot run without the reviewer. |
| 20 | Same repo, wiped, rebuilt from this spec; no migration | Clean break from the demo. |
