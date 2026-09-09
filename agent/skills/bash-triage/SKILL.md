---
name: bash-triage
description: "Capture findings from a bug bash or feature ramble into a verbatim running list, triage them into typed, deduped, ranked GitHub issues, then run the batch to done by spawning PiDeck workers in file-disjoint waves. Use when the human reports a pile of bugs, oddities, and ideas from a session and wants them turned into issues and fixed."
trigger: "Turning a session's findings into GitHub issues and running the worker batch."
---

# Bash Triage

Turn a session's stream of findings — a bug bash, a feature bash, or a mix — into a clean, confirmed list, then triage it into GitHub issues and run the batch to done. Two distinct modes with a hard boundary: **collect** (fidelity — record what the human said, nothing more) and **triage** (judgment — type it, dedupe, cluster, rank, file, then orchestrate workers). Never mix them; don't reword, type, or prioritize while still collecting, and don't collect new findings after triage has started. New discoveries made during execution re-enter as new B# items, not chat noise.

You are the curator. You never implement: no code changes, commits, or PRs from your session — workers execute (see the `spawn-worker` skill), and their PR-ready/blocked reports flow back through you to the human.

## Mode 1: Collect

### 1. Absorb the session

Let the human report. Fragments are fine — "the export button does nothing on mobile", "logged out randomly, maybe twice?", "it felt slow when I filtered", "we should add SSO". Bugs, oddities, UX gripes, performance smells, features, changes to existing behavior — all welcome.

**Question only when you must.** Ask at most 1–3 questions per exchange, and only when you genuinely cannot record the finding without guessing: an ambiguous pronoun or surface ("what's 'it' — the dashboard or the detail page?"), a symptom too vague to record as a line, or two statements that might be the same finding. Everything else, record as-is. Hedges like "maybe twice" and "felt slow" are recorded verbatim — during collection you are a stenographer, not a validator.

### 2. Maintain the running list

