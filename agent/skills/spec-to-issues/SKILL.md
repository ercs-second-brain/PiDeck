---
name: spec-to-issues
description: "Converts a concept brief + PRD pair into phased GitHub issues with native blocked-by relations, optimized for parallel worker execution — wide dependency graphs, disjoint file ownership, and minimal rebase/conflict risk. Use after the prd skill, when the human wants a spec turned into an actionable, worker-ready issue breakdown."
---

# Spec → GitHub Issues

Turn a concept brief + PRD into a phased issue breakdown where workers can proceed in parallel and rarely collide. The skill's core discipline: **plan the whole graph before creating anything**, and treat file-level ownership as a first-class constraint, not an afterthought.

You are the curator: you plan, file, verify, and report to the human — you never implement. Execution is workers' work: once the graph exists and the human is satisfied, work is released by **assigning issues on GitHub** — an assigned issue with no unresolved blockers gets a worker.

## Inputs

Find `<slug>-concept.md` and `<slug>-prd.md` in the current directory (or ask for paths). Rules:

- No PRD → stop, point to the `prd` skill. A feature list without acceptance criteria can't become issues.
- Cross-check the concept brief against the PRD: anything in the brief's "Mentioned" that's missing from the PRD gets raised as a question, not silently dropped. Anything in "Signals" informs sequencing/priority notes.
- Ask at most 2 questions before planning: which repo (if `gh repo view` is ambiguous), and — if the codebase already exists — its directory conventions. On greenfield, you propose the structure.

## 1. Plan the graph on paper first

Draft the full breakdown in the conversation before creating a single issue. Structure it as phases:

- **Phase 0 — Foundations**: shared contracts only. Types/schemas, API interfaces, data model, CI/scaffolding — the files many later issues would otherwise fight over. Keep it small and fast; every downstream worker waits on it, so never stuff features in here.
- **Phase 1 — Parallel core**: P0 features, split into tracks that touch **disjoint files/dirs**. This is where parallelism pays; maximize the number of independent issues here.
- **Phase 2 — Integration**: wiring the tracks together, end-to-end flows, remaining P0s that span modules.
- **Phase 3 — P1s and hardening**: parallel again where possible. P2s become one "backlog" issue or are omitted — don't spam the tracker.

Then apply the parallelism checks:

1. **Pairwise file check**: for every two issues in the same phase, ask "do they touch a common file?" If yes → merge them, sequence them, or make one the file's owner and the other depend on it. Same-phase conflicts are the #1 rebase generator.
2. **Wide, not deep**: count concurrent width per phase and total chain depth. Prefer 4 independent issues over a 4-long chain. If a chain is deep, ask whether the intermediate step is really a separate deliverable or just a file the next step would create anyway.
3. **Contracts before consumers**: any issue whose output others consume has its interface defined in Phase 0. A parallel worker building against an undocumented interface produces rework, which is a conflict by another name.
4. **Additive over shared**: prefer issues that create new files over issues that edit shared ones. When a shared file must change (router, DI registration, config), one issue owns it per phase and says so.
5. **Map P0/P1 to phases**: every P0 must land by Phase 2. A P0 buried in Phase 3 means the phase plan is wrong.

Present the plan as a table — phase, issues, depends-on edges, expected parallel width — and **get the human's confirmation before creating anything**.

## 2. Issue format

Every issue body:

```markdown
## Summary
<1–2 sentences: what and why, traced to a PRD feature.>

## Acceptance criteria
- [ ] <observable criterion, lifted from the PRD's "done when" lines>

## Touches
- `src/payments/` — owns this area
- `package.json` — the only Phase 1 issue allowed to edit it

## Depends on
- #12 <short title>

## Out of scope
- <nearby work deliberately excluded, so workers don't drift into collisions>
```

- **Touches is mandatory.** It's what makes conflict-free worker waves verifiable. "Only issue in phase N allowed to edit X" is the strongest form.
- **Acceptance criteria are the PRD's, verbatim where possible.** Don't weaken "done when" into "implemented".
- **Out of scope prevents both scope creep and merge conflicts** — the neighboring feature is named so nobody "helpfully" includes it.

## 3. Blocking relations

Blocking is expressed as **native GitHub "blocked by" relations**, never as prose that a reader must interpret:

- When creating an issue whose work depends on another issue, attach the dependency so GitHub shows "blocked by #12" on the issue page. The "Depends on" section in the body mirrors it in text (`- #12 <short title>`) for readability.

```bash
# blocker's numeric node id (not the issue number)
BLOCKER_ID=$(gh api repos/OWNER/REPO/issues/12 -q .id)
# mark #34 as blocked by #12
gh api -X POST repos/OWNER/REPO/issues/34/dependencies/blocked_by -F issue_id=$BLOCKER_ID
# verify
gh api repos/OWNER/REPO/issues/34/dependencies/blocked_by -q '.[] | "#\(.number) \(.state)"'
```

`issue_id` is the issue's integer node id, passed with `-F` (a string id 422s).
- Create in dependency (topological) order so the blocker's issue number exists when you attach the relation. After all issues exist, edit Phase 0–2 issues to add the inverse "blocks" relations so both directions are navigable.
- **Only declare a real dependency.** "Would be nice after" is not a blocker — an over-constrained graph serializes work that could be parallel. An assigned issue with no open blockers is immediately worker-eligible; honest relations keep that first wave accurate.

## 4. Create with `gh`

```bash
gh repo view                                         # confirm target repo
gh issue list --state open --search "<keywords>"     # dedupe against existing issues first
gh label create phase-0 --color 1D76DB --force       # once per phase label
gh issue create -R OWNER/REPO --title "..." --body-file - --label phase-1
```

- Phases get labels (`phase-0`…`phase-3`); milestones only if the repo already uses them.
- Batch-verify after creation: `gh issue list --label phase-1 --json number,title` etc.

## 5. Verify and report

Before declaring done, check the created graph:

- **No cycles, no dangling references** — every `#n` in a Depends on section or blocked-by relation resolves to an open issue.
- **PRD coverage** — every P0 feature maps to ≥1 issue; P1s accounted for; P2s parked or consciously dropped.
- **Parallelism sanity** — report width per phase ("Phase 1: 5 issues runnable concurrently") and flag any chain deeper than 3.

Close with a summary table: issue #, title, phase, depends on, and the first wave — issues that could be assigned **right now** (no unresolved blockers). To start execution, assign those issues on GitHub; each assignment releases the work, and merges close issues and unblock the next wave. If the human wants the full batch driven to done, that orchestration is the orchestrator's job — offer to hand the graph over or point them to running it with the orchestrator; the `bash-triage` skill's triage mode covers the ad-hoc variant of the same graph discipline.

## Anti-patterns

- Creating issues while planning. The graph is drafted, checked, and confirmed first.
- One issue per PRD feature, blindly. Features sharing files become one issue or get sequenced — feature lists don't know about merge conflicts.
- Deep chains because "step B needs step A's output" — usually a contract problem. Define the contract in Phase 0 and unblock B.
- A fat Phase 0. Foundations exist to unblock parallelism; a two-week Phase 0 is the plan failing.
- Issues without "Touches". A worker who doesn't know what they own will drift into someone else's files.
- Skipping the existing-issues check and duplicating a tracker that already has half this work.
- Prose-only dependencies. If a blocker isn't a GitHub blocked-by relation, nothing honors it.
