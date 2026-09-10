/**
 * Persisted blocked-ticket map (issues #408, #427).
 *
 * The issue-spawn pipeline records tickets whose spawn was suppressed by
 * open blockers so the merge-driven unblock sweep (`sweepUnblocked`,
 * issue #408) can re-evaluate them when a PR merges. Before #427 this map
 * was in-memory only: a daemon restart silently stranded every blocked
 * ticket — the watcher re-baselines and discards its backlog, the
 * catch-up sweep only re-sweeps issues above the persisted cursor, and
 * the merge-driven sweep iterated a now-empty map. No redelivery ever
 * fired, so the ticket sat stuck until a human re-assigned it.
 *
 * The map is now persisted to `<stateDir>/blocked-tickets.json` (all
 * projects in one file — the pipeline is project-agnostic), following the
 * same {@link ../../json-store.ts | JsonStore} pattern as the PR tracker
 * and the issue cursor: atomic writes, missing/corrupt file ⇒ empty map
 * (safe degradation, never a crash).
 */

import { issueSchema, type Issue } from "@pideck/shared";
import { z } from "zod";

import { JsonStore } from "../../json-store.js";

const persistedSchema = z.object({
  version: z.literal(1),
  projects: z.array(
    z.object({
      projectId: z.string().min(1),
      issues: z.array(issueSchema),
    }),
  ),
});

interface PersistedState {
  version: 1;
  projects: Array<{ projectId: string; issues: Issue[] }>;
}

export class BlockedTicketStore {
  private readonly byProject = new Map<string, Map<number, Issue>>();
  /** `null` = in-memory only (tests, default when the wiring passes no path). */
  private readonly store: JsonStore<PersistedState> | null;

  constructor(filePath?: string) {
    this.store = filePath === undefined ? null : new JsonStore(filePath);
    this.load();
  }

  /** The project's recorded blocked tickets (live view), or `undefined`. */
  snapshot(projectId: string): ReadonlyMap<number, Issue> | undefined {
    return this.byProject.get(projectId);
  }

  /** Whether the issue is currently recorded as blocked. */
  isRecorded(projectId: string, issueNumber: number): boolean {
    return this.byProject.get(projectId)?.has(issueNumber) ?? false;
  }

  /** Records (or refreshes) the issue's blocked snapshot and persists. */
  record(issue: Issue): void {
    const perProject = this.byProject.get(issue.projectId) ?? new Map<number, Issue>();
    perProject.set(issue.number, issue);
    this.byProject.set(issue.projectId, perProject);
    this.save();
  }

  /** Drops the issue's blocked record (no-op when absent) and persists. */
  remove(projectId: string, issueNumber: number): void {
    const perProject = this.byProject.get(projectId);
    if (perProject === undefined || !perProject.delete(issueNumber)) return;
    if (perProject.size === 0) this.byProject.delete(projectId);
    this.save();
  }

  /** Writes the whole map to the JSON file (atomic via {@link JsonStore}). */
  private save(): void {
    if (this.store === null) return;
    const projects = [...this.byProject].map(([projectId, issues]) => ({
      projectId,
      issues: [...issues.values()],
    }));
    this.store.save({ version: 1, projects });
  }

  /** Missing/corrupt file ⇒ empty map (safe degradation, not a crash). */
  private load(): void {
    if (this.store === null) return;
    const state = this.store.load((value) => {
      const parsed = persistedSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    }, { version: 1, projects: [] });
    for (const { projectId, issues } of state.projects) {
      this.byProject.set(projectId, new Map(issues.map((issue) => [issue.number, issue])));
    }
  }
}
