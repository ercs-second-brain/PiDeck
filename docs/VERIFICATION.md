# Live verification — the §2 loop end to end (2026-09-12)

A full run of SPEC §2 against a throwaway private repo
(`ercs-second-brain/pideck-live`, trivial `node --test` CI workflow), observed
through the daemon API (`localhost:8321/api/...`), the daemon log, and `tmux
capture-pane` — never by typing into panes and never by polling GitHub in
shell loops. Times are UTC from the machine running the daemon.

## Setup

- Daemon built from `origin/main` (+ PR #558 merged locally at start; #558,
  #564, #565 were merged into main during the run and the daemon was rebuilt
  and restarted on them at the points marked below).
- `PD_HOME=/tmp/pideck-live`, serving `http://0.0.0.0:8321`, poll interval 30 s.
- Project `pideck-live` registered through the web onboarding earlier; review
  account `ercs-second-brain-reviewer` configured in the daemon with manual
  collaborator grant on the repo (the automatic guarantee landed later as
  #564 — the earlier run's reviewer leg had silently failed on a 404, which
  is why one stale reviewer session was terminated by hand at 02:16).
- Project settings: `workerConcurrency 3`, `maxFixAttempts 5`,
  `stallMinutes 20`, `autoMerge true`.

## The loop, issue by issue

### #1 power function — the happy path (02:16–02:17)

