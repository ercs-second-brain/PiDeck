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
import type { GhComment, GhIssue, GhPr, GhReview } from "../github/schemas.js";
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
import {
  deriveActions,
  deriveGlobalAction,
  orchestratorAction,
  type Action,
} from "./desired.js";
import { ProjectReader } from "./read.js";

export { deriveState, type SessionStateFacts } from "./state.js";
export { ProjectReader, type ProjectFacts } from "./read.js";
export {
  deriveActions,
  deriveGlobalAction,
  orchestratorAction,
  type Action,
  type DeriveInput,
} from "./desired.js";
export { applyActions, type ApplyDeps, type PromptSource } from "./apply.js";

/** The slice of the GitHub client the reconciler reads through. */
export interface GhClientLike {
  openIssues(): Promise<GhIssue[]>;
  blockedBy(issueNumber: number): Promise<{ number: number; state: "open" | "closed" }[]>;
  issueComments(issueNumber: number, sinceId?: number): Promise<GhComment[]>;
  openPrs(): Promise<GhPr[]>;
  prReviews(prNumber: number): Promise<GhReview[]>;
  prReviewComments(prNumber: number, sinceId?: number): Promise<GhComment[]>;
  authStatus(): Promise<Probe>;
}

/**
 * Everything the reconciler needs, injectable so tests can assemble an
 * in-memory loop. Constructible from the daemon's shared deps plus a
 * GitHub client factory.
 */
export interface ReconcilerDeps {
  /** Builds the GitHub client for one `owner/repo`. */
  gh: (repo: string) => GhClientLike;
  projects: ProjectStore;
  settings: GlobalSettingsStore;
  registry: SessionRegistry;
  tmux: Tmux;
  prompts: PromptOverrides;
  stateDir: string;
  /** Poll interval in milliseconds (default 30 s). */
  intervalMs?: number;
  git?: GitRunner;
  /** Called after the registry changes, so live views refresh immediately. */
  notifyChange?: () => void;
  log?: (line: string) => void;
}
export interface ReconcilerHandle {
  stop(): void;
  tick(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function startReconciler(deps: ReconcilerDeps): ReconcilerHandle {
  const log = deps.log ?? ((line: string) => console.log(line));
  const readers = new Map<string, ProjectReader>();
  const notifiedHeadsByProject = new Map<string, Map<number, string>>();
  const prompts = overridesPromptSource(deps.prompts, deps.settings);
  const applyDeps: ApplyDeps = {
    tmux: deps.tmux,
    registry: deps.registry,
    stateDir: deps.stateDir,
    prompts,
    git: deps.git,
    notifyChange: deps.notifyChange,
    markNotified: (projectId, prNumber, headSha) => {
      notifiedHeadsFor(projectId ?? "").set(prNumber, headSha);
    },
    log,
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let queue: Promise<void> = Promise.resolve();

  function readerFor(project: Project): ProjectReader {
    let reader = readers.get(project.id);
    if (reader === undefined) {
      reader = new ProjectReader(deps.gh(`${project.owner}/${project.repo}`));
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

    for (const project of deps.projects.list()) {
      try {
        const facts = await readerFor(project).read();
        const live = registry.list({ projectId: project.id, archived: false });
        const settings = deps.projects.settings(project.id);
        const context = new Map(
          live.map((s) => [s.id, contextPercent(s, { stateDir: deps.stateDir })]),
        );
        const deriveInput = { project, settings, facts, live, context, now: new Date() };
        const actions: Action[] = [];
        const orchestrator = orchestratorAction(deriveInput);
        if (orchestrator !== null) actions.push(orchestrator);
        actions.push(...deriveActions({ ...deriveInput, notifiedHeads: notifiedHeadsFor(project.id) }));
        await applyActions(applyDeps, { project, settings, reviewToken }, actions, tally);
      } catch (err) {
        tally.errors++;
        log(`reconciler: project ${project.name}: ${errorMessage(err)}`);
      }
    }

    try {
      const { dead } = await reconcileWithTmux(registry, deps.tmux);
      for (const session of dead) {
        await applyActions(
          applyDeps,
          { project: projectOrNull(session.projectId), settings: null, reviewToken },
          [{ kind: "archive", session, reason: "pane gone" }],
          tally,
        );
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
