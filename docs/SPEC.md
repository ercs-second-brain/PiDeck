# PiDeck — Target Specification (v2)

> The spec of record. Everything in this repo exists to implement this document.
> If code and this document disagree, the document wins until it is changed here.

## 1. What PiDeck is

A self-hosted, single-user orchestration layer around the **pi coding agent**. One daemon on your
machine, one web UI with browser terminals, four agent personas, and **GitHub as the only control
plane**. Issues are the work queue, assignment is the trigger, comments are the steering channel,
PRs and reviews are the state.

PiDeck is plumbing. Pi is the agent. PiDeck never customises what agents *can do* — only how the
four personas *behave inside the loop* and how sessions are wired together.

### Users

One person, on their own machine, on any repos they like. Others may install it for themselves the
same way. Nothing is hardcoded to a person, account, or repo; all of that is configuration.

### Non-goals

- Hosted service, accounts, or web authentication (private network, like pi).
- Kanban / boards / dashboards — GitHub is the board.
- Diff viewer — GitHub is the diff viewer.
- Windows (native or WSL). macOS and Linux only.
- User-defined agent types, per-persona skill assignment, or any capability layer over pi.
- Chat UI. All conversation happens in tmux terminals.
- Backwards compatibility with PiDeck v1 state.

## 2. The loop

```
you ──talk──▶ project orchestrator ──files/assigns──▶ GitHub issue
                      ▲                                     │ assigned + unblocked
                      │ steering messages                   ▼
                      │                                  worker ──opens──▶ PR
                      │                                     ▲              │ CI green
                      │                                     │ changes      ▼
                      │                                     └─requested── reviewer
                      │                                                    │ approved + CI green
                      └──── "PR #n approved & green" ◀─────────────────────┘
                                   │
                                   ▼
                    alignment check → merge (auto or on your say-so)
```

1. **You talk to the project orchestrator** in its terminal: requirements, bugs, questions. It
   investigates the codebase, files GitHub issues, and maintains `docs/`.
2. **The orchestrator releases work by assigning the issue** on GitHub (to the primary account).
   You can assign an issue yourself for the same effect. Assignment is the *only* spawn trigger.
3. **The daemon spawns a worker** for each assigned, unblocked issue (respecting the project's
   concurrency cap). The worker implements the issue on branch `pideck/issue-<n>` and opens a PR.
4. **When CI is green, the daemon spawns a reviewer** (second GitHub account). It files a real
   GitHub review: request changes or approve.
5. **Changes requested → the same worker fixes and pushes → the same reviewer re-reviews.**
   Repeat until approved.
6. **Approved + CI green → the orchestrator is steered.** It does an *alignment check* (does this do
   what was asked? read issue, PR body incl. `## Follow-ups`, diff) and then either merges
   (`autoMerge: true`) or recommends the merge to you (`autoMerge: false`).
7. **Merge closes the issue** (`Closes #n`), which unblocks dependents; the next poll spawns them.
8. **The global agent** sits above all project orchestrators for cross-repo work, portfolio status,
   and policy. It never files issues or spawns; it directs orchestrators.

### Communication channels — GitHub only

| From → To | Channel |
|---|---|
| Orchestrator → worker (release work) | assign the issue |
| Worker → orchestrator (**blocker**) | comment on the *issue*; worker goes idle |
| Orchestrator → worker (answer) | comment on the *issue*; wakes the idle worker |
| Worker → orchestrator (**follow-ups / found issues**) | `## Follow-ups` section in the PR body; read at alignment check |
| Reviewer → worker | GitHub review (request changes / approve, inline comments) |
| Worker → reviewer (push-back) | reply in the review thread; reviewer re-evaluates next round |
| Orchestrator → worker (failed alignment) | comment on the *PR* |
| Daemon → orchestrator | steering message into the pane (see §4) |
| Global agent → orchestrator | `pideck send` |
| You → anything | the terminal, or GitHub |

Workers and reviewers never use `pideck send`. Nothing goes through a side channel that doesn't
leave a trail in GitHub.

## 3. Personas

Exactly four, hardcoded. Each has a shipped prompt in `agent/prompts/<persona>.md`, editable and
resettable to default in the web UI. Each can be assigned its own model.

| Persona | Spawns | Writes | Talks via | Lives |
|---|---|---|---|---|
| **global** | nothing | nothing | `pideck send` to orchestrators | one per install |
| **orchestrator** | nothing directly (assigns issues) | `docs/` only, commits directly | GitHub + terminal | one per project, persistent |
| **worker** | nothing | source, on `pideck/issue-<n>` | GitHub | one per assigned issue, assignment → merge |
| **reviewer** | nothing | nothing | GitHub reviews | one per PR, first green → approved |

### Prompt style

