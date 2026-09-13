/**
 * Executes the actions derived from the reconciliation table: spawns pi
 * sessions into tmux, archives them, attaches PRs to workers, and delivers
 * single-line prompts into panes. Every action is independent — a failure
 * is logged and counted, never fatal. A watermark patch rides on its
 * delivery and is only written after the send succeeded, so a lost pane
 * retries next tick instead of swallowing the prompt. Every registry
 * mutation notifies the caller so the sessions hub can broadcast.
 */

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  errorMessage,
  type Project,
  type ProjectSettings,
  type Session,
} from "@pideck/shared";
import { statePaths } from "../store/stateDir.js";
import type { Persona } from "@pideck/shared";
import type { SessionPatch, SessionRegistry } from "../sessions/registry.js";
import {
  archiveSession,
  defaultGitRunner,
  refreshProjectClone,
  sessionRepoPath,
  spawnPiSession,
  type GitRunner,
  type SpawnPiOptions,
} from "../sessions/spawn.js";
import type { Tmux } from "../sessions/tmux.js";
import { spawnReviewer, spawnWorker, type PromptVars } from "../prompts/index.js";
import type { TraceEntry } from "@pideck/shared";
import type { Action } from "./desired.js";
import type { Trace } from "./trace.js";

/** Supplies persona system prompts (override or shipped, rendered) and models. */
export interface PromptSource {
  systemPrompt(persona: Persona, vars: PromptVars): string;
  model(persona: Persona): string | null;
}

export interface ApplyDeps {
  tmux: Tmux;
  registry: SessionRegistry;
  stateDir: string;
  prompts: PromptSource;
  git?: GitRunner;
  /** Called after the registry changes, so live views refresh immediately. */
  notifyChange?: () => void;
  /** Records an approved+green head after its notice was delivered. */
  markNotified?: (projectId: string | null, prNumber: number, headSha: string) => void;
  /** Records a stall notice after it was delivered, for once-per-silence. */
  markStallNotice?: (sessionId: string, at: string) => void;
  /** The per-session trace: deliveries, spawns, and archives land here. */
  trace: Trace;
  log: (line: string) => void;
}

export interface ApplyContext {
  project: Project | null;
  settings: ProjectSettings | null;
  /** Review-account token, injected as GH_TOKEN into reviewer panes. */
  reviewToken: { username: string; token: string } | null;
}

export interface Tally {
  spawned: number;
  archived: number;
  delivered: number;
  errors: number;
}

/** What an executed action contributes to the session's trace. */
interface TraceNote {
  sessionId: string;
  entry: Omit<TraceEntry, "at">;
}

export async function applyActions(
  deps: ApplyDeps,
  ctx: ApplyContext,
  actions: Action[],
  tally: Tally,
): Promise<void> {
  for (const action of actions) {
    try {
      const note = await applyAction(deps, ctx, action);
      if (note !== null) {
        deps.trace.append(note.sessionId, { at: new Date().toISOString(), ...note.entry });
      }
      if (
        action.kind === "spawn-global" ||
        action.kind === "spawn-orchestrator" ||
        action.kind === "spawn-worker" ||
        action.kind === "spawn-reviewer"
      ) {
        tally.spawned++;
      } else if (action.kind === "archive") {
        tally.archived++;
      } else if (action.kind === "deliver") {
        tally.delivered++;
      }
    } catch (err) {
      tally.errors++;
      deps.log(`reconciler: action ${action.kind} failed: ${errorMessage(err)}`);
    }
  }
}

