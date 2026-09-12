# daemon/src/prompts

Everything the daemon needs to turn `agent/prompts/*.md` into the system prompt a pane boots
with, and everything it types into a pane. No HTTP, no tmux, no GitHub — callers wire those.

## Modules

- `render.ts` — the canonical placeholder list (`Placeholders`, exactly the table in
  `agent/README.md`), a scan for the placeholders a text uses, and `renderPrompt(text, vars)`:
  substitutes `{{TOKEN}}` tokens and throws on any token that is not in the list or has no
  value in `vars`. Callers build `vars` for the persona they are launching.
- `shipped.ts` — `loadShippedPrompt(persona)` reads `agent/prompts/<persona>.md`. The agent
  directory is found by walking up from this module until a directory containing `agent/prompts`
  appears (works from `src` and from `dist`); `PD_AGENT_DIR` overrides it and must point at the
  directory containing `prompts/`.
- `overrides.ts` — `PromptOverrides` persists user edits at `<stateDir>/prompts.json`
  (`{ "<persona>": "<text>" }`) with `get`, `set`, and `reset`. The effective prompt is always
  `override ?? shipped`.
- `briefing.ts` — `buildBriefing(data)` formats the orchestrator (re)launch briefing from plain
  data: open issues grouped assigned / blocked / unassigned, in-flight PRs with CI and review
  state, live sessions, and the pointer to the project's `docs/`.
- `delivery.ts` — one pure function per row of the SPEC §4 delivery table. Each returns a
  single-line string with no newlines, ready to type into a pane followed by Enter.

## The briefing is one line

The briefing is rendered into the orchestrator's system prompt at spawn (appended to the persona
prompt, delivered through the same `--append-system-prompt` file as the persona itself) — it is
context, not a typed pane message. It stays a single line so it reads as one compact paragraph of
state, with groups separated by `;` and items by `,`. Empty groups are omitted.