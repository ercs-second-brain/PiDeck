# @pideck/shared

Zod contracts shared by the daemon and web app. Nothing but contracts lives here.

## Contracts

- `PersonaSchema` / `Persona` — the four hardcoded personas: `global`, `orchestrator`, `worker`, `reviewer`.
- `WorkerStateSchema` / `WorkerState` — the eight daemon-derived worker states (`working`, `ci`, `fixing`, `in_review`, `addressing`, `ready`, `blocked`, `done`).
- `SessionSchema` / `Session` — one tmux-backed session in the registry: identity, persona, project, issue/PR numbers, model, and the GitHub delivery watermarks (`lastPromptedHeadSha`, `lastDeliveredIssueCommentId`, `lastDeliveredPrCommentId`, `lastDeliveredReviewId`, `fixAttempts`, `lastActivityAt`).
- `SessionViewSchema` / `SessionView` — what the sidebar renders: the session plus its derived `WorkerState`, a short status line, and `parentSessionId` for reviewers nested under their worker.
- `ProjectSchema` / `Project` — a tracked repository: `id`, `name`, `repoUrl`, `owner`, `repo`, `defaultBranch`, `path`.
- `ProjectSettingsSchema` / `ProjectSettings` — the five per-project knobs with defaults: `workerConcurrency` 3, `maxFixAttempts` 5, `contextLimitPercent` 80, `stallMinutes` 20, `autoMerge` false.
- `GlobalSettingsSchema` / `GlobalSettings` — review account (`username`, `token`; mask the token with `maskToken` before returning it to a client) and `modelByPersona` (one model or null per persona).
- `restEndpoints` — the REST map: path, method, and request/response schemas for status, project CRUD and settings, session list/send/terminate/log, global settings, per-persona prompt get/put/reset, onboarding probes, and update check/apply.
- `WsClientMessageSchema` / `WsServerMessageSchema` — the WebSocket protocol: `sessions.changed` (full `SessionView[]` for a project) and the terminal stream (`terminal.attach`, bidirectional `terminal.data`, `terminal.resize`, `terminal.detach`).
