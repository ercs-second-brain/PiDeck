/**
 * Session registry: in-memory map + JSON-file persistence for `Session`
 * and `Worker` records (types from `@pideck/shared`).
 *
 * The registry is the daemon's queryable source of truth for which tmux
 * sessions and workers exist. It is persisted to a single JSON file under
 * the daemon state dir so it survives an in-process reload (new registry
 * instance over the same file); cross-reboot reconciliation against real
 * tmux state is issue #15.
 */

import { randomUUID } from "node:crypto";
import {
  sessionSchema,
  workerSchema,
  type AgentKind,
  type Session,
  type Worker,
  type WorkerKind,
  type WorkerStatus,
} from "@pideck/shared";

import { JsonStore } from "../json-store.js";

export type SessionRole = Session["role"];

export interface CreateSessionInput {
  projectId: string;
  role: SessionRole;
  tmuxSession: string;
  /** Working directory the pane is launched in (`Session.cwd` contract field). */
  cwd?: string;
  /** Command the pane is launched with (`Session.command` contract field). */
  command?: string;
  workerId?: string | null;
  /** Preset-prompt agent kind (docs/agent-kinds.md); absent for ordinary sessions. */
  agentKind?: AgentKind;
  /** Parent session of any role (docs/agent-kinds.md §3); absent for ordinary sessions. */
  parentSessionId?: string;
  /** Sidebar label (`Session.name`, ≤ 20 characters); agent-kind spawns carry their `--name`. */
  name?: string;
  /**
   * Runs-as-review-identity flag (`Session.runsAsReviewIdentity`, issue
   * #423): set when the pane was launched with the review account's
   * `GH_TOKEN` — relaunch/reconcile re-inject the token on recreation.
   */
  runsAsReviewIdentity?: boolean;
}

export interface RegisterWorkerInput {
  projectId: string;
  sessionId: string;
  issueNumber: number;
  /** PR the worker owns, or reviews (review agents, issue #107). */
  prNumber?: number;
  /** Worker kind (issue #107); omit for implementers — absent means implementer. */
  kind?: WorkerKind;
  /** Parent worker for nested spawns (review agents, issue #107). */
  parentWorkerId?: string | null;
  /** Initial prompt typed into the pane at spawn (issue #120); absent when none. */
  prompt?: string;
  status?: WorkerStatus;
  statusMessage?: string | null;
}

export interface SessionFilter {
  projectId?: string;
  role?: SessionRole;
  workerId?: string | null;
}

export interface WorkerFilter {
  projectId?: string;
  status?: WorkerStatus;
}

interface PersistedState {
  version: 1;
  sessions: Session[];
  workers: Worker[];
}

const STATE_VERSION = 1;

/** Fresh literal per call — NEVER a shared module constant: the fallback is
 * returned by reference on absent files, so a shared empty would leak state
 * across registry instances in-process (issue #372, the AgentKindStore
 * trap). `load()` only reads the fallback today, but the pattern is the
 * same latent hazard. */
const emptyState = (): PersistedState => ({ version: STATE_VERSION, sessions: [], workers: [] });

/**
 * Validates a parsed registry file, dropping entries that no longer match
 * their schema (forward compatibility) instead of rejecting the whole file.
 */
function validatePersistedState(value: unknown): PersistedState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<PersistedState>;
  const sessions: Session[] = [];
  for (const entry of raw.sessions ?? []) {
    const parsed = sessionSchema.safeParse(migrateSessionKind(entry));
    if (parsed.success) sessions.push(parsed.data);
  }
  const workers: Worker[] = [];
  for (const entry of raw.workers ?? []) {
    const parsed = workerSchema.safeParse(entry);
    if (parsed.success) workers.push(parsed.data);
  }
  return { version: STATE_VERSION, sessions, workers };
}

/**
 * One-time kind-id migration (issue #335, docs/agent-kinds.md §7): sessions
 * persisted before the researcher rename still carry the legacy kind id
 * (spelled "investigator"); without this rewrite they would fail the
 * session schema (the enum no longer contains the legacy id) and be DROPPED
 * by the loader — the session would vanish from the sidebar and become
 * unterminable. Rewritten on load, so the next save persists the new id;
 * this is the one place in the codebase that still mentions the legacy id.
 */
