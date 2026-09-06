---
name: ci-status
description: "Look up CI status for a project's pull requests via the agentskiss daemon (agentskiss pulls), with a gh CLI fallback for per-check detail. Use when checking whether a PR is green, red, or pending."
trigger: "Checking CI status or whether a PR is green/red."
---

# CI Status Lookup

The daemon polls GitHub and exposes combined CI status per PR, matching the shared contract (`packages/shared/src/domain.ts` → `ciStatusSchema`): `pending`, `running`, `success`, `failure`, or `unknown`.

## Primary: daemon

```bash
agentskiss pulls --project {{PROJECT_ID}} --json
```

Each entry is a `PullRequest` with `number`, `title`, `state`, `ciStatus`, `reviewState`, `headBranch`, `baseBranch`, `url`. Filter client-side to the PR(s) you care about; a PR `open` with `ciStatus: "failure"` needs a fix pushed by the worker that owns it.

To see just one PR's diff while diagnosing:

```bash
agentskiss diff --project {{PROJECT_ID}} <pr-number>
```

## Fallback: gh CLI (per-check detail)

The daemon gives combined status only. When you need individual check names and failing logs:

```bash
gh pr checks <pr-number> -R OWNER/REPO
gh run view <run-id> -R OWNER/REPO --log-failed
```

Determine `OWNER/REPO` from `agentskiss project get {{PROJECT_ID}} --json` → `repoUrl`.

## Acting on failures

- Workers: if your PR is red, fix and push — that is the standing CI-fix loop (`awaiting_ci` → `fixing_ci` in worker status).
- Orchestrators: do not fix CI yourself; route the failing output to the responsible worker with `agentskiss send --session <session-id> --message "..."`.
