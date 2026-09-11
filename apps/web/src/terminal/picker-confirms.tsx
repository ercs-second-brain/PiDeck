/**
 * The terminals sidebar's confirmation-modal stack (issues #116/#172/#268
 * + #311): the terminate confirms (worker vs agent-kind — their copy and
 * confirm targets differ), the delete-project confirm, and the spawn-input
 * modal. Extracted from SessionPicker to keep the
 * picker and each function within the complexity budgets; Escape and the
 * pending/error lifecycles live in the interaction-state hook
 * (use-picker-state.ts).
 */

import type { AgentKind, AgentKindSpec } from "@pideck/shared";
import {
  DeleteProjectModal,
  SpawnInputModal,
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
  /**
   * The live kind registry (issue #330): resolves the confirming kind's
   * spec so the input modal's copy follows it (read-only claim, #331).
   */
  agentKinds?: readonly AgentKindSpec[];
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
  // Issue #482: a record-less (adopted orphan) worker session deletes
  // through the #317 session-id terminate path — the daemon kills the
  // pane and removes the record, so nothing is archived.
  return (
    <TerminateWorkerModal
      sessionName={confirming.tmuxSession}
      archived={confirming.workerId != null}
      pending={state.pendingTerminate}
      error={state.terminateError}
      onConfirm={() => void state.confirmTerminate(props.onTerminateWorker!, props.onTerminateAgentSession)}
      onCancel={state.cancelTerminate}
    />
  );
}

/** The sidebar's confirmation-modal stack — see the module doc. Pure rendering. */
export function ConfirmModals(props: ConfirmModalsProps) {
  const { state } = props;
  const deletingName = props.entries.find((entry) => entry.project.id === state.deleteConfirm.confirmingId)?.project.name;
  const projectName =
    props.entries.find((entry) => entry.project.id === state.spawnInput.confirming?.projectId)?.project.name ??
    state.spawnInput.confirming?.projectId;
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
      {state.spawnInput.confirming !== null && props.onSpawnAgentSession !== undefined && (
        <SpawnInputModal
          projectName={projectName ?? ""}
          agentKind={state.spawnInput.confirming.kind}
          spec={props.agentKinds?.find((kind) => kind.name === state.spawnInput.confirming?.kind)}
          pending={state.spawnInput.pending}
          error={state.spawnInput.error}
          onConfirm={(input) =>
            void state.spawnInput.confirm(input, (projectId, kind, input) =>
              props.onSpawnAgentSession!(projectId, kind, input),
            )
          }
          onCancel={state.spawnInput.cancel}
        />
      )}
    </>
  );
}
