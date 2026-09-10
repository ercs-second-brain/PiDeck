/**
 * Shared text helper for the pane-delivered worker prompts (KISS audit F11).
 *
 * Worker prompts are typed into an interactive pane followed by Enter
 * (`agent/prompts/worker.md` conventions) — embedded newlines would submit
 * early, so every interpolated field is collapsed to a single line first.
 */

/** Collapses whitespace so a prompt is always a single pane-safe line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
