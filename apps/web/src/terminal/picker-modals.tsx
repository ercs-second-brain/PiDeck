/**
 * The terminals sidebar's centered confirmation/prompt modals: the shared
 * shell, the terminate-worker confirm (issues #116/#268), the delete-project
 * confirm (issue #172), and the researcher-spawn question modal
 * (docs/agent-kinds.md, issue #297). Extracted from picker-rows to keep each
 * module under its complexity budget; Escape is handled by the
 * interaction-state hook — the backdrop click dismisses unless a request is
 * in flight. Pure rendering.
 */

import { useState, type ReactNode } from "react";
import { agentKindInfo, type AgentKind, type AgentKindSpec } from "@pideck/shared";

/**
 * Shared shell for the sidebar's small centered confirmation modals
 * (worker terminate #116, project delete #172, researcher spawn #297):
 * dimmed backdrop, title, body, Cancel/confirm actions. Pure rendering.
 */
function ConfirmModal(props: {
  ariaLabel: string;
  title: string;
  body: ReactNode;
  /** Labels the confirm button ("Delete" / "Delete <project>"). */
  confirmLabel: string;
  /** Label while the request is in flight ("Deleting…"). */
  pendingLabel: string;
  /** Failure message from a rejected confirm, shown inside the modal. */
  error?: string | null;
  /** The confirm request is in flight (controls disabling). */
  pending: boolean;
  /** Extra confirm-disable condition beyond `pending` (researcher: empty question). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="modal-overlay terminate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={props.ariaLabel}
      onClick={props.pending ? undefined : props.onCancel}
    >
      <div className="modal-card terminate-modal" onClick={(event) => event.stopPropagation()}>
        <h3 className="terminate-modal-title">{props.title}</h3>
        <div className="terminate-modal-body">{props.body}</div>
        {props.error && <p className="terminate-modal-error">{props.error}</p>}
        <div className="terminate-modal-actions">
          <button type="button" className="terminate-modal-cancel" disabled={props.pending} onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="terminate-modal-confirm"
            disabled={props.pending || props.confirmDisabled === true}
            title={props.confirmLabel}
            onClick={props.onConfirm}
          >
            {props.pending ? props.pendingLabel : props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The worker-delete confirmation modal (issue #116, #377 renames the
 * user-facing label from "Terminate" to "Delete"): small, centered, over a
 * dimmed backdrop — "Delete worker X?" with Cancel/Delete. Pure
 * rendering on top of {@link ConfirmModal}.
 */
export function TerminateWorkerModal(props: {
  /** tmux session name of the worker about to be deleted (archived). */
  sessionName: string;
  /** The delete request is in flight (Delete shows "Deleting…"). */
  pending: boolean;
  /** Failure from the daemon, shown inside the modal (issue #268). */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmModal
      ariaLabel="Delete worker"
      title="Delete worker?"
      body={
        <p>
          <code>{props.sessionName}</code> will be killed and archived — its pane and agent stop, its history stays
          inspectable.
        </p>
      }
      confirmLabel="Delete"
      pendingLabel="Deleting…"
      error={props.error}
      pending={props.pending}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}

/**
 * The delete-project confirmation modal (issue #172), same pattern as the
 * worker-delete modal (#116): states that the LOCAL project — terminals, state,
 * board data — is removed while the GitHub repo is NOT, and confirms with
 * an explicit "Delete {name}" button. Pure rendering.
 */
export function DeleteProjectModal(props: {
  projectName: string;
  /** The delete request is in flight (confirm shows "Deleting…"). */
  pending: boolean;
  /** Failure from the daemon (e.g. 409 while workers drive a PR). */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmModal
      ariaLabel="Delete project"
      title="Delete project?"
      body={
        <p>
          <code>{props.projectName}</code> will be removed from PiDeck — its orchestrator and worker terminals, clones
          and local state, and board data. <strong>The GitHub repository is not deleted.</strong>
        </p>
      }
      confirmLabel={`Delete ${props.projectName}`}
      pendingLabel="Deleting…"
      pending={props.pending}
      error={props.error}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}

/**
 * The agent-session delete modal (issue #311, #268 modal pattern; #377
 * renames the user-facing label from "Terminate" to "Delete"): the
 * daemon kills the pane and removes the agent-kind session's record —
 * unlike workers there is no archived log (the report, already delivered,
 * stays in the session it was sent to). Pure rendering.
 */
export function TerminateAgentSessionModal(props: {
  /** Sidebar label (Session.name) or tmux name of the session. */
  sessionLabel: string;
  /** The kind, shown for context ("devex-audit"). */
  agentKind: AgentKind;
  /** The delete request is in flight (confirm shows "Deleting…"). */
  pending: boolean;
  /** Failure from the daemon, shown inside the modal. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmModal
      ariaLabel="Delete agent session"
      title="Delete session?"
      body={
        <p>
          <code>{props.sessionLabel}</code> ({props.agentKind}) will be killed and removed from the sidebar. Agent-kind
          sessions keep no archived log — a report already delivered stays in the session it was sent to.
        </p>
      }
      confirmLabel="Delete"
      pendingLabel="Deleting…"
      error={props.error}
      pending={props.pending}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}

/**
 * The input-taking spawn modal (docs/agent-kinds.md, issues #297/#324/#331):
 * a small centered modal asking for the input a `waitForInput` kind waits
 * for — the researcher's question today, any custom `waitForInput` kind's
 * task. Confirm stays disabled until input is typed; failures surface
 * inside the modal. Title, labels, and confirm target derive from the
 * kind's metadata; the read-only claim follows the kind's spec (shipped
 * kinds are read-only by default). Pure rendering.
 */
export function SpawnInputModal(props: {
  projectName: string;
  /** The kind being spawned — drives the copy and confirm target. */
  agentKind: AgentKind;
  /**
   * The kind's registry spec, when resolvable from the fetched registry
   * (drives the read-only claim). Absent (unknown/unfetched): the shipped
   * read-only default.
   */
  spec?: AgentKindSpec;
  /** The spawn request is in flight (confirm shows "Spawning..."). */
  pending: boolean;
  /** Failure from the daemon, shown inside the modal. */
  error?: string | null;
  onConfirm: (question: string) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState("");
  const ready = input.trim().length > 0;
  const fallback = agentKindInfo(props.agentKind);
  // Registry-v2 specs carry their own presentation fields — prefer them.
  const menuLabel = props.spec?.menuLabel ?? fallback.menuLabel;
  const readOnly = props.spec?.readOnly ?? true;
  // Question-vs-task wording follows the kind spec's trigger, not its name —
  // any user-defined `waitForInput` kind asks a question (issue #351 F1).
  const isQuestion = props.spec ? props.spec.trigger === "waitForInput" : false;
  return (
    <ConfirmModal
      ariaLabel={`Spawn ${props.agentKind}`}
      title={`Spawn ${menuLabel}?`}
      confirmDisabled={!ready}
      confirmLabel="Spawn"
      pendingLabel="Spawning…"
      body={
        <>
          <p>
            A{readOnly ? " read-only" : "n"} agent will take your {isQuestion ? "question" : "task"} for{" "}
            <code>{props.projectName}</code> and carry it out per its persona{isQuestion ? ", reporting its findings back to the session that spawned it" : ""}.
          </p>
          <textarea
            className="modal-textarea"
            placeholder={isQuestion ? "What should it research?" : "Describe the task…"}
            aria-label={`${menuLabel} ${isQuestion ? "question" : "task"}`}
            rows={3}
            value={input}
            disabled={props.pending}
            autoFocus
            onChange={(event) => setInput(event.target.value)}
          />
        </>
      }
      error={props.error}
      pending={props.pending}
      onConfirm={() => props.onConfirm(input.trim())}
      onCancel={props.onCancel}
    />
  );
}
