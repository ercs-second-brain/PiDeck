---
name: prd
description: "Guides creation of a short, human-skimmable PRD from a project idea. Interviews the human with clarifying questions, plays devil's advocate to challenge assumptions, grounds expectations in reality, then produces a one-page requirements document. Use after the concept-brief skill, when the human wants a spec or requirements document for an idea."
trigger: "Turning an idea or concept brief into a PRD."
---

# PRD Builder

Turn a rough idea into a one-page PRD that a busy human can skim in 2 minutes. The work happens in conversation: interview, challenge, then write. You are the curator having this conversation with the human — implementation itself is later delegated to workers (typically via the `spec-to-issues` skill filing the graph, then `pideck spawn` running it).

## Process

### 1. Restate the idea

Before asking anything, restate the idea in one or two sentences of your own words. This confirms you understood it and gives the human something to correct. Then move to questions. If a `<slug>-concept.md` brief exists (from the `concept-brief` skill), use it as the input: its "Mentioned" list is the raw material and its "Not clarified" list is where the interview starts.

### 2. Interview — ask enough, but not too much

Ask questions in batches of 3–5. Wait for answers before the next batch. Stop when you can write the PRD without inventing anything. Prefer multiple-choice or "is it A or B?" questions — they are easier to answer than open ones.

Cover, roughly in this order:

1. **Problem & motivation** — What pain triggers this? Who feels it, how often? What do they do today instead?
2. **Users** — Who exactly uses it? (Roles, not demographics. "The person who runs payroll" beats "small businesses".)
3. **Core workflow** — Walk me through the one journey that must work on day one. What's the input, what's the output?
4. **Scope edges** — What's explicitly NOT in v1? What would make you say "this failed"?
5. **Constraints & realities** — Budget/deadline, who builds it, existing systems it must integrate with, data it needs, where it runs.

Interview heuristics:

- If the human says "it's simple" or "just like X but...", that's a signal to probe, not to accept.
- When they name a feature, ask what user goal it serves. Features serve goals; goals don't serve features.
- Don't drag out the interview. 2–3 batches is usually enough. Missing details become "Open questions" in the PRD, not more questions.

### 3. Devil's advocate — be direct

Before drafting, push back. Out loud, in the conversation, not buried in the doc:

- **Hidden complexity**: "X sounds like one feature but it's really three: ingestion, dedup, and review. Which do you need first?"
- **Assumed demand**: "You're assuming users will enter this data manually. What's your evidence they will? If they won't, the product has no fuel."
- **The smaller version**: "Could you ship the P0 list alone and be useful? If yes, that's v1."
- **The boring alternative**: "Could a spreadsheet, a script, or an off-the-shelf tool do 80% of this? What justifies building?"
- **Ongoing cost**: "Who maintains this, fields the support questions, and pays for the API/infra each month?"

Be concrete and grounded — compare against how real software projects actually go (auth is never one line, integrations eat a sprint, cold-start data problems sink products). Challenge the plan, stay on the human's side. If they defend a choice with a real reason, accept it and move on; don't relitigate.

### 4. Write the PRD

One page. Skimmable. Every feature is one line a non-engineer can read. Use this structure:

```markdown
# PRD: <Project name>

**One-liner:** <What it is and for whom, in one sentence.>

## Problem
<2–4 sentences. The pain, who has it, what they do today.>

## Users
- <Role>: <what they need to do>

## Goals
- <Outcome, not features>

## Non-goals
- <Explicitly out of scope, even if tempting>

## Features
### P0 — must ship
- <Feature>: <one-line behavior> — *done when* <observable acceptance criterion>

### P1 — should ship
- <Feature>: <one line>

### P2 — later
- <Feature>: <one line>

## Success metric
<One number or observable signal that says it worked.>

## Risks & open questions
- <Biggest risk / unresolved decision>
```

Rules for the draft:

- **One page max.** If it spills over, cut scope, not font size. P2 items are the first to compress into a single line.
- **Every P0 feature gets an acceptance criterion** — something a person could check without reading code.
- **Write behaviors, not implementations.** "Users receive a weekly email summary" not "a cron job calls the mailer service".
- **Non-goals are load-bearing.** A PRD without them is a wish list.
- Flag any feature that grew during the devil's-advocate round as a risk rather than quietly expanding P0.

### 5. Close the loop

Present the PRD and ask: "What's wrong or missing?" Apply corrections, then hand it over as `<slug>-prd.md` (e.g., `recipe-share-prd.md`) in the current directory, unless the human says otherwise.

## Anti-patterns

- Writing the PRD after one question. Interview first; the doc is the residue of the conversation.
- A 10-page spec. Nobody reads page 2, and page 2 is where stale requirements live.
- Echoing the human's feature list back as requirements. Your job is to extract the goal behind each feature and cut what doesn't serve it.
- Skipping the reality check to be agreeable. The human gets more value from "this will take 3x what you think, here's the cut" than from a polite yes.
