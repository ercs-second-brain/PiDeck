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
import { AGENT_KIND_INFO, type AgentKind } from "@pideck/shared";

/**
 * Shared shell for the sidebar's small centered confirmation modals
 * (worker terminate #116, project delete #172, researcher spawn #297):
 * dimmed backdrop, title, body, Cancel/confirm actions. Pure rendering.
 */
function ConfirmModal(props: {
  ariaLabel: string;
  title: string;
  body: ReactNode;
  /** Labels the confirm button ("Terminate" / "Delete <project>"). */
  confirmLabel: string;
  /** Label while the request is in flight ("Terminating…"). */
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
 * The terminate-confirmation modal (issue #116): small, centered, over a
 * dimmed backdrop — "Terminate worker X?" with Cancel/Terminate. Pure
 * rendering on top of {@link ConfirmModal}.
 */
export function TerminateWorkerModal(props: {
  /** tmux session name of the worker about to be terminated. */
  sessionName: string;
  /** The terminate request is in flight (Terminate shows "Terminating…"). */
  pending: boolean;
  /** Failure from the daemon, shown inside the modal (issue #268). */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmModal
      ariaLabel="Terminate worker"
      title="Terminate worker?"
      body={
        <p>
          <code>{props.sessionName}</code> will be killed and archived — its pane and agent stop, its history stays
          inspectable.
        </p>
      }
      confirmLabel="Terminate"
      pendingLabel="Terminating…"
      error={props.error}
      pending={props.pending}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}

/**
 * The delete-project confirmation modal (issue #172), same pattern as the
 * terminate modal (#116): states that the LOCAL project — terminals, state,
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
 * The agent-session terminate modal (issue #311, #268 modal pattern): the
 * daemon kills the pane and removes the agent-kind session's record —
 * unlike workers there is no archived log (the report, already delivered,
 * stays in the session it was sent to). Pure rendering.
 */
export function TerminateAgentSessionModal(props: {
  /** Sidebar label (Session.name) or tmux name of the session. */
  sessionLabel: string;
  /** The kind, shown for context ("devex-audit"). */
  agentKind: AgentKind;
  /** The terminate request is in flight (confirm shows "Terminating…"). */
  pending: boolean;
  /** Failure from the daemon, shown inside the modal. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmModal
      ariaLabel="Terminate agent session"
      title="Terminate session?"
      body={
        <p>
          <code>{props.sessionLabel}</code> ({props.agentKind}) will be killed and removed from the sidebar. Agent-kind
          sessions keep no archived log — a report already delivered stays in the session it was sent to.
        </p>
      }
      confirmLabel="Terminate"
      pendingLabel="Terminating…"
      error={props.error}
      pending={props.pending}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}

/**
 * The input-taking spawn modal (docs/agent-kinds.md, issue #297 + #324): a
 * small centered modal asking for the question the kind's report must
 * answer — for the kinds whose shared spec takesInput (the researcher
 * today; the audits spawn directly from the menu). Confirm stays disabled
 * until a question is typed; failures surface inside the modal. The title,
 * labels, and confirm target derive from the kind's metadata.
 */
export function ResearcherPromptModal(props: {
  projectName: string;
  /** The kind whose spec takesInput — drives the copy and confirm target. */
  agentKind: AgentKind;
  /** The spawn request is in flight (confirm shows "Spawning…"). */
  pending: boolean;
  /** Failure from the daemon, shown inside the modal. */
  error?: string | null;
  onConfirm: (question: string) => void;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState("");
  const ready = question.trim().length > 0;
  const info = AGENT_KIND_INFO[props.agentKind];
  return (
    <ConfirmModal
      ariaLabel={`Spawn ${props.agentKind}`}
      title={`Spawn ${info.menuLabel}?`}
      confirmDisabled={!ready}
      confirmLabel="Spawn"
      pendingLabel="Spawning…"
      body={
        <>
          <p>
            A read-only researcher will research <code>{props.projectName}</code> and report its findings — with
            file-and-line citations — back to the session that spawned it.
          </p>
          <textarea
            className="modal-textarea"
            placeholder="What should it research?"
            aria-label={`${info.menuLabel} question`}
            rows={3}
            value={question}
            disabled={props.pending}
            autoFocus
            onChange={(event) => setQuestion(event.target.value)}
          />
        </>
      }
      error={props.error}
      pending={props.pending}
      onConfirm={() => props.onConfirm(question.trim())}
      onCancel={props.onCancel}
    />
  );
}
