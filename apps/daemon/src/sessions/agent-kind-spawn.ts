/**
 * Agent-kind spawn mechanics (docs/agent-kinds.md, issues #297/#300/#302).
 *
 * An agent-kind spawn creates a **session** — never a worker record — with
 * the session id, kind, parent lineage, and sidebar label recorded, and the
 * pane opened as a **bare shell** in the kind's workspace. Putting pi into
 * the pane with the rendered kind persona is the bootstrap's job
 * (`OrchestratorBootstrap.ensureForSession`, the #290 pattern — identical
 * to how orchestrator panes are launched), so every launch path (spawn,
 * relaunch, startup sweep) heals through ONE idempotent typing step.
 *
 * Workspace rules per kind spec (`agent-kinds.ts`): worker-like kinds get
 * a fresh per-session worktree branched off origin's default branch (the
 * #287 machinery, keyed by session id); cheap kinds run read-only in the
 * project clone. The resolved cwd is recorded (`setSessionCwd`) — the
 * persona's `{{PROJECT_PATH}}` and the relaunch/reconcile launch paths
 * (issues #27/#117) read it from the registry.
 *
 * Split from `manager.ts` (kiss max-lines budget) following the
 * `reconcile.ts` pattern: explicit deps, free function; the
 * {@link SessionManager} facade delegates.
 */

import type { AgentKind, Session } from "@pideck/shared";

import type { GitRunner } from "../github/repos.js";
import type { AgentKindLookup } from "./agent-kinds.js";
import type { ProjectLayout } from "./layout.js";
import type { SessionRegistry } from "./registry.js";
import type { Tmux } from "./tmux.js";
import { nextTmuxSessionName } from "./tmux-commands.js";
import { prepareWorkerWorkspace } from "./workspace.js";

export interface AgentKindSpawnDeps {
  tmux: Tmux;
  registry: SessionRegistry;
  layout: ProjectLayout;
  git: GitRunner;
  /** The kind registry (v2): specs resolve from here, never hardcoded. */
  agentKinds: AgentKindLookup;
}

export interface AgentKindSpawnRequest {
  kind: AgentKind;
  /** Parent session of any role (docs/agent-kinds.md §3) — resolved by the caller. */
  parentSessionId: string;
  /** Sidebar label (the spawn's `--name`, ≤ 20 characters). */
  name?: string;
}

/**
 * Spawns one agent-kind session: registry records + workspace + a bare
 * shell pane. Throws on failure with the registry cleaned up (the session
 * record is gone; a prepared worktree is discarded) — a failed spawn never
 * leaves half-registered state. The persona launch happens afterwards via
 * the bootstrap (`ensureForSession`), which needs the returned session.
 */
export async function spawnAgentKindSession(deps: AgentKindSpawnDeps, projectId: string, request: AgentKindSpawnRequest): Promise<Session> {
  const { tmux, registry, layout } = deps;
  const spec = deps.agentKinds.get(request.kind);
  if (spec === undefined) throw new Error(`unknown agent kind: ${request.kind}`);
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
  try {
    if (spec.workerLike) {
      workspace = await prepareWorkerWorkspace(deps.git, layout, projectId, session.id);
      registry.setSessionCwd(session.id, workspace.path);
    } else {
      registry.setSessionCwd(session.id, layout.cloneDir(projectId));
    }
    // Bare shell: the bootstrap types the persona launch line (issue #290
    // pattern) — spawn, relaunch, and the startup sweep all heal identically.
    await tmux.newSession(name, { cwd: registry.getSession(session.id)?.cwd });
  } catch (err) {
    registry.deleteSession(session.id);
    if (workspace !== null) await workspace.discard();
    throw err;
  }
  return registry.getSession(session.id) as Session;
}
