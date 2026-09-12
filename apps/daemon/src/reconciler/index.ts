/**
 * The reconciler loop: every poll is a reconciliation. Per tick: ensure the
 * global session, then for every project read GitHub once, derive desired
 * state, and close the gap; finally re-check tmux and archive panes that
 * died (their replacements are derived by the next tick's table). An error
 * in one project never stops the others; each tick ends with a one-line
 * summary. There is no event pipeline and no restart path — a restart is
 * just the first poll.
 */

import type { Project } from "@pideck/shared";
import { GhClient } from "../github/client.js";
import { GhRateLimited } from "../github/error.js";
import type { GhComment, GhIssue, GhPr, GhReview } from "../github/schemas.js";
import { ensureReviewAccess, type ReviewAccessGh } from "../github/reviewAccess.js";
import type { Probe } from "@pideck/shared";
import type { GlobalSettingsStore } from "../store/globalSettingsStore.js";
import type { ProjectStore } from "../store/projectStore.js";
import { contextPercent } from "../sessions/context.js";
import type { GitRunner } from "../sessions/spawn.js";
import type { SessionRegistry } from "../sessions/registry.js";
import { reconcileWithTmux } from "../sessions/spawn.js";
import type { Tmux } from "../sessions/tmux.js";
import type { PromptOverrides } from "../prompts/overrides.js";
import { loadShippedPrompt, renderPrompt } from "../prompts/index.js";
import { applyActions, type ApplyDeps, type PromptSource, type Tally } from "./apply.js";
import { Trace } from "./trace.js";
import {
  deriveActions,
  deriveGlobalAction,
  orchestratorAction,
  type Action,
} from "./desired.js";
import { ProjectReader, type ProjectFacts } from "./read.js";

export { deriveState, type SessionStateFacts } from "./state.js";
export { type ProjectFacts } from "./read.js";

/** The slice of the GitHub client the reconciler reads through. */
export interface GhClientLike {
  openIssues(): Promise<GhIssue[]>;
  blockedBy(issueNumber: number): Promise<{ number: number; state: "open" | "closed" }[]>;
  issueComments(issueNumber: number, sinceId?: number): Promise<GhComment[]>;
  openPrs(): Promise<GhPr[]>;
  prReviews(prNumber: number): Promise<GhReview[]>;
  prReviewComments(prNumber: number, sinceId?: number): Promise<GhComment[]>;
  authStatus(): Promise<Probe>;
  /** Invites a collaborator with push, run as the primary account. */
  inviteCollaborator(login: string): Promise<void>;
}

/**
 * Everything the reconciler needs, injectable so tests can assemble an
 * in-memory loop. Constructible from the daemon's shared deps plus a
 * GitHub client factory.
 */
export interface ReconcilerDeps {
  /** Builds the GitHub client for one `owner/repo` (the primary account). */
  gh: (repo: string) => GhClientLike;
  /** Builds the review-account client for one `owner/repo`; defaults to a
   * real client carrying the configured review token. */
  ghReview?: (repo: string) => Pick<ReviewAccessGh, "hasReadAccess" | "acceptInvitations">;
  projects: ProjectStore;
  settings: GlobalSettingsStore;
  registry: SessionRegistry;
  tmux: Tmux;
  prompts: PromptOverrides;
  stateDir: string;
  /** Poll interval in milliseconds (default 30 s). */
  intervalMs?: number;
  git?: GitRunner;
  /** The per-session trace writer; one instance is shared with the API layer. */
  trace: Trace;
  /** Called after the registry changes, so live views refresh immediately. */
  notifyChange?: () => void;
  log?: (line: string) => void;
}
export interface ReconcilerHandle {
  stop(): void;
  tick(): Promise<void>;
  /** The last successful GitHub read pass for a project; null before the first. */
  factsFor(projectId: string): ProjectFacts | null;
  /** GitHub throttling/error state for Status. */
  githubStatus(): { throttledUntil: string | null; lastError: string | null };
}

const DEFAULT_INTERVAL_MS = 30_000;
/** Per-project retry ladder for failed ticks, indexed by consecutive failures. */
const BACKOFF_LADDER_MS = [30_000, 60_000, 120_000, 300_000];

