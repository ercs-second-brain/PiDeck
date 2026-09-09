/**
 * Session-id terminate route (issue #317): `POST /api/sessions/:sessionId/
 * terminate`. The webapp's agent-kind ✕ affordance (#311) targets the
 * session id, but the terminate route family predated agent kinds and only
 * resolved worker ids (`/api/workers/:workerId/terminate`) — persona
 * spawns got a 404 no-route and could not be exited or removed.
 *
 * Shape-contracted route (like `/api/gh-auth`): mounted here, not in the
 * shared `endpoints` map — the webapp sends it raw (`apiTerminateAgentSession`)
 * and parses the body with `sessionSchema`.
 *
 * Routing per resolved session:
 * - worker-backed sessions delegate to the #64 terminate handler, so the
 *   archived status, scrollback capture, and hub announce are identical no
 *   matter which path a caller takes; the registry records are kept for
 *   history, so the session shape survives;
 * - agent-kind sessions (persona agents, never worker records) are
 *   **archived** (issue #357 B9): pane killed, scrollback captured, the
 *   registry record kept with `Session.archivedAt` — the archived session
 *   is the response. Deleting a parent persona agent archives its live
 *   descendant persona agents with it (issue #357 B10);
 * - other worker-less sessions route through the `SessionManager.
 *   killSession` path: pane killed, session record removed from the
 *   registry (the removed session is the response), any attached worker
 *   marked `stopped`.
 *
 * `GET /api/sessions/:sessionId/log` serves an archived persona agent's
 * captured log (issue #357 B9 — the worker-log route family's #104
 * pattern): 404 for unknown sessions and for sessions that are not
 * archived persona agents (a live persona agent has no archived log yet;
 * a worker session's log is `/api/workers/:workerId/log`).
 */

import { archivedAgentSessionLogSchema, type Session } from "@pideck/shared";

import { Router } from "./router.js";
import { HttpError } from "./router.js";
import { requireOr404, terminateWorkerPayload } from "./handlers.js";
import type { DaemonServices } from "./context.js";

/** Mounts `POST /api/sessions/:sessionId/terminate` on the router (issue #317). */
export function registerSessionTerminateRoute(router: Router, services: DaemonServices): void {
  router.add("POST", "/api/sessions/:sessionId/terminate", async ({ params }) => {
    const sessionId = params["sessionId"] as string;
    const session = requireOr404(
      services.sessions.getSession(sessionId),
      `unknown session: ${sessionId}`,
    );
    let after: Session | null | undefined;
    if (session.workerId !== null) {
      await terminateWorkerPayload(services, session.workerId);
      after = services.sessions.getSession(session.id);
    } else {
      // Persona agents archive (issue #357 B9) instead of hard-deleting;
      // every other worker-less session keeps the #317 kill semantics.
      after = await services.sessions.archiveAgentSession(session.id);
    }
    return { body: after };
  });

  /** Archived persona-agent log (issue #357 B9): 404 unknown / not archived. */
  router.add("GET", "/api/sessions/:sessionId/log", ({ params }) => {
    const sessionId = params["sessionId"] as string;
    const session = requireOr404(services.sessions.getSession(sessionId), `unknown session: ${sessionId}`);
    if (session.agentKind === undefined || session.archivedAt === undefined) {
      throw new HttpError(404, `session ${sessionId} has no archived log — persona agents log to the archive only after termination`);
    }
    const captured = services.sessions.archivedAgentScrollback(session.id);
    return {
      body: archivedAgentSessionLogSchema.parse({
        sessionId: session.id,
        projectId: session.projectId,
        agentKind: session.agentKind,
        name: session.name ?? null,
        createdAt: session.createdAt,
        archivedAt: session.archivedAt,
        capturedAt: captured?.capturedAt ?? null,
        scrollback: captured?.scrollback ?? "",
      }),
    };
  });
}