After each exchange, show the current list in the conversation. Items are typed `[bug]`, `[feature]`, or `[change]` (a modification to existing behavior that isn't broken):

```markdown
## Bash List — <N> items

**B1. [bug] <Short title>** — <what the human said, cleaned up>
- *Repro (as reported):* <steps or trigger, verbatim if given; "not captured" if not>
- *Expected vs actual:* <only what they stated; omit if unclear>

**B2. [feature] <Short title>** — <the idea as stated>
- *As described:* <what it should do, only what the human said>

## Open questions
- <Ambiguities worth one question at the next natural pause>
```

Rules for the list:

- **One finding per item.** Split compound reports.
- **Stable IDs.** Number items B1, B2, … and never renumber — later exchanges refer to them by ID ("merge B3 into B1").
- **Type is the human's call, lightly.** Apply the obvious type; if genuinely ambiguous, record your best guess and flag it in Open questions.
- **Preserve their emphasis and specifics.** "Happens every single time" stays stronger than "sometimes fails"; counts, error messages, URLs — verbatim.
- **Don't diagnose or design.** No guessed root causes, no severity, no fleshing out feature sketches. That happens in triage, where it can be challenged.
- **Rolling updates, not replays.** Show what's new/changed plus the full current list.

### 3. Iterate until satisfied

End each collection round with one question:

> "What else — anything new, anything to correct, merge, or drop? Or is the list done?"

The list is done **only when the human says so**. Never jump to triage on your own initiative.

## Mode 2: Triage

### 1. Plan the triage on paper first

Draft the full issue plan in the conversation before creating anything:

1. **Dedupe** — merge duplicate reports (B1 + B3 → one issue) citing both IDs; the earliest ID wins as the title's source.
2. **Cluster** — group findings that share a root cause or a surface. Don't over-merge: two findings in one file that need different fixes stay separate.
3. **Flag non-issues** — intended behavior, stale reports, can't-reproduce, think-aloud ideas: propose dropping, converting to a question, or filing as an investigation issue. The human decides.
4. **Rank** — bugs get severity labels (`severity-0` blocker … `severity-3` polish); features and changes get priority labels (`priority-0` must-have … `priority-2` nice-to-have). Base both on the human's own emphasis.
5. **Park what can't file well** — a feature idea that's really a new product direction shouldn't become a weak issue. Propose parking it with the B# verbatim, or routing it through the `concept-brief` → `prd` → `spec-to-issues` pipeline. The human decides.
6. **Sequence** — most fixes are independent; when two touch the same area, sequence them or merge. Issues that will be worker-executed in parallel follow the `spec-to-issues` discipline: disjoint `Touches`, no same-phase collisions.

Present the plan as a table — issue, source IDs (B#), type, rank, clusters/depends-on/parked — and **get the human's confirmation before creating anything**.

### 2. Issue format

Every issue body: `## Summary` (traced to B# reports), `## Reported behavior` (preserve specifics), `## Expected behavior` (mark inferred if the human didn't state it), `## Repro` (bugs only), `## Touches` (expected files/dirs, when determinable — this is what makes file-disjoint worker waves verifiable), `## Notes` (cluster members, related issues, parking provenance), `## Out of scope` (nearby work deliberately excluded).

- Type and rank go on as labels (`bug` / `feature` / `change` plus `severity-N` or `priority-N`), not buried in the body.
- Merged/clustered items list every source B# ID so the trail stays auditable.

### 3. Create with `gh`

```bash
gh repo view                                         # confirm target repo
gh issue list --state open --search "<keywords>"     # dedupe against existing issues first
gh label create bug --color D73A4A --force           # once per type/rank label
gh issue create -R OWNER/REPO --title "..." --body-file - --label bug --label severity-1
```

- **Search before creating** — a bash frequently rediscovers known bugs; comment on the existing issue instead of filing a duplicate.
- **Create in dependency order** so issue numbers exist when referenced. Express relations as task-list items (`- [ ] #12`) and, for blocking relations the daemon should honor, native "blocked by" links (see the `create-issue` skill): PiDeck does not spawn workers for issues with unresolved blockers.
- Batch-verify after creation: `gh issue list --label bug --json number,title --limit 50`.

### 4. Verify and report

- **Coverage** — every B# maps to an issue, a merge, a park, or an explicit human-approved drop. Nothing vanishes silently.
- **No dangling references; no duplicate coverage; exactly one type + one rank label per issue.**

Close with a summary table: issue #, title, type, rank, source B# IDs, and counts filed vs merged vs parked vs dropped.

### 5. Run the batch

You are now the curator-orchestrator for the batch. You coordinate; workers implement. Run the loop until every batch issue is done, without stopping to ask permission between waves — the human confirmed the plan in step 1. Report progress to the human after each wave.

1. **Assess** — `pideck kanban --project {{PROJECT_ID}} --json` and `pideck workers --project {{PROJECT_ID}} --json`: which batch issues are still open, unblocked, and unowned? What workers are active?
2. **Spawn in waves** — one worker per runnable issue: `pideck spawn --project {{PROJECT_ID}} --issue <number> --name "<label>"` (see the `spawn-worker` skill: check for an existing live worker first, keep `--name` ≤ 20 chars, respect `settings.workerConcurrency` from `pideck project get {{PROJECT_ID}} --json`). A wave = a batch of unblocked, file-disjoint issues, up to 3–5 concurrent workers. **Never co-spawn two workers whose issues share a `Touches` file** — sequence them instead. If two in-flight issues turn out to touch the same files, don't kill them; make one wait and note the collision.
3. **Collect status** — workers claim the issue, then report PR-ready (`pideck report-pr`, visible in `pideck pulls --project {{PROJECT_ID}} --json` with `ciStatus`/`reviewState`) or blocked. A worker that finds a new bug or oddity mid-fix reports it as a new B# finding — you record it, file it in the same format, and route it into the loop.
4. **Review & route** — on a PR-ready report, verify rather than trust: `pideck diff --project {{PROJECT_ID}} <pr>` against the issue's expected behavior and `Touches` (did the worker drift into files it doesn't own?), and check `ciStatus`. Green and on-scope → report ready-to-merge to the human (merge only if the project's rules authorize you). Failures and review comments go back to the owning worker via `pideck send --session <id>` (see `ci-status` and `review-comments`).
5. **Refill & repeat** — every merge closes an issue and frees capacity; immediately fill freed slots from the newly runnable set. If nothing is runnable, spawn the cheapest unblocking work rather than idling.

Done means: all batch issues closed (or consciously parked with a written reason), CI green, and a final report to the human — what shipped per type/rank, new B# findings discovered during work and where they landed, anything left parked.

Rules for the batch:

- **File ownership is law.** Two active workers must never touch the same files. When in doubt, sequence instead of co-spawning.
- **Verify, don't trust.** A worker's "ready" is a claim, not a fact — check the diff and CI before reporting it.
- **Keep the graph honest.** New discoveries become B# items and issues with relations, not chat asides.
- **Stay in scope.** Issues' Out of scope sections still hold; decline worker drift beyond them.
- **Escalate only real blockers** to the human — budget/direction/scope changes. Everything else is yours to route.

## Anti-patterns

- Triaging while collecting. Typing, ranking, and diagnosis wait until the human calls the list done.
- Renumbering B# IDs. Earlier references must stay valid.
- Silently assuming expected behavior. Mark it inferred instead.
- Filing duplicates of known open issues. Search before creating.
- One issue per symptom in a cluster. Three symptoms, one root cause, one issue.
- Filing a weak feature issue when the `concept-brief` → `prd` → `spec-to-issues` pipeline would do it properly.
- Creating issues before the plan is confirmed.
- Co-spawning workers onto overlapping files, or past the project's worker concurrency cap.
- Implementing anything yourself. Curators file, spawn, verify, and report.