interface TickBackoff {
  failures: number;
  /** Earliest wall-clock time (ms) the project's next tick may run. */
  nextAttemptAt: number;
  /** Known GitHub rate-limit reset (ms); the project waits until it passes. */
  throttledUntil: number | null;
}

export function startReconciler(deps: ReconcilerDeps): ReconcilerHandle {
  const log = deps.log ?? ((line: string) => console.log(line));
  const readers = new Map<string, ProjectReader>();
  const notifiedHeadsByProject = new Map<string, Map<number, string>>();
  const stallNotices = new Map<string, string>();
  const prompts = overridesPromptSource(deps.prompts, deps.settings);
  const applyDeps: ApplyDeps = {
    tmux: deps.tmux,
    registry: deps.registry,
    stateDir: deps.stateDir,
    prompts,
    git: deps.git,
    trace: deps.trace,
    notifyChange: deps.notifyChange,
    markNotified: (projectId, prNumber, headSha) => {
      notifiedHeadsFor(projectId ?? "").set(prNumber, headSha);
    },
    markStallNotice: (sessionId, at) => {
      stallNotices.set(sessionId, at);
    },
    log,
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let queue: Promise<void> = Promise.resolve();
  const factsByProject = new Map<string, ProjectFacts>();
  const backoffByProject = new Map<string, TickBackoff>();
  let lastGithubError: string | null = null;

  function readerFor(project: Project): ProjectReader {
    let reader = readers.get(project.id);
    if (reader === undefined) {
      reader = new ProjectReader(deps.gh(`${project.owner}/${project.repo}`), log);
      readers.set(project.id, reader);
    }
    return reader;
  }

  function notifiedHeadsFor(projectId: string): Map<number, string> {
    let heads = notifiedHeadsByProject.get(projectId);
    if (heads === undefined) {
      heads = new Map();
      notifiedHeadsByProject.set(projectId, heads);
    }
    return heads;
  }

  function projectOrNull(projectId: string | null): Project | null {
    if (projectId === null) return null;
    try {
      return deps.projects.get(projectId);
    } catch {
      return null;
    }
  }

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function runTick(): Promise<void> {
    const startedAt = Date.now();
    const tally: Tally = { spawned: 0, archived: 0, delivered: 0, errors: 0 };
    const registry = deps.registry;
    const reviewToken = deps.settings.reviewToken();
    const reviewLogin = reviewToken?.username ?? null;
    const reviewGhFor =
      deps.ghReview ?? ((repo: string) => new GhClient({ repo, token: reviewToken?.token }));
    if (reviewToken === null) {
      log("reconciler: no review account — the review leg is off");
    }

    // Memory keyed on sessions and projects that no longer exist cannot come
    // back — drop it so the maps stay bounded. The global session keeps its
    // approved heads under "".
    const liveIds = new Set(registry.list({ archived: false }).map((s) => s.id));
    for (const id of [...stallNotices.keys()]) {
      if (!liveIds.has(id)) stallNotices.delete(id);
    }
    const projectIds = new Set([...deps.projects.list().map((p) => p.id), ""]);
    for (const id of [...notifiedHeadsByProject.keys()]) {
      if (!projectIds.has(id)) notifiedHeadsByProject.delete(id);
    }
    for (const id of [...backoffByProject.keys()]) {
      if (!projectIds.has(id)) backoffByProject.delete(id);
    }

    try {
      const globalAction = deriveGlobalAction(registry.list({ archived: false }));
      await applyActions(
        applyDeps,
        { project: null, settings: null, reviewToken },
        globalAction === null ? [] : [globalAction],
        tally,
      );
    } catch (err) {
      tally.errors++;
      log(`reconciler: global session failed: ${errorMessage(err)}`);
    }

    let sawProjectError = false;
    for (const project of deps.projects.list()) {
      const backoff = backoffByProject.get(project.id) ?? {
        failures: 0,
        nextAttemptAt: 0,
        throttledUntil: null,
      };
      backoffByProject.set(project.id, backoff);
      if (backoff.nextAttemptAt > Date.now() || (backoff.throttledUntil ?? 0) > Date.now()) continue;
      try {
        const repo = `${project.owner}/${project.repo}`;
        const access = await ensureReviewAccess({
          primary: deps.gh(repo),
          review: reviewGhFor(repo),
          reviewLogin,
          repo,
        });
        if (!access.ok) {
          log(`reconciler: ${access.detail} — no reviewer will run`);
        }
        const facts = await readerFor(project).read();
        const projectFacts = access.ok ? facts : { ...facts, reviewAccess: access.detail };
        factsByProject.set(project.id, projectFacts);
        const live = registry.list({ projectId: project.id, archived: false });
        const settings = deps.projects.settings(project.id);
        const context = new Map(
          live.map((s) => [s.id, contextPercent(s, { stateDir: deps.stateDir })]),
        );
        const deriveInput = {
          project,
          settings,
          facts: projectFacts,
          live,
          context,
          reviewLogin,
          now: new Date(),
        };
        const actions: Action[] = [];
        const orchestrator = orchestratorAction(deriveInput);
        if (orchestrator !== null) actions.push(orchestrator);
        actions.push(
          ...deriveActions({
            ...deriveInput,
            notifiedHeads: notifiedHeadsFor(project.id),
            stallNotices,
          }),
        );
        await applyActions(applyDeps, { project, settings, reviewToken }, actions, tally);
        backoff.failures = 0;
        backoff.nextAttemptAt = 0;
        backoff.throttledUntil = null;
      } catch (err) {
        sawProjectError = true;
        backoff.failures++;
        const delay = BACKOFF_LADDER_MS[Math.min(backoff.failures, BACKOFF_LADDER_MS.length) - 1];
        backoff.nextAttemptAt = Date.now() + (delay ?? BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1]!);
        if (err instanceof GhRateLimited) {
          backoff.throttledUntil = err.resetAt?.getTime() ?? backoff.nextAttemptAt;
        }
        lastGithubError = errorMessage(err);
        tally.errors++;
        log(`reconciler: project ${project.name}: ${errorMessage(err)}`);
      }
    }
    if (!sawProjectError) lastGithubError = null;

    try {
      const { dead, orphanTmuxSessions } = await reconcileWithTmux(registry, deps.tmux, {
        stateDir: deps.stateDir,
        log,
      });
      for (const session of dead) {
        await applyActions(
          applyDeps,
          { project: projectOrNull(session.projectId), settings: null, reviewToken },
          [{ kind: "archive", session, reason: "pane gone" }],
          tally,
        );
      }
      if (orphanTmuxSessions.length > 0) {
        log(`reconciler: archived ${orphanTmuxSessions.length} orphan pane(s)`);
      }
    } catch (err) {
      tally.errors++;
      log(`reconciler: tmux reconciliation failed: ${errorMessage(err)}`);
    }

    log(
      `reconciler: ${deps.projects.list().length} projects, ${tally.spawned} spawned, ` +
        `${tally.archived} archived, ${tally.delivered} delivered, ${tally.errors} errors ` +
        `(${Date.now() - startedAt}ms)`,
    );
  }

  function tick(): Promise<void> {
    const next = queue.then(runTick, runTick);
    queue = next.catch(() => {});
    return next;
  }

  timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);

  return {
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tick,
    /** The last successful GitHub read pass for a project, for live views. */
    factsFor(projectId: string): ProjectFacts | null {
      return factsByProject.get(projectId) ?? null;
    },
    /** The furthest known throttle reset across projects, plus the last error. */
    githubStatus(): { throttledUntil: string | null; lastError: string | null } {
      const now = Date.now();
      let throttledUntil: number | null = null;
      for (const state of backoffByProject.values()) {
        if (state.throttledUntil !== null && state.throttledUntil > now) {
          throttledUntil = Math.max(throttledUntil ?? 0, state.throttledUntil);
        }
      }
      return {
        throttledUntil: throttledUntil === null ? null : new Date(throttledUntil).toISOString(),
        lastError: lastGithubError,
      };
    },
  };
}

/** Persona prompts from the overrides store, falling back to shipped files. */
function overridesPromptSource(prompts: PromptOverrides, settings: GlobalSettingsStore): PromptSource {
  return {
    systemPrompt(persona, vars) {
      const text = prompts.get(persona) ?? loadShippedPrompt(persona);
      return renderPrompt(text, vars);
    },
    model(persona) {
      return settings.read().modelByPersona[persona] ?? null;
    },
  };
}