async function applyAction(deps: ApplyDeps, ctx: ApplyContext, action: Action): Promise<TraceNote | null> {
  switch (action.kind) {
    case "spawn-global": {
      const session = await spawnPersona(deps, {
        persona: "global",
        projectId: null,
        cwd: deps.stateDir,
        systemPrompt: deps.prompts.systemPrompt("global", {
          SESSION_ID: PENDING_SESSION_ID,
        }),
        model: deps.prompts.model("global"),
      });
      return { sessionId: session.id, entry: { kind: "spawn", detail: "spawned global agent" } };
    }
    case "spawn-orchestrator": {
      if (ctx.project === null || ctx.settings === null) return null;
      const vars: PromptVars = {
        PROJECT_ID: ctx.project.id,
        PROJECT_NAME: ctx.project.name,
        REPO: `${ctx.project.owner}/${ctx.project.repo}`,
        DEFAULT_BRANCH: ctx.project.defaultBranch,
        PROJECT_PATH: ctx.project.path,
        AUTO_MERGE: String(ctx.settings.autoMerge),
        ORCHESTRATOR_SESSION_ID: PENDING_ORCHESTRATOR_SESSION_ID,
      };
      const session = await spawnPersona(deps, {
        persona: "orchestrator",
        projectId: ctx.project.id,
        cwd: ctx.project.path,
        systemPrompt: `${deps.prompts.systemPrompt("orchestrator", vars)}\n\n${action.briefing}`,
        model: deps.prompts.model("orchestrator"),
      });
      return {
        sessionId: session.id,
        entry: { kind: "spawn", detail: "spawned orchestrator with the briefing in its prompt" },
      };
    }
    case "spawn-worker": {
      if (ctx.project === null) return null;
      const branch = `pideck/issue-${action.issue.number}`;
      const session = await spawnPersona(deps, {
        persona: "worker",
        projectId: ctx.project.id,
        cwd: ctx.project.path,
        repoUrl: ctx.project.repoUrl,
        systemPrompt: deps.prompts.systemPrompt("worker", {
          ISSUE_NUMBER: String(action.issue.number),
          REPO: `${ctx.project.owner}/${ctx.project.repo}`,
          DEFAULT_BRANCH: ctx.project.defaultBranch,
          // Resolved to the session's own clone after the spawn — see
          // patchPromptFile. The project clone is never a worker's copy.
          PROJECT_PATH: PENDING_PROJECT_PATH,
          SESSION_ID: PENDING_SESSION_ID,
        }),
        model: deps.prompts.model("worker"),
        issueNumber: action.issue.number,
      });
      await deps.tmux.sendLine(
        session.tmuxSession,
        spawnWorker({ number: action.issue.number, title: action.issue.title, url: action.issue.url, branch }),
      );
      if (Object.keys(action.initial).length > 0) update(deps, session.id, action.initial);
      return {
        sessionId: session.id,
        entry: { kind: "spawn", detail: `spawned worker for issue #${action.issue.number}` },
      };
    }
    case "spawn-reviewer": {
      if (ctx.project === null) return null;
      if (ctx.reviewToken === null) throw new Error("no review account: the review leg is off");
      const session = await spawnPersona(deps, {
        persona: "reviewer",
        projectId: ctx.project.id,
        cwd: ctx.project.path,
        repoUrl: ctx.project.repoUrl,
        systemPrompt: deps.prompts.systemPrompt("reviewer", {
          PR_NUMBER: String(action.pr.number),
          REPO: `${ctx.project.owner}/${ctx.project.repo}`,
          DEFAULT_BRANCH: ctx.project.defaultBranch,
          PROJECT_PATH: PENDING_PROJECT_PATH,
          SESSION_ID: PENDING_SESSION_ID,
        }),
        model: deps.prompts.model("reviewer"),
        prNumber: action.pr.number,
        env: { GH_TOKEN: ctx.reviewToken.token },
      });
      await deps.tmux.sendLine(
        session.tmuxSession,
        spawnReviewer({ prNumber: action.pr.number, repo: `${ctx.project.owner}/${ctx.project.repo}` }),
      );
      if (Object.keys(action.initial).length > 0) update(deps, session.id, action.initial);
      return {
        sessionId: session.id,
        entry: { kind: "spawn", detail: `spawned reviewer for PR #${action.pr.number}` },
      };
    }
    case "attach-pr":
      update(deps, action.session.id, { prNumber: action.prNumber });
      return null;
    case "archive":
      await archiveSession(
        { tmux: deps.tmux, registry: deps.registry, stateDir: deps.stateDir },
        action.session,
      );
      // A worker is archived exactly when its issue/PR closes — the moment
      // main may have moved. Bring the orchestrator's clone up before it
      // looks again; failures are logged and never forced.
      if (action.session.persona === "worker" && ctx.project !== null) {
        await refreshProjectClone(
          deps.git ?? defaultGitRunner(),
          ctx.project.path,
          deps.log,
        );
      }
      deps.notifyChange?.();
      return { sessionId: action.session.id, entry: { kind: "archive", detail: action.reason } };
    case "deliver":
      await deps.tmux.sendLine(action.target.tmuxSession, action.text);
      if (action.watermark) update(deps, action.watermark.sessionId, action.watermark.patch);
      if (action.approvedGreenHead) {
        deps.markNotified?.(action.target.projectId, action.approvedGreenHead.prNumber, action.approvedGreenHead.headSha);
      }
      if (action.stallNotice) {
        deps.markStallNotice?.(action.stallNotice.sessionId, action.stallNotice.at);
      }
      return {
        sessionId: action.target.id,
        entry: {
          kind: "delivery",
          text: action.text,
          ...(action.watermark ? { watermark: { ...action.watermark.patch } } : {}),
        },
      };
    case "watermarks":
      update(deps, action.sessionId, action.patch);
      return null;
  }
}

const PENDING_SESSION_ID = "{{SESSION_ID}}";
const PENDING_ORCHESTRATOR_SESSION_ID = "{{ORCHESTRATOR_SESSION_ID}}";
const PENDING_PROJECT_PATH = "{{PROJECT_PATH}}";

/**
 * Spawns the session, then patches the session id into its system prompt.
 * The id only exists once spawnPiSession returns, but pi has already been
 * pointed at the prompt file — so the file is rewritten atomically with the
 * real value the moment spawn returns, before pi reads it. The worker and
 * reviewer working copy is patched the same way: {{PROJECT_PATH}} must name
 * the session's own clone, not the shared project clone agents could cd into.
 */
async function spawnPersona(deps: ApplyDeps, options: SpawnPiOptions): Promise<Session> {
  const promptText = options.systemPrompt;
  const session = await spawnPiSession(
    { tmux: deps.tmux, registry: deps.registry, stateDir: deps.stateDir, git: deps.git, log: deps.log },
    options,
  );
  deps.notifyChange?.();
  const projectPath =
    options.persona === "worker" || options.persona === "reviewer"
      ? sessionRepoPath(deps.stateDir, session.id)
      : options.cwd;
  patchPromptFile(deps.stateDir, session.id, promptText, projectPath);
  return session;
}

function patchPromptFile(
  stateDir: string,
  sessionId: string,
  promptText: string,
  projectPath: string,
): void {
  const patched = promptText
    .replaceAll(PENDING_SESSION_ID, sessionId)
    .replaceAll(PENDING_ORCHESTRATOR_SESSION_ID, sessionId)
    .replaceAll(PENDING_PROJECT_PATH, projectPath);
  if (patched === promptText) return;
  const file = join(statePaths(stateDir).systemPromptsDir, `${sessionId}.md`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, patched, "utf8");
  renameSync(tmp, file);
}

function update(deps: ApplyDeps, sessionId: string, patch: SessionPatch): void {
  deps.registry.update(sessionId, patch);
  deps.notifyChange?.();
}

