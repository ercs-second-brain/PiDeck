/**
 * Session registry: the daemon's own record of every session it has run,
 * persisted at `<stateDir>/sessions.json`. Records use the shared `Session`
 * contract — this file is the only place sessions live, since GitHub cannot
 * tell the daemon about its own panes, watermarks, or archived history.
 */

import { z } from "zod";
import { join } from "node:path";
import { SessionSchema, type Persona, type Session } from "@pideck/shared";
import { JsonFile } from "../store/jsonFile.js";

export interface SessionFilter {
  projectId?: string;
  persona?: Persona;
  /** Include sessions whose `archivedAt` is set (default: include all). */
  archived?: boolean;
}

export type SessionPatch = Partial<
  Pick<
    Session,
    | "issueNumber"
    | "prNumber"
    | "lastPromptedHeadSha"
    | "lastDeliveredIssueCommentId"
    | "lastDeliveredPrCommentId"
    | "lastDeliveredReviewId"
    | "lastNotifiedConflictSha"
    | "fixAttempts"
    | "lastActivityAt"
  >
>;

export class SessionRegistry {
  readonly #file: JsonFile<Session[]>;

  constructor(stateDir: string) {
    this.#file = new JsonFile(join(stateDir, "sessions.json"), z.array(SessionSchema), []);
  }

  /** All records. A missing file is an empty registry; a corrupt one throws. */
  all(): Session[] {
    return this.#file.load();
  }

  get(id: string): Session | undefined {
    return this.all().find((session) => session.id === id);
  }

  list(filter: SessionFilter = {}): Session[] {
    return this.all().filter((session) => {
      if (filter.projectId !== undefined && session.projectId !== filter.projectId) return false;
      if (filter.persona !== undefined && session.persona !== filter.persona) return false;
      if (filter.archived === false && session.archivedAt !== undefined) return false;
      if (filter.archived === true && session.archivedAt === undefined) return false;
      return true;
    });
  }

  add(session: Session): void {
    this.#file.write([...this.all(), session]);
  }

  /** Updates watermarks (or the other patchable fields) on one record. */
  update(id: string, patch: SessionPatch): Session {
    const sessions = this.all();
    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) throw new Error(`unknown session ${id}`);
    const updated = { ...sessions[index]!, ...patch };
    sessions[index] = updated;
    this.#file.write(sessions);
    return updated;
  }

  /** Archives a session: sets `archivedAt` (record kept). Idempotent. */
  archive(id: string): Session {
    const sessions = this.all();
    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) throw new Error(`unknown session ${id}`);
    const session = sessions[index]!;
    if (session.archivedAt !== undefined) return session;
    const updated = { ...session, archivedAt: new Date().toISOString() };
    sessions[index] = updated;
    this.#file.write(sessions);
    return updated;
  }
}
