---
name: concept-brief
description: "Distills the human's raw idea or rant into a one-page concept brief — a 2–3 sentence description plus an exact bullet list of every feature, outcome, and fact they mentioned. Captures what was said without interpretation, so the human can verify and iterate before a PRD is written. Use as the first step for a new idea, before the prd skill."
---

# Concept Brief

Take a rant and turn it into a defined, verifiable one-pager. This is a **fidelity document**, not an analysis document: it records what the human actually said, cleaned up — nothing more. The PRD (built later, via the `prd` skill) is where interpretation and challenge happen.

## Process

### 1. Absorb the rant

Let the human talk. A brain-dump, voice-memo transcript, stream of consciousness, or "here's what I want, it's kind of like X but also..." — all fine. Don't interrupt with structure or critique.

**Question only when you must.** Ask at most 1–3 questions, and only for things you genuinely cannot bullet without guessing:

- An ambiguous pronoun or product name ("what's 'it' — the app or the dashboard?")
- A feature mention too vague to record as a line ("make it social" — social how?)
- Two contradictory statements you can't both record ("you said mobile-first and desktop-only — which?")

Everything else, record as-is. If the rant implies a question ("users will obviously want..."), record the implication as a bullet, don't debate it.

### 2. Write the brief

One page. Exactly this structure:

```markdown
# Concept Brief: <Working name>

**Description:**
<2–3 sentences: what it is, who it's for, what it does. Their idea, their emphasis — cleaned up, not reinterpreted.>

## Mentioned
- <Exact feature, outcome, or fact the human stated, one line each>

## Signals
- <One line each: hints about priority, audience, or constraints they dropped, even if not stated as requirements — e.g. "kept comparing it to Notion", "called the current way 'a nightmare'">

## Not clarified
- <Unresolved points or vague terms recorded as-is, with the exact wording — e.g. "'automation' — unspecified what gets automated">
```

Rules for the draft:

- **Mentioned is the heart of the doc.** Every bullet is something the human concretely stated. If a bullet isn't traceable to something they said, it belongs in Signals or Not clarified, not Mentioned.
- **Preserve their emphasis.** If they spent five sentences on reporting and one on login, the brief should visibly weigh reporting more.
- **Split rambled compound sentences into separate bullets.** "It should sync everything, and alerts obviously, and I guess an export" becomes three bullets.
- **Keep their words where they work.** Polish grammar, not meaning.
- **Never add a feature they didn't mention** — not auth, not "you'll probably also need". If the absence is glaring, it's a one-line note in Not clarified.
- **Keep their numbers and specifics exact.** "Under 2 seconds", "500 users", "twice a day" — record verbatim.

### 3. Verify and iterate

Present the brief, then ask one question:

> "Anything here you didn't say, or anything you said that's missing?"

Then apply corrections and save the file as `<slug>-concept.md` (e.g., `recipe-share-concept.md`) in the current directory, unless the human says otherwise.

### 4. Hand off

When the human confirms the brief is accurate, stop — the concept brief is done. Tell them:

> "This is ready to feed into a PRD. Run the `prd` skill (or just say 'turn this into a PRD') when you want requirements fleshed out."

Do not start the PRD interview unprompted; the human iterates on the brief first, possibly across multiple sessions.

## Anti-patterns

- Analyzing instead of recording. No prioritization, no P0/P1, no devil's advocate — that's the `prd` skill's job.
- Asking an interview's worth of questions. The rant is the input; questions are for ambiguity, not completeness.
- Inventing standard features. A brief with bullets the human never said has failed.
- Losing specifics. Vague-ifying "500 users" into "a user base" makes the doc unverifiable.
