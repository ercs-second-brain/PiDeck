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
 * - agent-kind sessions (never worker records) and other worker-less
 *   sessions route through the `SessionManager.killSession` path: pane
 *   killed, session record removed from the registry (the removed session
 *   is the response), any attached worker marked `stopped`. They keep no
 *   archived log — a delivered report stays where it was sent.
 */

import type { Session } from "@pideck/shared";

import type { Router } from "./router.js";
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
      after = await services.sessions.killSession(session.id);
    }
    return { body: after };
  });
}
