/**
 * Session registry: in-memory map + JSON-file persistence for `Session`
 * and `Worker` records (types from `@agentskiss/shared`).
 *
 * The registry is the daemon's queryable source of truth for which tmux
 * sessions and workers exist. It is persisted to a single JSON file under
 * the daemon state dir so it survives an in-process reload (new registry
 * instance over the same file); cross-reboot reconciliation against real
 * tmux state is issue #15.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  sessionSchema,
  workerSchema,
  type Session,
  type Worker,
  type WorkerStatus,
} from "@agentskiss/shared";

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
}

export interface RegisterWorkerInput {
  projectId: string;
  sessionId: string;
  issueNumber: number;
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

function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly workers = new Map<string, Worker>();

  constructor(private readonly filePath: string) {
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

  deleteSession(id: string): boolean {
    const deleted = this.sessions.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  // -- workers ---------------------------------------------------------------

  registerWorker(input: RegisterWorkerInput): Worker {
    const now = new Date().toISOString();
    const worker: Worker = {
      id: newId("worker"),
      projectId: input.projectId,
      sessionId: input.sessionId,
      issueNumber: input.issueNumber,
      prNumber: null,
      status: input.status ?? "spawning",
      statusMessage: input.statusMessage ?? null,
      startedAt: now,
      updatedAt: now,
    };
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

  // -- persistence -----------------------------------------------------------

  /** Writes current state to the JSON file. */
  save(): void {
    const state: PersistedState = {
      version: STATE_VERSION,
      sessions: [...this.sessions.values()],
      workers: [...this.workers.values()],
    };
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  /** Re-reads state from the JSON file, replacing the in-memory maps. */
  load(): void {
    this.sessions.clear();
    this.workers.clear();
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // no persisted state yet
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt file: start empty rather than crash the daemon
    }
    const state = parsed as Partial<PersistedState> | null;
    for (const entry of state?.sessions ?? []) {
      const session = sessionSchema.safeParse(entry);
      if (session.success) this.sessions.set(session.data.id, session.data);
    }
    for (const entry of state?.workers ?? []) {
      const worker = workerSchema.safeParse(entry);
      if (worker.success) this.workers.set(worker.data.id, worker.data);
    }
  }
}
