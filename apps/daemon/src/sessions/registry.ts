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
  /**
   * Conceptual lane the worker was spawned for (issue #471); carried from
   * the spawn request (`pideck spawn --lane <slug>`) onto the worker record
   * — the idle-reuse key. Absent = lane-less (never reused).
   */
  lane?: string;
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
  version: 2;
  sessions: Session[];
  workers: Worker[];
}

const STATE_VERSION = 2;

/** Fresh literal per call — NEVER a shared module constant: the fallback is
 * returned by reference on absent files, so a shared empty would leak state
 * across registry instances in-process (issue #372, the AgentKindStore
 * trap). `load()` only reads the fallback today, but the pattern is the
 * same latent hazard. */
const emptyState = (): PersistedState => ({ version: STATE_VERSION, sessions: [], workers: [] });

/**
 * Validates a parsed registry file, dropping entries that no longer match
 * their schema (forward compatibility) instead of rejecting the whole file.
 *
 * Drops are loud (logged with the reason): a silently dropped record is
 * undebuggable — issue #488's 404-on-terminate came from worker records
 * dropped this way while their owning sessions survived, leaving dangling
 * `session.workerId` pointers the webapp resolved into
 * `/api/workers/<id>/terminate` calls the daemon could only 404.
 */
function validatePersistedState(value: unknown): PersistedState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<PersistedState>;
  const sessions: Session[] = [];
  for (const entry of raw.sessions ?? []) {
    const parsed = sessionSchema.safeParse(migrateSessionKind(entry));
    if (parsed.success) sessions.push(parsed.data);
    else console.error(`[pideck] registry: dropped unparsable session record:`, JSON.stringify(entry), parsed.error.message);
  }
  const workers: Worker[] = [];
  for (const entry of raw.workers ?? []) {
    const parsed = workerSchema.safeParse(migrateWorkerPrNumbers(entry));
    if (parsed.success) workers.push(parsed.data);
    else console.error(`[pideck] registry: dropped unparsable worker record:`, JSON.stringify(entry), parsed.error.message);
  }
  // Listing/registry agreement (issue #488): a surviving session must never
  // point at a worker record the loader dropped — the webapp lists sessions
  // and terminates them through that pointer, so a dangling one turns into
  // a guaranteed-404 delete for a row the UI shows. Clear the pointer: the
  // row keeps rendering (record-less, the #482 shape) and its delete routes
  // through the #317 session-id terminate path, which kills the pane.
  const workerIds = new Set(workers.map((worker) => worker.id));
  const agreed = sessions.map((session) => {
    if (session.workerId === null || workerIds.has(session.workerId)) return session;
    console.error(
      `[pideck] registry: session ${session.id} references missing worker ${session.workerId}; clearing the pointer so the row stays deletable`,
    );
    return { ...session, workerId: null };
  });
  return { version: STATE_VERSION, sessions: agreed, workers };
}

/**
 * One-time PR-association migration (issue #470): workers persisted before
 * multi-PR support carry a single `prNumber`; without this rewrite they
 * would fail the worker schema and be DROPPED by the loader. Rewritten on
 * load, so the next save persists the list shape.
 */
function migrateWorkerPrNumbers(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null) return entry;
  const raw = entry as Record<string, unknown>;
  if (typeof raw["prNumber"] !== "number") return entry;
  const { prNumber, ...rest } = raw;
  return { ...rest, prNumbers: [prNumber] };
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

/**
 * Write-time validation (issue #494): the loader ({@link validatePersistedState})
 * drops records that fail their schema — loudly, with dangling-pointer repair
 * (issue #489) — but that only fires at boot, after the bad record was already
 * persisted. This guard runs on every write path instead: a schema-invalid
 * shape fails at spawn/persist time, so the file on disk never contains a
 * record the loader will have to drop. Intentionally the SAME schemas (no
 * schema or forward-compat policy change): anything this rejects is exactly
 * what the loader would have silently dropped.
 */
function assertParsable(kind: "session" | "worker", record: unknown): void {
  const schema = kind === "session" ? sessionSchema : workerSchema;
  const parsed = schema.safeParse(record);
  if (!parsed.success) {
    throw new Error(
      `[pideck] registry: refusing to write invalid ${kind} record (the loader would drop it): ${JSON.stringify(record)} — ${parsed.error.message}`,
    );
  }
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
    assertParsable("session", session);
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
      prNumbers: input.prNumber === undefined ? [] : [input.prNumber],
      status: input.status ?? "spawning",
      statusMessage: input.statusMessage ?? null,
      startedAt: now,
      updatedAt: now,
    };
    if (input.kind !== undefined) worker.kind = input.kind;
    if (input.prompt !== undefined) worker.prompt = input.prompt;
    if (input.lane !== undefined) worker.lane = input.lane;
    if (input.parentWorkerId !== undefined && input.parentWorkerId !== null) {
      worker.parentWorkerId = input.parentWorkerId;
    }
    assertParsable("worker", worker);
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

  /**
   * Records `prNumber` as associated with the worker (appends — a worker may
   * drive several PRs, issue #470; set is idempotent). First association is
   * canonical (diffs, archived-log links).
   */
  setWorkerPr(workerId: string, prNumber: number): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`unknown worker: ${workerId}`);
    if (!worker.prNumbers.includes(prNumber)) worker.prNumbers.push(prNumber);
    worker.updatedAt = new Date().toISOString();
    this.save();
    return worker;
  }

  /**
   * Removes one PR from the worker's association list (issue #466/#470:
   * mis-association self-correction and re-association move individual PRs;
   * the worker keeps any others). Idempotent.
   */
  clearWorkerPr(workerId: string, prNumber: number): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`unknown worker: ${workerId}`);
    worker.prNumbers = worker.prNumbers.filter((n) => n !== prNumber);
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

  /**
   * Re-tasks an idle worker with a follow-on task (issue #471 reuse): the
   * new issue number and prompt replace the old ones on the record and the
   * worker moves to `running` — the pane (still alive) receives the
   * follow-on prompt through the caller's prompt-gate delivery. The lane
   * and the PR associations ride untouched: the worker keeps its lane (it
   * stays reusable for the same lane) and `prNumbers` accumulate (#470).
   */
  retaskWorker(workerId: string, issueNumber: number, prompt: string, statusMessage: string): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`unknown worker: ${workerId}`);
    worker.issueNumber = issueNumber;
    worker.prompt = prompt;
    worker.status = "running";
    worker.statusMessage = statusMessage;
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

  /**
   * Writes current state to the JSON file (atomic via {@link JsonStore}).
   * Every record is schema-validated first (issue #494): save() is the one
   * choke point all write paths funnel through, so the in-place mutators
   * (status/PR/retask/cwd/command/… updates) are covered here even though
   * only the two factory methods can build a bad record today.
   */
  save(): void {
    const state: PersistedState = {
      version: STATE_VERSION,
      sessions: [...this.sessions.values()],
      workers: [...this.workers.values()],
    };
    for (const session of state.sessions) assertParsable("session", session);
    for (const worker of state.workers) assertParsable("worker", worker);
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
