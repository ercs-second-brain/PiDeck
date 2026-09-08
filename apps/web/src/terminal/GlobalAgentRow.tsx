/**
 * The sidebar's workspace-level agent row (the agent hierarchy's top layer:
 * workspace agent → project orchestrators → workers → review agents),
 * extracted from picker-rows to keep that module within its line budget.
 * Pure rendering — see picker-rows.tsx for the sibling view pieces.
 *
 * Issue #259: the row is labeled "Workspace" (display only — the daemon's
 * reserved `global` pseudo-project id and API are unchanged), the NAME
 * opens the all-projects (workspace) board, and the whole row is DISABLED
 * until at least one project exists — with nothing to orchestrate there is
 * no workspace work to open.
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
  /** The workspace agent's session, when one exists (absent → first click starts it). */
  session: Session | null;
  /** The workspace agent terminal is the one attached in the main pane. */
  selected: boolean;
  /** The all-projects (workspace) board is open in the main pane. */
  boardSelected: boolean;
  /** No projects registered yet (#259): the row is disabled. */
  disabled: boolean;
  /** The start request is in flight (pending state). */
  starting: boolean;
  /** Opens the all-projects (workspace) board — the row's NAME click. */
  onSelectBoard: () => void;
  onStart: () => void;
}) {
  const chatTitle = props.session ? "Attach the workspace agent terminal" : "Start the workspace agent";
  const disabled = props.disabled || props.starting;
  return (
    <div className="picker-project-row picker-global-row">
      <button
        type="button"
        className={`picker-project-name picker-global-name${props.boardSelected ? " selected" : ""}`}
        title="Open the workspace board"
        disabled={disabled}
        onClick={props.onSelectBoard}
      >
        Workspace
      </button>
      <button
        type="button"
        className={`picker-project-chat${props.selected ? " selected" : ""}${props.starting ? " pending" : ""}`}
        title={chatTitle}
        disabled={disabled}
        onClick={props.onStart}
      >
        💬
      </button>
    </div>
  );
}
