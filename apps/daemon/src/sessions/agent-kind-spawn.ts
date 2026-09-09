/**
 * Agent-kind spawn machinery (docs/agent-kinds.md, issues #297/#300/#302).
 *
 * An agent-kind spawn creates a **session** — never a worker record — with
 * the preset persona (the caller renders it; see the api-layer
 * `spawnAgentKindSession`, which owns persona/parent/report-target
 * knowledge) and a fixed pane command (`agentKindLaunchCommand`): pi with
 * the rendered persona file, the session id in the environment, and — for
 * read-only kinds — the write tools excluded. This module owns everything
 * mechanical: the tmux name, the registry session (role `worker` with
 * `agentKind` + `parentSessionId` + `workerId: null`), the workspace
 * rules, command recording, and failure cleanup.
 *
 * Workspace rules per kind spec (`agent-kinds.ts`): worker-like kinds get
 * a fresh per-session worktree branched off origin's default branch (the
 * #287 machinery, keyed by session id); cheap kinds run read-only in the
 * project clone. The built command is recorded (`setSessionCommand`) so
 * relaunch (#117) and reconcile/resurrect (#27) re-run the identical
 * command — persona embedded — exactly like worker panes.
 *
 * Split from `manager.ts` (kiss max-lines budget) following the
 * `reconcile.ts` pattern: explicit deps, free function; the
 * {@link SessionManager} facade delegates.
 */

import type { AgentKind, Session } from "@pideck/shared";

import type { GitRunner } from "../github/repos.js";
import { agentKindSpec } from "./agent-kinds.js";
import type { ProjectLayout } from "./layout.js";
import type { SessionRegistry } from "./registry.js";
import type { Tmux } from "./tmux.js";
import { nextTmuxSessionName, serializeCommand } from "./tmux-commands.js";
import { prepareWorkerWorkspace } from "./workspace.js";

export interface AgentKindSpawnDeps {
  tmux: Tmux;
  registry: SessionRegistry;
  layout: ProjectLayout;
  git: GitRunner;
}

export interface AgentKindSpawnRequest {
  kind: AgentKind;
  /** Parent session of any role (docs/agent-kinds.md §3) — resolved by the caller. */
  parentSessionId: string;
  /** Sidebar label (the spawn's `--name`, ≤ 20 characters). */
  name?: string;
  /**
   * Builds the pane command once the session record and cwd are resolved:
   * personas embed the session id and working directory, so they can only
   * render at launch time. The returned argv is launched AND recorded.
   * Rendering failures abort the spawn cleanly (no half-registered state).
   */
  buildCommand: (ctx: { sessionId: string; cwd: string }) => string[];
}

/**
 * Spawns one agent-kind session. Throws on failure with the registry
 * cleaned up (the session record is gone; a prepared worktree is
 * discarded) — a failed spawn never leaves half-registered state.
 */
export async function spawnAgentKindSession(deps: AgentKindSpawnDeps, projectId: string, request: AgentKindSpawnRequest): Promise<Session> {
  const { tmux, registry, layout } = deps;
  const spec = agentKindSpec(request.kind);
  const name = await nextTmuxSessionName({ tmux, registry }, projectId, "worker");
  const session = registry.createSession({
    projectId,
    role: "worker",
    tmuxSession: name,
    workerId: null,
    ...(request.name !== undefined ? { name: request.name } : {}),
    agentKind: request.kind,
    parentSessionId: request.parentSessionId,
  });

  // Workspace per kind spec (docs/agent-kinds.md §5): worker-like kinds get
  // the fresh-origin worktree (#287 — keyed by the unique session id);
  // cheap kinds run read-only in the project clone. A fetch failure aborts
  // the spawn — never start an audit on a stale base.
  let workspace: { path: string; discard: () => Promise<void> } | null = null;
  let cwd: string;
  try {
    if (spec.workerLike) {
      workspace = await prepareWorkerWorkspace(deps.git, layout, projectId, session.id);
      registry.setSessionCwd(session.id, workspace.path);
      cwd = workspace.path;
    } else {
      cwd = layout.cloneDir(projectId);
      registry.setSessionCwd(session.id, cwd);
    }
    const command = request.buildCommand({ sessionId: session.id, cwd });
    registry.setSessionCommand(session.id, serializeCommand(command));
    await tmux.newSession(name, { cwd, command });
  } catch (err) {
    registry.deleteSession(session.id);
    if (workspace !== null) await workspace.discard();
    throw err;
  }
  return registry.getSession(session.id) as Session;
}
