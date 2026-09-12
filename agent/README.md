# Skills

The installer symlinks `agent/skills/*` into `~/.pi/agent/skills/`; pi loads them on demand.

# agent/prompts

Shipped prompts for the four personas. Each is the persona's entire behaviour within the
loop — see `docs/SPEC.md` §2 (loop, channels) and §3 (personas, prompt style). Editable and
resettable to default in the web UI.

## Placeholders

The daemon substitutes these when rendering a prompt. The canonical token list is
`Placeholders` in `apps/daemon/src/prompts/render.ts`; a test
(`apps/daemon/src/prompts/render.test.ts`) verifies that this table matches it token
for token:

| Token | Value |
|---|---|
| `{{PROJECT_ID}}` | Project id (slug) |
| `{{PROJECT_NAME}}` | Project display name |
| `{{REPO}}` | `owner/repo` on GitHub |
| `{{DEFAULT_BRANCH}}` | Project's default branch |
| `{{PROJECT_PATH}}` | Local working-copy path |
| `{{ISSUE_NUMBER}}` | The worker's assigned issue number |
| `{{PR_NUMBER}}` | The reviewer's PR number |
| `{{SESSION_ID}}` | This session's id |
| `{{AUTO_MERGE}}` | `true` or `false` — the project's merge mode |
| `{{ORCHESTRATOR_SESSION_ID}}` | The project orchestrator's session id |
