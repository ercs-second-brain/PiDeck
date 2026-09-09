/**
 * The terminals sidebar's confirmation-modal stack (issues #116/#172/#268
 * + #311): the terminate confirms (worker vs agent-kind — their copy and
 * confirm targets differ), the delete-project confirm, and the
 * investigator question modal. Extracted from SessionPicker to keep the
 * picker and each function within the complexity budgets; Escape and the
 * pending/error lifecycles live in the interaction-state hook
 * (use-picker-state.ts).
 */

import type { AgentKind } from "@pideck/shared";
import {
  DeleteProjectModal,
  InvestigatorPromptModal,
  TerminateAgentSessionModal,
  TerminateWorkerModal,
} from "./picker-modals";
import type { ProjectEntry } from "./SessionPicker";
import type { usePickerState } from "./use-picker-state";

type PickerState = ReturnType<typeof usePickerState>;

/** Props of {@link ConfirmModals} — the confirm handlers the host wires. */
export interface ConfirmModalsProps {
  state: PickerState;
  entries: ProjectEntry[];
  /** Terminates the worker after confirmation (issue #268: awaited by the modal). */
  onTerminateWorker?: (workerId: string) => Promise<void>;
  /** Terminates an agent-kind session after confirmation (issue #311, #268 modal). */
  onTerminateAgentSession?: (sessionId: string) => Promise<void>;
  /** Spawns agent-kind sessions (docs/agent-kinds.md, #297/#300/#302). */
  onSpawnAgentSession?: (projectId: string, kind: AgentKind, question?: string) => Promise<void>;
  onDeleteProject?: (projectId: string) => Promise<void>;
}

/**
 * The terminate confirms (issues #64/#116 + #311): agent-kind sessions get
 * their own modal — they keep no archived log, and the confirm target is
 * the session id, not a worker id.
 */
function TerminateConfirmModals(props: { state: PickerState; onTerminateWorker?: ConfirmModalsProps["onTerminateWorker"]; onTerminateAgentSession?: ConfirmModalsProps["onTerminateAgentSession"] }) {
  const { state } = props;
  const confirming = state.confirmingSession;
  if (confirming === undefined) return null;
  if (confirming.agentKind !== undefined) {
    if (props.onTerminateAgentSession === undefined) return null;
    return (
      <TerminateAgentSessionModal
        sessionLabel={confirming.name ?? confirming.tmuxSession}
        agentKind={confirming.agentKind}
        pending={state.pendingTerminate}
        error={state.terminateError}
        onConfirm={() => void state.confirmTerminateAgent(props.onTerminateAgentSession!)}
        onCancel={state.cancelTerminate}
      />
    );
  }
  if (props.onTerminateWorker === undefined) return null;
  return (
    <TerminateWorkerModal
      sessionName={confirming.tmuxSession}
      pending={state.pendingTerminate}
      error={state.terminateError}
      onConfirm={() => void state.confirmTerminate(props.onTerminateWorker!)}
      onCancel={state.cancelTerminate}
    />
  );
}

/** The sidebar's confirmation-modal stack — see the module doc. Pure rendering. */
export function ConfirmModals(props: ConfirmModalsProps) {
  const { state } = props;
  const deletingName = props.entries.find((entry) => entry.project.id === state.deleteConfirm.confirmingId)?.project.name;
  const investigatorName =
    props.entries.find((entry) => entry.project.id === state.investigatorAsk.confirmingProjectId)?.project.name ??
    state.investigatorAsk.confirmingProjectId;
  return (
    <>
      <TerminateConfirmModals state={state} onTerminateWorker={props.onTerminateWorker} onTerminateAgentSession={props.onTerminateAgentSession} />
      {state.deleteConfirm.confirmingId !== null && props.onDeleteProject && (
        <DeleteProjectModal
          projectName={deletingName ?? ""}
          pending={state.deleteConfirm.pending}
          error={state.deleteConfirm.error}
          onConfirm={() => void state.deleteConfirm.confirm(props.onDeleteProject!)}
          onCancel={state.deleteConfirm.cancel}
        />
      )}
      {state.investigatorAsk.confirmingProjectId !== null && props.onSpawnAgentSession !== undefined && (
        <InvestigatorPromptModal
          projectName={investigatorName ?? ""}
          pending={state.investigatorAsk.pending}
          error={state.investigatorAsk.error}
          onConfirm={(question) =>
            void state.investigatorAsk.confirm(question, (projectId, question) =>
              props.onSpawnAgentSession!(projectId, "investigator", question),
            )
          }
          onCancel={state.investigatorAsk.cancel}
        />
      )}
    </>
  );
}