Short. Role + loop + hard boundaries + judgment guidance + context. Targets: orchestrator ≤ 80
lines, worker ≤ 50, reviewer ≤ 40, global ≤ 40. No confidentiality block, no publishing-scope
block, no CLI reference beyond the handful of commands that persona uses, no rules that the
daemon enforces mechanically, no anti-patterns learned from bugs. Designed for strong models
(Claude / GLM class): give principles and examples, not rulebooks.

One etiquette rule that materially matters: **workers and reviewers end a turn only at a
platform-visible checkpoint** — a push, a PR opened, a review filed, or an issue comment. Never
mid-thought.

### The orchestrator's judgment

The single most important prompt property: knowing when *not* to stop. Proceed autonomously on
anything the user has been clear about (in conversation, in the issue, in `docs/`). Stop and ask
when a decision changes scope, cost, or user-visible behaviour and nothing on record speaks to it.
When unsure which, do the reversible thing.

### Project memory

- `docs/` — living documents the orchestrator maintains: decisions, briefs, PRDs, standing
  preferences, `docs/REVIEW.md` (reviewer guidance). Committed directly to the default branch.
- `AGENTS.md` — immutable rules only. Pi reads it natively.
- On (re)launch the daemon delivers a **briefing**: open issues (assigned / blocked / unassigned),
  in-flight PRs with state, live workers/reviewers, and a pointer to `docs/`.

### Reviewer policy

