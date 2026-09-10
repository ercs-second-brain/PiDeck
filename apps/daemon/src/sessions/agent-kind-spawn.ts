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
 * Workspace rules per kind spec (`agent-kinds.ts`), with issue #365's
 * parent-state inheritance: BOTH kind classes get a per-session worktree.
 * The base is the **parent's checked-out commit** when the parent has a
 * meaningful git state (its recorded cwd resolves to a HEAD — a worker's
 * worktree, another kind's worktree), else the #287 fresh-origin fallback:
 * fetch + a worktree off origin's current default branch (up-to-date
 * main). This kills the "spawned researcher was 37 commits behind"
 * surprise — cheap kinds no longer share the (possibly stale) project
 * clone; worker-like kinds no longer branch off origin while the parent
 * was mid-task on older code. The resolved cwd is recorded
 * (`setSessionCwd`) — the persona's `{{PROJECT_PATH}}` and the
 * relaunch/reconcile launch paths (issues #27/#117) read it from the
 * registry.
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
import { prepareWorkerWorkspace, resolveParentHead } from "./workspace.js";

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

  // Workspace per kind spec (docs/agent-kinds.md §5) with #365's
  // parent-state inheritance: both kind classes get a per-session worktree
  // (#287 machinery, keyed by the unique session id) based on the parent's
  // checked-out commit when it has meaningful git state, else the
  // fresh-origin fallback (fetch + origin's default branch — up-to-date
  // main). A fetch failure on the fallback aborts the spawn — never start
  // an audit on a stale base.
  let workspace: { path: string; discard: () => Promise<void> } | null = null;
  try {
    const parentHead = await resolveParentHead(deps.git, registry.getSession(request.parentSessionId)?.cwd);
    workspace = await prepareWorkerWorkspace(deps.git, layout, projectId, session.id, parentHead !== null ? { baseRef: parentHead } : {});
    registry.setSessionCwd(session.id, workspace.path);
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
