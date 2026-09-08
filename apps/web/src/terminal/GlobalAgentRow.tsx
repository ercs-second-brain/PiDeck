/**
 * The sidebar's workspace-level global agent row (the agent hierarchy's top
 * layer: global agent → project orchestrators → workers → review agents),
 * extracted from picker-rows to keep that module within its line budget.
 * Pure rendering — see picker-rows.tsx for the sibling view pieces.
 */

import type { Session } from "@pideck/shared";

/**
 * The workspace-level global agent row (the hierarchy's top layer: global
 * agent → project orchestrators → workers → review agents), rendered above
 * every project row. The whole row is the chat affordance: clicking it
 * attaches (or idempotently starts) the global agent's terminal. There is
 * no board/settings/menu — the global agent belongs to no single project.
 * Pure rendering.
 */
export function GlobalAgentRow(props: {
  /** The global agent's session, when one exists (absent → first click starts it). */
  session: Session | null;
  /** The global agent terminal is the one attached in the main pane. */
  selected: boolean;
  /** The start request is in flight (pending state). */
  starting: boolean;
  onStart: () => void;
}) {
  const title = props.session ? "Attach the global agent terminal" : "Start the global agent";
  return (
    <div className="picker-project-row picker-global-row">
      <button
        type="button"
        className={`picker-project-name picker-global-name${props.selected ? " selected" : ""}`}
        title={title}
        disabled={props.starting}
        onClick={props.onStart}
      >
        Global agent
      </button>
      <button
        type="button"
        className={`picker-project-chat${props.selected ? " selected" : ""}${props.starting ? " pending" : ""}`}
        title={title}
        disabled={props.starting}
        onClick={props.onStart}
      >
        💬
      </button>
    </div>
  );
}
