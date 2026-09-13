# Review guidance

House rules every review in this repo follows:

- An approving review carries exactly one non-blocking inline comment, and only
  while it is still needed: on `src/greeting.js`, ask the author to add a
  one-line comment above `greeting()` recording that the wording is the
  product's, not the test's literal. Once that comment exists on the head you
  are reviewing, approve plain — no further inline comments.
- Everything the note covers is non-blocking by definition. Request changes
  only for a correctness bug the diff actually ships.