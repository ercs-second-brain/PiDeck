---
name: bash-triage
description: "Capture findings from a bug bash or feature ramble into a verbatim running list, then triage them into typed, deduped, ranked GitHub issues with blocked-by relations where needed. Use when the human reports a pile of bugs, oddities, and ideas from a session and wants them turned into issues. Running the batch is the orchestrator's job, not this skill's."
---

# Bash Triage

Turn a session's stream of findings — a bug bash, a feature bash, or a mix — into a clean, confirmed list, then triage it into GitHub issues. Two distinct modes with a hard boundary: **collect** (fidelity — record what the human said, nothing more) and **triage** (judgment — type it, dedupe, cluster, rank, file). Never mix them; don't reword, type, or prioritize while still collecting, and don't collect new findings after triage has started. New discoveries made during later execution re-enter as new B# items, not chat noise.

You are the curator. You never implement: no code changes, commits, or PRs from your session. Work is released by **assigning issues on GitHub**; driving the resulting batch — advancing waves as merges land, watching CI and reviews, refilling freed capacity — is the orchestrator's job, described in its own prompt, not here. Your part ends at a clean, confirmed issue graph.

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
6. **Sequence** — most fixes are independent; when two genuinely depend on each other, declare it with a native GitHub blocked-by relation (see step 3); when they merely share an area, note it in the plan so assign-on-release waves stay conflict-free, following the `spec-to-issues` discipline of disjoint `Touches`.

Present the plan as a table — issue, source IDs (B#), type, rank, clusters/depends-on/parked — and **get the human's confirmation before creating anything**.

### 2. Issue format

Every issue body: `## Summary` (traced to B# reports), `## Reported behavior` (preserve specifics), `## Expected behavior` (mark inferred if the human didn't state it), `## Repro` (bugs only), `## Touches` (expected files/dirs, when determinable — this is what makes conflict-free worker waves verifiable), `## Notes` (cluster members, related issues, parking provenance), `## Out of scope` (nearby work deliberately excluded).

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
- **Create in dependency order** so the blocker's issue number exists when you attach the relation. Express real dependencies as **native GitHub blocked-by relations** — an assigned issue with no open blockers is immediately worker-eligible, so only declare a real dependency:

```bash
# blocker's numeric node id (not the issue number)
BLOCKER_ID=$(gh api repos/OWNER/REPO/issues/12 -q .id)
# mark #34 as blocked by #12
gh api -X POST repos/OWNER/REPO/issues/34/dependencies/blocked_by -F issue_id=$BLOCKER_ID
# verify
gh api repos/OWNER/REPO/issues/34/dependencies/blocked_by -q '.[] | "#\(.number) \(.state)"'
```

`issue_id` is the issue's integer node id, passed with `-F` (a string id 422s). Mirror the relation as a `- #12 <short title>` line in the body's Notes.
- Batch-verify after creation: `gh issue list --label bug --json number,title --limit 50`.

### 4. Verify and report

- **Coverage** — every B# maps to an issue, a merge, a park, or an explicit human-approved drop. Nothing vanishes silently.
- **No dangling references; no duplicate coverage; exactly one type + one rank label per issue.**

Close with a summary table: issue #, title, type, rank, source B# IDs, and counts filed vs merged vs parked vs dropped. Then stop: to release the work, assign the filed issues on GitHub — or leave that to the orchestrator, which runs the batch (waves of assigned issues, progress reports, refills as merges land). A natural next step for big feature parks: run them through the `concept-brief` → `prd` → `spec-to-issues` pipeline.

## Anti-patterns

- Triaging while collecting. Typing, ranking, and diagnosis wait until the human calls the list done.
- Renumbering B# IDs. Earlier references must stay valid.
- Silently assuming expected behavior. Mark it inferred instead.
- Filing duplicates of known open issues. Search before creating.
- One issue per symptom in a cluster. Three symptoms, one root cause, one issue.
- Filing a weak feature issue when the `concept-brief` → `prd` → `spec-to-issues` pipeline would do it properly.
- Creating issues before the plan is confirmed.
- Prose-only dependencies. If a blocker isn't a GitHub blocked-by relation, nothing honors it.
- Running the batch yourself. Triage files the graph and stops; assignment and wave management belong to the orchestrator.
- Implementing anything yourself. Curators file, verify, and report.
