---
name: review-comments
description: "Retrieve review state and review comments for a project's pull requests: daemon state via agentskiss pulls, comment bodies via gh. Use when addressing or summarizing PR review feedback."
trigger: "Fetching or addressing PR review comments."
---

# Review-Comment Retrieval

Two layers, split exactly as the shared contract draws it (`packages/shared/src/domain.ts`): the daemon tracks the review *decision*, `gh` fetches the comment *bodies*.

## Step 1 — review state (daemon)

```bash
agentskiss pulls --project {{PROJECT_ID}} --json
```

Each `PullRequest` carries `reviewState`: `none`, `pending`, `approved`, or `changes_requested`. `changes_requested` means there are comments to address; `approved` with `ciStatus: "success"` means ready to report as done (do not merge unless explicitly asked).

## Step 2 — comment bodies (gh CLI)

```bash
# All review threads + inline comments, human-readable
gh pr view <pr-number> -R OWNER/REPO --comments

# Inline review comments as JSON (for systematic, thread-by-thread addressing)
gh api repos/OWNER/REPO/pulls/<pr-number>/comments --paginate

# Top-level review summaries (approve / request-changes bodies)
gh api repos/OWNER/REPO/pulls/<pr-number>/reviews
```

Determine `OWNER/REPO` from `agentskiss project get {{PROJECT_ID}} --json` → `repoUrl`.

## Step 3 — addressing (workers)

- Work through every unresolved thread; for each, fix the code, push, and mark the thread resolved when the platform supports it.
- If multiple PRs have pending reviews, order them by blockers, stack order, failing scope, and user priority.
- Report which threads were addressed and which remain.

## Orchestrators

Never address reviews yourself. Fetch the findings with this skill, then route them to the responsible worker via `agentskiss send --session <session-id> --message "<findings>"`.