Scope: correctness, bugs, maintainability of the diff — reading the issue for context, but *not*
judging alignment (that is the orchestrator's). **Blocking** only for incorrect behaviour, bugs,
security/data-loss risk, changed behaviour with no test, or plainly not doing what the issue says.
Everything else is a non-blocking comment on an approving review. Deterministic strictness (lint,
format, coverage) belongs in CI, never in the reviewer. Per-project tuning via `docs/REVIEW.md`.

## 4. Daemon

### Reconciliation, not events

There is no restart path and no event pipeline: **every poll (default 30 s) is a reconciliation**,
and a restart is just the first poll. GitHub is read; desired state is derived; the gap to actual
state (session registry + tmux) is closed.

| GitHub fact | Desired state |
|---|---|
| issue open + assigned + all `blocked by` links closed | exactly one live worker |
| issue open + assigned + any open blocker | no worker (re-evaluated next poll; nothing stored) |
| issue unassigned or closed | no worker (archive if present) |
| open PR on `pideck/issue-<n>` | attached to issue n's worker |
| PR merged or closed | worker archived |
| PR CI green + not approved + no merge conflicts | exactly one live reviewer |
| PR approved, merged, or closed | no reviewer |

Workers and reviewers are **replaced** (fresh session, same issue/PR) when their pane dies, the
user deletes them, or their context usage exceeds the configured percentage.

Each worker and reviewer session runs in its own isolated clone of the project (under the daemon
state dir, origin repointed at GitHub); the orchestrator and global agent work in the project
clone directly.

The daemon guarantees the review account can read every registered repo: on registration and on
every poll it checks access as the review account, invites it with `push` as a collaborator (as
the primary account) and accepts the pending invitation; while access is missing, `Status`/project
view shows "review account has no access to <repo>" and no reviewer is spawned.

### Failure and throttling

GitHub failure is expected, not exceptional. `gh` responses that signal a rate limit — HTTP 403
with the rate-limit message or `X-RateLimit-Remaining: 0`, the secondary-rate-limit wording, or
HTTP 429 — throw a typed `GhRateLimited { resetAt }`. The reconciler keeps per-project backoff
state: a failed tick retries on a 30 s → 1 m → 2 m → 5 m ladder (reset by the first success), a
rate-limited project waits until `resetAt`, and other projects are never affected. While a
throttle is active, `Status.github.throttledUntil` says so — the header shows a quiet
"GitHub throttled until hh:mm" pill and `pideck status` prints it — and the last per-project
tick error is surfaced as `Status.github.lastError`. A `blockedBy` 404/403 degrades to the last
known blocker count for that issue with one log line, instead of failing the whole project
tick; and the `/api/status` probes (`pi`, `gh`) are cached for 30 s.

### Per-session memory (persisted in the session registry)

`persona`, `projectId`, `issueNumber`, `prNumber`, `tmuxSession`, `spawnedAt`, `model`, and
delivery watermarks keyed on GitHub ids: `lastPromptedHeadSha`, `lastDeliveredIssueCommentId`,
`lastDeliveredPrCommentId`, `lastDeliveredReviewId`, `lastNotifiedConflictSha`, `fixAttempts`,
`lastActivityAt`. Losing a watermark costs at most one duplicate prompt.

Everything in this section is a pure derivation over GitHub state, exercised end to end against
the fake gh (§10); the session trace (§10) replays one session's deliveries and watermarks to
answer "why was I prompted".

### Deliveries into panes (single line, then Enter)

| Trigger | To | Content |
|---|---|---|
| spawn | worker | issue number, title, URL, branch name, "open a PR with `Closes #n`" |
| CI red on a new head | worker | failing check names, attempt k of N |
| PR conflicts with main | worker | rebase, resolve, push (once per head) |
| new review requesting changes / new PR comments | worker | pointer to the review / comments |
| new issue comment from someone other than the worker | worker (wakes idle) | pointer to the comment |
| spawn | reviewer | PR number, repo, "file exactly one review" |
| new head since last review | reviewer | "re-review" |
| PR approved + CI green | orchestrator | "PR #n for issue #m is approved and green — alignment check" |
| worker blocker comment / fix attempts exhausted | orchestrator | pointer to the issue comment |
| worker stalled (no push/PR/comment for `stallMinutes`) | orchestrator | "worker for #n has been silent" |
| (re)launch | orchestrator | the briefing (§3) |

Steering messages to the orchestrator queue for pi's next turn; they never interrupt.
The fix-attempt bound is a safety net: on exhaustion the *worker* is told to comment its status on
the issue and go idle — the orchestrator judges continue / stop / retry. The "fix attempts
exhausted → orchestrator" row is satisfied through that comment: the daemon delivers the
exhaustion prompt to the worker, and the worker's `BLOCKED:` comment routes to the orchestrator.

The daemon and web UI serve on one port bound to `0.0.0.0` without authentication, by design:
the audience is the owner's own machine, LAN, and phone — authentication is a §1 non-goal.

### Settings

Global (onboarding): pi auth, primary `gh` auth, **review account (required)**: username + PAT,
model per persona.

Per project: `workerConcurrency` (default 3), `maxFixAttempts` (default 5), `contextLimitPercent`
(default 80), `stallMinutes` (default 20), `autoMerge` (default false).

### CLI

`pideck` forwards service verbs (`service`, `logs`, `addr`, `onboard`, `update`) to the shim and
everything else to the daemon: `status`, `project ls|get`, `sessions`, `workers`, `send`. There is
no `pideck spawn`; assignment spawns.

## 5. Web UI

- **Terminals** — sidebar: projects → orchestrator → workers with nested reviewers; click to attach.
  Each worker row shows one of: `working`, `ci`, `fixing`, `in review`, `addressing`, `ready`,
  `blocked`, `done`. All derived by the daemon from GitHub + registry; nothing agent-reported.
- **Onboarding wizard** — pi auth + model, gh auth, review account, clone or create repo.
- **Global settings** — review account, model per persona, prompt editor (four personas,
  edit / reset to default).
- **Project settings** — the five knobs above; delete project.
- **Archived session logs**, **update banner** (in-UI self-update), **PWA** for phones.

## 6. Install

One-line bootstrap for macOS and Linux: git, Node 22, pnpm, gh, pi (user-level, no sudo); clone,
build, register a service (launchd / systemd user unit); guided onboarding. `pideck update`
fetches, rebuilds, restarts. Skills under `agent/skills/` are symlinked into `~/.pi/agent/skills/`
and pi loads them the way it loads any skill; PiDeck has no skill plumbing of its own.

## 7. Shipped skills

Orchestrator methodology, loaded on demand by pi: `concept-brief`, `prd`, `spec-to-issues`,
`bash-triage` (collect + triage only — running the batch is the orchestrator's job). All express
"release work" as *assign the issue*.

## 8. Repository layout

```
agent/prompts/{global,orchestrator,worker,reviewer}.md
agent/skills/{concept-brief,prd,spec-to-issues,bash-triage}/SKILL.md
apps/daemon/      reconciler, github client, sessions (tmux + registry), api, cli
apps/web/         terminals, onboarding, settings, prompt editor
packages/shared/  zod contracts
install/          bootstrap, service units, onboarding, shim
docs/             SPEC.md (this), PHILOSOPHY.md, DECISIONS.md
```

## 9. Engineering rules

- Simplicity is the product. Every module must be explainable in one paragraph in this document.
- No comments that cite issue numbers. Code explains itself or the doc explains it.
- No settings without a stated user who needs them.
- GitHub is the source of truth; PiDeck persists only what GitHub cannot tell it.

## 10. Testing & debugging

The loop is exercised without GitHub, real agents, or the network:

- **Fake gh** — `tools/fake-gh/`, a scripted `gh` serving a mutable JSON repo
  state (issues, blockers, comments, PRs with CI rollup, reviews, collaborator
  invitations) and applying writes back to it. The daemon-level test
  (`apps/daemon/src/e2e/loop.test.ts`) boots the real reconciler against it
  with a fake tmux and walks §2 end to end in seconds.
- **Scenario runner** — scripts a whole §2 story (multi-issue, red CI, change
  requests, merge) as a sequence of state mutations, for reproducing bugs
  locally against a live daemon; run as `pnpm e2e` (`tools/e2e/`,
  `--scenario blocked|restart`) — needs real GitHub, not the fake gh.
- **Session trace** — replays one session's deliveries, watermarks, and pane
  log from the state dir, to answer "why was I prompted".
- **UI gallery** — renders every web primitive and screen state on one page.
