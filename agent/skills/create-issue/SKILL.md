---
name: create-issue
description: "Create a GitHub issue in the current project's repository using the gh CLI, with native blocked-by relationship checks. Use when the user or orchestrator asks to create, file, or open an issue."
trigger: "Creating or filing a GitHub issue in a agentskiss project."
---

# Create a GitHub Issue

Creates an issue in the project's GitHub repository via the `gh` CLI. agentskiss does not proxy issue creation through the daemon — the daemon only *watches* issues (see `packages/shared/src/domain.ts`, `Issue`).

## Steps

1. Determine the target repository `OWNER/REPO`:
   - From project state: `agentskiss project get {{PROJECT_ID}} --json` → `repoUrl` (strip the `https://github.com/` prefix), or
   - From git: `git -C <project-path> remote get-url origin`.
2. Check whether the issue should block or be blocked by existing issues. If the user mentions blockers, note the issue numbers — GitHub native "blocked by" relationship links are what the daemon reads to decide auto-spawn (PRD blocking semantics), so prefer creating follow-up issues and adding native relationship links over prose like "blocked by #123" in the body.
3. Create the issue (the one canonical invocation):

   ```bash
   gh issue create -R OWNER/REPO --title "Title" --body "Body"
   ```

   Write a complete, self-contained body: summary, acceptance criteria, touches, and any dependency list. The body is the task source for the worker that eventually spawns from it.
4. Verify and capture the number/URL from the command output, or confirm with:

   ```bash
   gh issue view <number> -R OWNER/REPO --json number,url,title,state
   ```

## Rules

- Never create issues on repositories outside the current project without the user asking.
- Do not assign the issue to the auto-agent username yourself — assignment (or creation by the configured user) triggers auto-spawn; leave that to the user or orchestrator unless explicitly requested.
- Report the issue URL back to the requester.
