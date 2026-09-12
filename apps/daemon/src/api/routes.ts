import {
  PersonaSchema,
  type GlobalSettingsPut,
  type Persona,
  type Project,
  type ProjectCreate,
  type ProjectSettings,
  type ProjectUpdate,
  type Prompt,
  type PromptPut,
  type Session,
  type SessionSend,
} from "@pideck/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadShippedPrompt } from "../prompts/shipped.js";
import { archiveSession } from "../sessions/spawn.js";
import type { DaemonDeps } from "./deps.js";
import { ApiError, type ApiHandlers } from "./router.js";
import { sessionViews } from "./views.js";

/**
 * Handlers for every REST endpoint in the shared map. Bodies arrive already
 * validated against the endpoint's request schema, and the router re-checks
 * every response against the response schema — handlers only shape data.
 * `updateCheck`/`updateApply` have no handler yet, so they answer 501.
 */
export function buildApiHandlers(deps: DaemonDeps): ApiHandlers {
  return {
    status: async () => {
      const [pi, gh] = await Promise.all([deps.pi(), deps.ghPrimary()]);
      return {
        version: deps.version,
        stateDir: deps.stateDir,
        pollIntervalSeconds: deps.pollIntervalSeconds,
        piReady: pi.ok,
        ghReady: gh.ok,
      };
    },

    projectList: () => deps.projects.list(),
    projectCreate: ({ body }) => deps.projects.add(body as ProjectCreate),

    projectGet: ({ params }) => projectOr404(deps, params.id!),
    projectUpdate: ({ params, body }) =>
      notFound(() => deps.projects.update(params.id!, body as ProjectUpdate)),
    projectDelete: ({ params }) => {
      notFound(() => deps.projects.remove(params.id!));
      return { ok: true };
    },

    projectSettingsGet: ({ params }) => notFound(() => deps.projects.settings(params.id!)),
    projectSettingsPut: ({ params, body }) =>
      notFound(() => deps.projects.updateSettings(params.id!, body as Partial<ProjectSettings>)),

    sessionList: () => sessionViews(deps.registry.list(), deps),
    projectSessionList: ({ params }) => {
      notFound(() => deps.projects.get(params.id!));
      return sessionViews(deps.registry.list({ projectId: params.id! }), deps);
    },

    sessionSend: async ({ params, body }) => {
      const session = sessionOr404(deps, params.id!);
      if (session.archivedAt !== undefined) throw new ApiError(409, "session is archived");
      try {
        await deps.tmux.sendLine(session.tmuxSession, (body as SessionSend).text);
      } catch (err) {
        throw new ApiError(409, `tmux session is gone: ${errMessage(err)}`);
      }
      return { ok: true };
    },

    sessionTerminate: async ({ params }) => {
      const session = sessionOr404(deps, params.id!);
      await archiveSession(
        {
          tmux: deps.tmux,
          registry: deps.registry,
          stateDir: deps.stateDir,
          cloneDir: cloneDirOf(deps, session),
        },
        session,
      );
      deps.notifyChange?.();
      return { ok: true };
    },

    sessionLog: ({ params }) => {
      const session = sessionOr404(deps, params.id!);
      const file = join(deps.stateDir, "logs", `${session.id}.log`);
      if (!existsSync(file)) throw new ApiError(404, "no archived log for this session");
      return { log: readFileSync(file, "utf8") };
    },

    globalSettingsGet: () => deps.settings.read(),
    globalSettingsPut: ({ body }) => {
      deps.settings.put(body as GlobalSettingsPut);
      return deps.settings.read();
    },

    promptGet: ({ params }) => promptView(deps, personaOr404(params)),
    promptPut: ({ params, body }) => {
      const persona = personaOr404(params);
      deps.prompts.set(persona, (body as PromptPut).prompt);
      return promptView(deps, persona);
    },
    promptReset: ({ params }) => {
      const persona = personaOr404(params);
      deps.prompts.reset(persona);
      return promptView(deps, persona);
    },

    probePi: () => deps.pi(),
    probeGhPrimary: () => deps.ghPrimary(),
    probeGhReview: () => deps.ghReview(),
  };
}

function sessionOr404(deps: DaemonDeps, id: string): Session {
  const session = deps.registry.get(id);
  if (!session) throw new ApiError(404, `unknown session: ${id}`);
  return session;
}

function projectOr404(deps: DaemonDeps, id: string): Project {
  return notFound(() => deps.projects.get(id));
}

function personaOr404(params: Record<string, string>): Persona {
  const parsed = PersonaSchema.safeParse(params.persona);
  if (!parsed.success) throw new ApiError(404, `unknown persona: ${params.persona}`);
  return parsed.data;
}

function promptView(deps: DaemonDeps, persona: Persona): Prompt {
  const override = deps.prompts.get(persona);
  return {
    persona,
    prompt: override ?? loadShippedPrompt(persona),
    edited: override !== null,
  };
}

function cloneDirOf(deps: DaemonDeps, session: Session): string | null {
  if (session.projectId === null) return null;
  try {
    return deps.projects.get(session.projectId).path;
  } catch {
    return null;
  }
}

/** Maps store errors ("unknown project/session: …") onto 404. */
function notFound<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && /^unknown (project|session)/.test(err.message)) {
      throw new ApiError(404, err.message);
    }
    throw err;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}