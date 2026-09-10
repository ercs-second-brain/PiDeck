/**
 * Agent-kind registry CRUD (registry v2, issue #330, docs/agent-kinds.md):
 * the handlers behind `GET/POST /api/agent-kinds` and
 * `PUT/DELETE /api/agent-kinds/:kind`.
 *
 * Guardrails:
 * - shipped kinds are **user-editable and user-deletable** (issue #368,
 *   B18 — the immutability design from #349/#350/#347 is reversed): an edit
 *   stores an override that shadows the shipped spec; a delete tombstones
 *   the shipped kind (persisted, so the deletion sticks across reloads —
 *   consistent with #357's archive/delete direction). Re-creating a shipped
 *   name lifts the tombstone. The shipped-default persona override surface
 *   (issue #315) is unaffected;
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
      // A shipped-name create is an override (issue #368) — allowed; it
      // shadows the shipped spec (and lifts the name's tombstone).
      if (services.agentKinds.get(body.name) !== undefined && !services.agentKinds.isShipped(body.name)) {
        throw new HttpError(409, `agent kind "${body.name}" already exists`);
      }
      return services.agentKindStore.save(body);
    },

    updateAgentKind: ({ params, body }) => {
      // Issue #368: shipped kinds are editable — the update stores an
      // override that shadows the shipped spec (persona content required,
      // like every stored kind).
      if (services.agentKinds.get(params.kind) === undefined) {
        throw new HttpError(404, `unknown agent kind: ${params.kind}`);
      }
      if (body.name !== params.kind) {
        throw new HttpError(400, `body name "${body.name}" must match the URL kind "${params.kind}" (kind ids are immutable)`);
      }
      return services.agentKindStore.save(body);
    },

    deleteAgentKind: ({ params }) => {
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
