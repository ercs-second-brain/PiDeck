import {
  PersonaSchema,
  errorMessage,
  type GlobalSettingsPut,
  type Persona,
  type Project,
  type ProjectCreate,
  type ProjectSettings,
  type Prompt,
  type PromptPut,
  type Session,
  type SessionLabel,
  type SessionSend,
} from "@pideck/shared";
import { existsSync, readFileSync } from "node:fs";
import { statePaths } from "../store/stateDir.js";
import { join } from "node:path";
import { loadShippedPrompt } from "../prompts/shipped.js";
import { readTranscript } from "../sessions/transcript.js";
import { archiveSession } from "../sessions/spawn.js";
import type { DaemonDeps } from "./deps.js";
import { ApiError, type ApiHandlers } from "./router.js";
import { sessionViews } from "./views.js";

/**
 * Handlers for every REST endpoint in the shared map. Bodies arrive already
 * validated against the endpoint's request schema, and the router re-checks
 * every response against the response schema — handlers only shape data.
 */
export function buildApiHandlers(deps: DaemonDeps): ApiHandlers {
  // /api/status probes shell out (pi, gh); the header and `pideck status` poll
  // it, so each probe result is cached for a short window.
  const probeCache = new Map<string, { at: number; value: Promise<unknown> }>();
  const cachedProbe = <T>(key: string, probe: () => Promise<T>): Promise<T> => {
    const hit = probeCache.get(key);
    const now = Date.now();
    if (hit !== undefined && now - hit.at < PROBE_CACHE_MS) return hit.value as Promise<T>;
    const value = probe().catch((err) => {
      probeCache.delete(key);
      throw err;
    });
    probeCache.set(key, { at: now, value });
    return value;
  };

  return {
    status: async () => {
      const [pi, gh] = await Promise.all([cachedProbe("pi", deps.pi), cachedProbe("gh", deps.ghPrimary)]);
      return {
        version: deps.version,
        stateDir: deps.stateDir,
        pollIntervalSeconds: deps.pollIntervalSeconds,
        piReady: pi.ok,
        ghReady: gh.ok,
        github: deps.githubStatus?.() ?? { throttledUntil: null, lastError: null },
      };
    },

    projectList: () => deps.projects.list(),
    projectCreate: ({ body }) => {
      const project = deps.projects.add(body as ProjectCreate);
      deps.notifyChange?.();
      return project;
    },

    projectGet: ({ params }) => projectOr404(deps, params.id!),
    projectDelete: ({ params }) => {
      notFound(() => deps.projects.remove(params.id!));
      deps.notifyChange?.();
      return { ok: true };
    },

    projectSettingsGet: ({ params }) => notFound(() => deps.projects.settings(params.id!)),
    projectSettingsPut: ({ params, body }) => {
      const settings = notFound(() =>
        deps.projects.updateSettings(params.id!, body as Partial<ProjectSettings>),
      );
      deps.notifyChange?.();
      return settings;
    },

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
        throw new ApiError(409, `tmux session is gone: ${errorMessage(err)}`);
      }
      return { ok: true };
    },

    sessionLabel: ({ params, body }) => {
      const session = sessionOr404(deps, params.id!);
      return sessionViews([deps.registry.update(session.id, { label: (body as SessionLabel).label })], deps)[0];
    },

    sessionTerminate: async ({ params }) => {
      const session = sessionOr404(deps, params.id!);
      await archiveSession(
        { tmux: deps.tmux, registry: deps.registry, stateDir: deps.stateDir },
        session,
      );
      deps.notifyChange?.();
      return { ok: true };
    },

    sessionLog: ({ params }) => {
      const session = sessionOr404(deps, params.id!);
      const file = join(statePaths(deps.stateDir).logsDir, `${session.id}.log`);
      if (!existsSync(file)) throw new ApiError(404, "no archived log for this session");
      return { log: readFileSync(file, "utf8") };
    },

    sessionTrace: ({ params }) => {
      const session = sessionOr404(deps, params.id!);
      return {
        entries: deps.trace.read(session.id),
        transcriptPath: deps.trace.transcriptPath(session.id),
      };
    },

    sessionTranscript: ({ params }) =>
      readTranscript(deps.stateDir, sessionOr404(deps, params.id!).id),

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

    reviewLoginStart: () => deps.reviewLogin.start(),
    reviewLoginStatus: () => deps.reviewLogin.status(),

    updateCheck: () => deps.updates.check(),
    updateApply: () => deps.updates.apply(),
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

const PROBE_CACHE_MS = 30_000;