- PR #3 (`pideck/issue-1`) green on GitHub; the stale reviewer from the
  previous run was terminated (`POST /api/sessions/:id/terminate`) because it
  had approved locally but could not file a review (pre-#564 404).
- Next tick: `reconciler: 1 spawned` — a fresh reviewer spawned as
  `ercs-second-brain-reviewer`, read the diff, and filed a real GitHub review:
  **APPROVED** (review id 5184832119). Session archived after approval per
  the desired-state table.
- Orchestrator pane received the steering line ("PR #3 for issue #1 is
  approved and green — alignment check"), ran the alignment check, merged:
  `gh pr view 3` → `mergedAt 2026-09-12T02:17:10Z`; issue #1 **closed**.
- The orchestrator then filed follow-up issue #4 (from PR #3's
  `## Follow-ups`, made blocking by `docs/REVIEW.md`) and assigned #2 and #4 —
  work released purely by assignment.

### #2 CLI example and #4 negative exponents — parallel workers, ciRed, alignment bounce (02:17–02:23)

- 02:17:38: two workers spawned in one tick (`a4731df0` for #2, `9c5b0fbc`
  for #4); both prompts were submitted and acted on (pane transcripts show
  the spawn line, then implementation summaries; PRs #5 and #6 opened on
  `pideck/issue-2` / `pideck/issue-4`).
- **ciRed delivery**: at 02:19 a sentinel commit that fails CI was pushed to
  `pideck/issue-2` from outside (simulating a bad push). CI went red;
  the reconciler delivered `ciRed` to the worker as a steering message. The
  worker's pane: *"the red run reached me as this steering message … removed
  the sentinel test … pushed 999ed28"*. CI green again → PR #5 merged at
  02:21:20 → issue #2 closed.
- **Failed alignment check**: PR #6 implemented negative exponents as
  reciprocals; the issue's recorded decision was throw `TypeError`/
  `RangeError`. The reviewer approved (it judged the issue's scope), but the
  orchestrator's alignment check **failed** at 02:20:12 and left a top-level
  PR comment; the comment was delivered to the worker, which pushed the throw
  design in 24c9e3d and replied on the PR at 02:21:41. The orchestrator
  re-checked at 02:22:23 ("already conformed in 24c9e3d"), merged PR #6, and
  issue #4 closed (02:22:12 per the issue timeline).

### #7 + blocked dependent #8 — dependency gating (02:28–02:34)

- Issues #7 and #8 created; #8 linked **blocked by #7** via GitHub issue
  dependencies; both assigned.
- Tick after assignment: worker for #7 spawned (PR #9); **#8 got no worker**
  while its blocker was open — the reconciler re-evaluates, nothing stored.
- Two-round review on PR #9 (`docs/REVIEW.md` convention: first round always
  requests changes): round 1 CHANGES_REQUESTED → worker pushed d7052de →
  **same reviewer** re-reviewed → APPROVED → orchestrator merged PR #9 at
  02:29:49 → issue #7 closed.
- **Blocked dependent spawns**: the next tick after #7 closed spawned worker
  `fc5f7024` for #8, which opened PR #10, absorbed one round of
  CHANGES_REQUESTED → fix → re-review APPROVED, merged; issue #8 closed.

### #11 — the BLOCKED: path (02:31–02:34, 02:47–02:55)

- Issue #11 deliberately pointed at a private repo the accounts cannot read
  ("do not invent the endpoint"). The worker investigated, commented on the
  issue **`BLOCKED: Cannot determine the license-server endpoint…`**, and went
  idle.
- The reconciler steered the orchestrator ("A worker is blocked on issue
  #11"); the orchestrator's board note: *"#11 — CLI license gate, blocked on
  you: eng-internal/license-spec doesn't exist … Awaiting your call."* It
  also filed unassigned follow-up issue #12 (correctly no worker — unassigned).
- A decision comment was posted on issue #11 as the user (drop the gate;
  implement a local `--license` key-format check). The comment was delivered
  to the idle worker, which woke, implemented the new scope, and opened
  PR #13. Issue #11 closed when PR #13 merged at 02:55:34.

### The #13 conflict round — bug found, fix verified live (02:47–02:55)

- After PR #10 merged (README changed), PR #13 (also touching README) became
  `mergeable=CONFLICTING`, `mergeStateStatus=DIRTY`: **no checks run, no
  reviewer**, and nothing in the reconciler told the worker — it sat in the
  misleading `awaiting review` state. Bug → PR #566.
- After rebuilding on #566 and restarting: worker state flipped to
  **"conflicts with main on PR #13"**, `prConflict` was delivered (watermark
  `lastNotifiedConflictSha=c88ffb0`), the worker rebased onto main, pushed
  6778188 → `MERGEABLE`, CI green; the reviewer round-1 CHANGES_REQUESTED →
  worker addressed (cbad7f9) → same reviewer re-reviewed APPROVED → merged
  02:55:34 → issue #11 closed.

## Restarts mid-loop

Two restarts while loops were in flight (02:27 with #558+#564 in the build;
02:39 and 02:47 on later mains). Every restart:

- session inventory unchanged (`/api/sessions` count identical, tmux sessions
  reconnected, **no duplicate sessions spawned**);
- the loop resumed from GitHub facts on the first poll;
- exactly one duplicate delivery was possible by design (in-memory
  once-per-head maps reset): after the 02:27 restart the orchestrator could
  receive the approvedGreen notice for PR #9 once more — within the §4 bound
  "losing a watermark costs at most one duplicate prompt". No worse
  duplication was observed on any restart.

## Sidebar states observed (the eight-state table)

Seen via `/api/sessions` (`state` + `status` lines) throughout the run:

| state | observed as |
|---|---|
| working | "working on #11", "working on #7" |
| ci | "CI running for PR #5" |
| fixing | "fixing CI on PR #10", "conflicts with main on PR #13" (after #566) |
| in_review | "awaiting review on PR #9/#13" |
| addressing | "addressing review on PR #10/#13" |
| ready | "approved and green, PR #9/#13" |
| done | "archived …" after each merge |
| blocked | not displayed in this run: both triggers (open blocked-by link on a *live worker's* issue, fix attempts exhausted) never co-occurred with a live worker — #8's worker only spawned after its blocker closed |

## Bugs found → PRs

| Bug | PR | Regression test |
|---|---|---|
| `CONFLICTING` PR: worker never told, state misleading | [#566](https://github.com/ercs-second-brain/PiDeck/pull/566) | `desired.test.ts` (once-per-head delivery), `state.test.ts` (fixing/conflicts state) |
| Worker answered a review with a top-level PR comment; same-login loop re-delivered it to itself | [#568](https://github.com/ercs-second-brain/PiDeck/pull/568) | prompt/delivery-text change; comment in `desired.ts` |
| (Earlier run, before this verification) review account without repo access silently killed the review leg | #559 → [#564](https://github.com/ercs-second-brain/PiDeck/pull/564) | ensureReviewAccess on registration + every tick |

## Observations

- **A worker's pi exited on its own** (worker `9c5b0fbc`, issue #4, 02:22:33).
  The pane log (`/api/sessions/:id/log`) ends with the finished turn's summary
  ("Re-requested review … PR #6 remains approved, mergeable, and CI green —
  ready for the next alignment pass") and the status bar still rendered —
  **no `/exit` typed, no crash traceback, no error banner**; the process was
  simply gone after the turn ended (flash-model behavior under observation:
  `openrouter/z-ai/glm-5.3-flash`). The daemon reacted correctly: pane death →
  archive; the issue was already closed by then so no replacement was needed.
  Worth tracking: an agent runtime that can exit between turns without a
  platform-visible signal.
- **Probe of the pi-exit hypothesis (2026-09-12, after #573's wrapper
  landed)**: pi 0.85.1 run as `pi --session-dir <fresh dir>` in a detached
  tmux 3.4 pane (`remain-on-exit on`), no client attached, flash model
  (`z-ai/glm-5.3-flash`). One trivial prompt sent via `tmux send-keys`; the
  turn completed ("ok" + status bar redrawn) and pi **stayed alive** —
  `#{pane_dead}` stayed 0 and `#{pane_current_command}` stayed `pi` for
  3.5+ minutes after the turn ended, when the probe was torn down. So a
  completed detached turn alone does not make pi 0.85.1 exit; the live run's
  exit (above) must have had another cause (runtime/model-specific, or a
  transient failure that still surfaced as a clean exit). The pane-exit
  wrapper now guarantees that whichever way a pi dies, the pane keeps the
  scrollback plus a `[pideck] pi exited <code>` line for the archive.
- The **reviewer exercises judgment**: it approved PR #6's reciprocal design
  (judging the issue's scope) even though `docs/REVIEW.md` had just made
  silently-wrong numeric behaviour blocking — the orchestrator's alignment
  check caught the divergence instead. The two channels complemented each
  other exactly as §3 intends.
- **Unassigned backlog does not spawn**: issue #12 sat unassigned the whole
  run with no worker, as the desired-state table requires.
- Flash-model workers are fast (spawn → PR in under 40 s) but needed the
  orchestrator's alignment check once (reciprocal-vs-throw) — the loop's
  redundancy did its job.

## Command appendix (representative)

    curl -s localhost:8321/api/sessions | jq          # state inventory
    curl -s localhost:8321/api/projects/:id/settings  # settings readback
    curl -s -X POST localhost:8321/api/sessions/:id/terminate
    curl -s localhost:8321/api/sessions/:id/log       # pane transcript
    tmux capture-pane -t <session> -p                 # live pane read
    tail -f /tmp/pideck-live/daemon.log               # reconciler tallies
    gh pr view N --repo ercs-second-brain/pideck-live --json state,reviews,...
