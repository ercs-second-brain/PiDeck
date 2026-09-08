---
name: report-pr
description: "Report an opened pull request to the pideck daemon from a worker session (pideck report-pr). Use right after creating a PR in a worker session so the PR lifecycle loop (CI, reviews, merge) tracks it."
trigger: "A worker session just opened a pull request."
---

# Report a PR to the Daemon

After you open a pull request in a worker session, tell the daemon which PR
is yours so the PR lifecycle loop (CI status, review comments, merge) tracks
it:

```bash
pideck report-pr <pr-number>
```

- No flags and no session id: the CLI resolves your worker session from the
  tmux pane you run it in. Run it **inside the worker session** (not from
  the host shell or another pane).
- Run it once per PR, immediately after `gh pr create` (or the platform
  equivalent). Re-running with a different number corrects the association.
- Precedence: an explicit report **wins** over the daemon's title/branch
  heuristic — the heuristic only fills workers that have no PR recorded,
  and a report overwrites a stale heuristic association.
- Workers whose PR title or head branch already references their issue
  (e.g. `Closes #46`) are still picked up by the heuristic if they skip
  this step, but reporting explicitly is the reliable path — a PR with no
  issue reference is invisible to the heuristic.
