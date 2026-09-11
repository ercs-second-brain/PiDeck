# @pideck/shared

Zod contracts shared by the daemon and web app. Nothing but contracts lives here.

## Contracts

- `PersonaSchema` / `Persona` — the four hardcoded personas: `global`, `orchestrator`, `worker`, `reviewer`.
- `WorkerStateSchema` / `WorkerState` — the eight daemon-derived worker states (`working`, `ci`, `fixing`, `in_review`, `addressing`, `ready`, `blocked`, `done`).
- `SessionSchema` / `Session` — one tmux-backed session in the registry: identity, persona, nullable `projectId` (null for the global agent), issue/PR numbers, model, and the GitHub delivery watermarks (`lastPromptedHeadSha`, `lastDeliveredIssueCommentId`, `lastDeliveredPrCommentId`, `lastDeliveredReviewId`, `fixAttempts`, `lastActivityAt`).
- `SessionViewSchema` / `SessionView` — what the sidebar renders: the session plus its derived `WorkerState` (null for sessions that have none), a short status line, and `parentSessionId` for reviewers nested under their worker.
- `ProjectSchema` / `Project` — a tracked repository: `id`, `name`, `repoUrl`, `owner`, `repo`, `defaultBranch`, `path`.
- `ProjectCreateSchema` — the two onboarding modes as a discriminated union: `{ mode: "clone", repoUrl, name? }` or `{ mode: "create", name, private }`.
- `ProjectSettingsSchema` / `ProjectSettings` — the five per-project knobs with defaults: `workerConcurrency` 3, `maxFixAttempts` 5, `contextLimitPercent` 80, `stallMinutes` 20, `autoMerge` false.
- `GlobalSettingsSchema` / `GlobalSettings` — what the daemon persists: `reviewAccount` (`username`, `token`) nullable until onboarding completes, and `modelByPersona` (one model or null per persona).
- `GlobalSettingsReadSchema` / `GlobalSettingsRead` — GET responses only: `reviewAccount` is `{ username, tokenSet } | null`; the token itself never leaves the daemon.
- `GlobalSettingsPutSchema` / `GlobalSettingsPut` — PUT requests only: `reviewAccount` omitted = keep existing, provided with `token` = replace, provided without `token` = re-username only, `null` = clear.
- `restEndpoints` — the REST map: path, method, and request/response schemas for status (with `piReady`/`ghReady`), project CRUD and settings, session list (global + per project), session send/terminate, archived log read, global settings (read/write split), per-persona prompt get/put/reset, onboarding probes (`/onboarding/pi` returns providers, models, and `defaultModel`; `/onboarding/gh/primary` and `/onboarding/gh/review` return the simple probe), and update check/apply.
- `WsClientMessageSchema` / `WsServerMessageSchema` — the WebSocket protocol: `sessions.changed` (daemon-wide `SessionView[]`, one event for every project plus the global agent) and the terminal stream (`terminal.attach`, bidirectional `terminal.data`, `terminal.resize`, `terminal.detach`).