function migrateSessionKind(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null) return entry;
  const raw = entry as Record<string, unknown>;
  return raw["agentKind"] === "investigator" ? { ...raw, agentKind: "researcher" } : entry;
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly workers = new Map<string, Worker>();
  private readonly store: JsonStore<PersistedState>;

  constructor(filePath: string) {
    this.store = new JsonStore(filePath);
    this.load();
  }

  // -- sessions -------------------------------------------------------------

  createSession(input: CreateSessionInput): Session {
    const session: Session = {
      id: newId("sess"),
      projectId: input.projectId,
      role: input.role,
      tmuxSession: input.tmuxSession,
      workerId: input.workerId ?? null,
      createdAt: new Date().toISOString(),
    };
    if (input.cwd !== undefined) session.cwd = input.cwd;
    if (input.command !== undefined) session.command = input.command;
    if (input.agentKind !== undefined) session.agentKind = input.agentKind;
    if (input.parentSessionId !== undefined) session.parentSessionId = input.parentSessionId;
    if (input.name !== undefined) session.name = input.name;
    if (input.runsAsReviewIdentity !== undefined) session.runsAsReviewIdentity = input.runsAsReviewIdentity;
    this.sessions.set(session.id, session);
    this.save();
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getSessionByTmuxName(tmuxSession: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.tmuxSession === tmuxSession) return session;
    }
    return undefined;
  }

  listSessions(filter: SessionFilter = {}): Session[] {
    return [...this.sessions.values()].filter((session) => {
      if (filter.projectId !== undefined && session.projectId !== filter.projectId) return false;
      if (filter.role !== undefined && session.role !== filter.role) return false;
      if (filter.workerId !== undefined && session.workerId !== filter.workerId) return false;
      return true;
    });
  }

  /** Associates a worker with its session (sessions are created before workers). */
  setSessionWorker(sessionId: string, workerId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    session.workerId = workerId;
    this.save();
    return session;
  }

  /**
   * Records the pane's working directory after workspace preparation
   * (issue #287): worker sessions are created before their worktree exists,
   * and the resolved worktree path must be persisted so reconcile/relaunch
   * resurrect the pane in the same workspace.
   */
  setSessionCwd(sessionId: string, cwd: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    session.cwd = cwd;
    this.save();
    return session;
  }

  /**
   * Records the pane's launch command after it is built: agent-kind
   * personas (docs/agent-kinds.md) can only be rendered once the session id
   * and working directory are known, so the command is patched onto the
   * record post-creation — relaunch/reconcile then re-run it verbatim
   * (issues #27/#117).
   */
  setSessionCommand(sessionId: string, command: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    session.command = command;
    this.save();
    return session;
  }

  deleteSession(id: string): boolean {
    const deleted = this.sessions.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  /**
   * Marks a session archived (`Session.archivedAt`, issue #357 B9): the
   * record is kept for history — the persona-agent archive semantics, the
   * worker-status `archived` pattern applied to sessions. Archived
   * sessions stay out of live listings ({@link SessionManager.listSessions})
   * and are never resurrected by reconcile. Throws for an unknown id.
   */
  markSessionArchived(id: string, archivedAt: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown session: ${id}`);
    session.archivedAt = archivedAt;
    this.save();
    return session;
  }

  // -- workers ---------------------------------------------------------------

  registerWorker(input: RegisterWorkerInput): Worker {
    const now = new Date().toISOString();
    const worker: Worker = {
      id: newId("worker"),
      projectId: input.projectId,
      sessionId: input.sessionId,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber ?? null,
      status: input.status ?? "spawning",
      statusMessage: input.statusMessage ?? null,
      startedAt: now,
      updatedAt: now,
    };
    if (input.kind !== undefined) worker.kind = input.kind;
    if (input.prompt !== undefined) worker.prompt = input.prompt;
    if (input.parentWorkerId !== undefined && input.parentWorkerId !== null) {
      worker.parentWorkerId = input.parentWorkerId;
    }
    this.workers.set(worker.id, worker);
    this.save();
    return worker;
  }

  getWorker(id: string): Worker | undefined {
    return this.workers.get(id);
  }

  listWorkers(filter: WorkerFilter = {}): Worker[] {
    return [...this.workers.values()].filter((worker) => {
      if (filter.projectId !== undefined && worker.projectId !== filter.projectId) return false;
      if (filter.status !== undefined && worker.status !== filter.status) return false;
      return true;
    });
  }

  setWorkerPr(workerId: string, prNumber: number): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`unknown worker: ${workerId}`);
    worker.prNumber = prNumber;
    worker.updatedAt = new Date().toISOString();
    this.save();
    return worker;
  }

  updateWorkerStatus(workerId: string, status: WorkerStatus, statusMessage?: string): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`unknown worker: ${workerId}`);
    worker.status = status;
    if (statusMessage !== undefined) worker.statusMessage = statusMessage;
    worker.updatedAt = new Date().toISOString();
    this.save();
    return worker;
  }

  /** Removes a worker record entirely (issue #172 project teardown — unlike
   * archive, deletion keeps no history). No-op for unknown ids. */
  deleteWorker(id: string): boolean {
    const deleted = this.workers.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  // -- persistence -----------------------------------------------------------

  /** Writes current state to the JSON file (atomic via {@link JsonStore}). */
  save(): void {
    const state: PersistedState = {
      version: STATE_VERSION,
      sessions: [...this.sessions.values()],
      workers: [...this.workers.values()],
    };
    this.store.save(state);
  }

  /** Re-reads state from the JSON file, replacing the in-memory maps. */
  load(): void {
    const state = this.store.load(validatePersistedState, emptyState());
    this.sessions.clear();
    this.workers.clear();
    for (const session of state.sessions) this.sessions.set(session.id, session);
    for (const worker of state.workers) this.workers.set(worker.id, worker);
  }
}
