/**
 * Agent-kind registry CRUD (registry v2, issue #330, docs/agent-kinds.md):
 * the handlers behind `GET/POST /api/agent-kinds` and
 * `PUT/DELETE /api/agent-kinds/:kind`.
 *
 * Guardrails (the issue's contract):
 * - shipped kinds are immutable and undeletable — their specs ship as
 *   spec-v2 data with the product; their personas are user-editable via
 *   the agent-assets prompt overrides (issue #315) instead;
 * - a kind with live sessions cannot be deleted (terminate them first) —
 *   the sessions keep working; a deleted kind only stops future spawns;
 * - edits affect future spawns (and relaunched panes, like every persona
 *   asset — the launch paths re-render from the current spec), never a
 *   running pane's conversation.
 */

import { HttpError } from "./router.js";
import type { DaemonServices } from "./context.js";
import type { EndpointRegistry } from "./handlers.js";

/**
 * The agent-kind CRUD handlers (registry v2). Extracted so
 * `contractHandlers` stays within its line budget (the agent-assets
 * pattern, issue #315).
 */
export function agentKindHandlers(services: DaemonServices): Pick<EndpointRegistry, "listAgentKinds" | "createAgentKind" | "updateAgentKind" | "deleteAgentKind"> {
  return {
    listAgentKinds: () => ({ kinds: services.agentKinds.list() }),

    createAgentKind: ({ body }) => {
      if (services.agentKinds.get(body.name) !== undefined) {
        throw new HttpError(
          409,
          services.agentKinds.isShipped(body.name)
            ? `agent kind "${body.name}" is shipped — shipped kinds are immutable`
            : `agent kind "${body.name}" already exists`,
        );
      }
      return services.agentKindStore.save(body);
    },

    updateAgentKind: ({ params, body }) => {
      if (services.agentKinds.isShipped(params.kind)) {
        throw new HttpError(
          409,
          `agent kind "${params.kind}" is shipped — shipped kinds are immutable; edit its persona via agent-assets prompt overrides`,
        );
      }
      if (services.agentKinds.get(params.kind) === undefined) {
        throw new HttpError(404, `unknown agent kind: ${params.kind}`);
      }
      if (body.name !== params.kind) {
        throw new HttpError(400, `body name "${body.name}" must match the URL kind "${params.kind}" (kind ids are immutable)`);
      }
      return services.agentKindStore.save(body);
    },

    deleteAgentKind: ({ params }) => {
      if (services.agentKinds.isShipped(params.kind)) {
        throw new HttpError(409, `agent kind "${params.kind}" is shipped — shipped kinds cannot be deleted`);
      }
      if (services.agentKinds.get(params.kind) === undefined) {
        throw new HttpError(404, `unknown agent kind: ${params.kind}`);
      }
      const live = services.registry.listSessions().filter((session) => session.agentKind === params.kind);
      if (live.length > 0) {
        throw new HttpError(
          409,
          `agent kind "${params.kind}" has ${live.length} live session(s) — terminate them before deleting the kind`,
        );
      }
      services.agentKindStore.delete(params.kind);
      return undefined;
    },
  };
}
