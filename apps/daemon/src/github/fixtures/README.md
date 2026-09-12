# Fixtures

## statusCheckRollup.ts

Captured live with `gh pr list --json statusCheckRollup` on 2026-09-12; each
entry is a PR's `statusCheckRollup` verbatim (unredacted — public check
metadata only), from:

| Source repo | PR | What it exercises |
|---|---|---|
| microsoft/vscode | #335951 | in-progress check run (`IN_PROGRESS`, `conclusion: ""`), completed success, failures |
| envoyproxy/envoy | #47350 | queued check run (`WAITING`, `conclusion: ""`) next to a success |
| envoyproxy/envoy | #47375 | every check succeeded |
| envoyproxy/envoy | #47346 | completed failure, pending status context (`PENDING`), skipped/neutral checks |