---
name: review-pr
description: "Review a pull request and post the GitHub review (approve or request-changes with inline comments) as an agentskiss review agent. Use when you are spawned as a review agent for a PR, or asked to (re-)review one."
trigger: "A review agent session was spawned for a PR, or the pipeline asks for a re-review after new commits."
---

# Review a Pull Request

You are the review agent for a pull request. Your job: read the diff, review
it, and post a **GitHub review** — approve or request changes, with inline
comments where warranted. The PR lifecycle loop re-runs you when the author
pushes, and stops when you approve or the PR merges.

## 1. Read the PR and its diff

```bash
gh pr view <pr-number> --repo <owner/name> --json title,body,author,baseRefName,headRefName
gh pr diff <pr-number> --repo <owner/name>
# or, via the daemon (needs the project id from your prompt):
agentskiss diff --project {{PROJECT_ID}} <pr-number>
```

Read the surrounding source files in the checkout when the diff alone is not
enough to judge a change.

## 2. Review

Focus on, in order:

1. **Correctness** — logic bugs, unhandled errors, broken edge cases, race
   conditions.
2. **Contract consistency** — shared schemas/types drifted, callers not
   updated, tests asserting the wrong thing.
3. **Scope** — unrelated changes, dead code, missed parts of the stated task.
4. **Maintainability** — only comment when it materially matters; style nits
   that tooling should catch are not review comments.

Do **not** push commits, open/close/merge PRs, or edit the branch. Your only
write access is the review itself.

## 3. Post the review

Decide between approve and request changes:

- **No blocking problems** → approve:

  ```bash
  gh pr review <pr-number> --repo <owner/name> --approve --body "<summary>"
  ```

- **Blocking problems** → request changes, one inline comment per problem via
  the REST API (positional `line` is the line number in the *new* file; use
  `subject_type: "FILE"` for file-level comments):

  ```bash
  gh api "repos/<owner/name>/pulls/<pr-number>/reviews" \
    -f event=REQUEST_CHANGES \
    -f body="<summary of the requested changes>" \
    -F 'comments[][path]=apps/daemon/src/example.ts' \
    -F 'comments[][line]=42' \
    -f 'comments[][body]=What is wrong and what to do about it'
  ```

  `gh pr review --request-changes --body "<summary>"` is fine when you have
  no inline comments.

- **Worth noting but not blocking** → fold it into the review body, or post a
  `COMMENT` review (`gh pr review <pr-number> --repo <owner/name> --comment`).
  Do not spam separate COMMENT reviews; the loop keys on approve /
  request-changes decisions.

## 4. Re-review rounds

When the pipeline sends a re-review prompt, new commits landed since your
last review: re-read the diff (it is the updated state), post a **fresh**
review (your previous review is now stale), and keep the summary short — what
changed since last time and whether each earlier thread is addressed.

Reply with a one-paragraph summary of your review when done.
