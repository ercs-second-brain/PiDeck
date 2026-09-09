/**
 * User-defined agent-kind store (registry v2, issue #330,
 * docs/agent-kinds.md): the user-created kind specs, persisted under the
 * daemon state dir (`<stateDir>/agent-kinds.json`) — user-owned and
 * update-safe, never in the PiDeck checkout (the same rule as the
 * agent-assets store, issue #315). Shipped kinds are NOT stored here:
 * they ship as spec-v2 data in `@pideck/shared`
 * ({@link SHIPPED_AGENT_KINDS}) and are immutable.
 *
 * Validated entry-at-a-time on load (forward compatibility, mirroring the
 * session registry): a persisted spec that no longer matches the schema is
 * dropped with a logged warning instead of rejecting the whole file.
 */

import path from "node:path";
import { z } from "zod";

import { agentKindSpecSchema, type AgentKindSpec } from "@pideck/shared";

import { JsonStore } from "../json-store.js";

const persistedSchema = z.object({
  version: z.literal(1),
  kinds: z.array(agentKindSpecSchema),
});

type PersistedKinds = z.infer<typeof persistedSchema>;

const EMPTY_STATE: PersistedKinds = { version: 1, kinds: [] };

export class AgentKindStore {
  private readonly file: JsonStore<PersistedKinds>;
  private current: PersistedKinds;

  constructor(stateDir: string) {
    this.file = new JsonStore(path.join(stateDir, "agent-kinds.json"));
    this.current = this.file.load(
      (value) => {
        const parsed = persistedSchema.safeParse(value);
        if (parsed.success) return parsed.data;
        // Entry-level recovery: keep the specs that still validate, drop
        // the drifted ones (visible in the log, not silent data loss).
        const kinds = Array.isArray((value as PersistedKinds | undefined)?.kinds)
          ? (value as { kinds: unknown[] }).kinds
          : [];
        const kept: AgentKindSpec[] = [];
        for (const entry of kinds) {
          const one = agentKindSpecSchema.safeParse(entry);
          if (one.success) kept.push(one.data);
          else console.error(`[pideck] dropping invalid agent-kind spec:`, one.error.issues[0]);
        }
        return { version: 1, kinds: kept };
      },
      EMPTY_STATE,
    );
  }

  /** Every user-defined kind, insertion order. */
  list(): AgentKindSpec[] {
    return [...this.current.kinds];
  }

  /** One user-defined kind by id; `undefined` when absent (shipped kinds resolve via the registry). */
  get(name: string): AgentKindSpec | undefined {
    return this.current.kinds.find((kind) => kind.name === name);
  }

  /** Upserts a user kind by id; returns the stored spec. */
  save(spec: AgentKindSpec): AgentKindSpec {
    const existing = this.current.kinds.findIndex((kind) => kind.name === spec.name);
    if (existing === -1) this.current.kinds.push(spec);
    else this.current.kinds[existing] = spec;
    this.persist();
    return spec;
  }

  /** Removes a user kind; false when none stored under the id. */
  delete(name: string): boolean {
    const index = this.current.kinds.findIndex((kind) => kind.name === name);
    if (index === -1) return false;
    this.current.kinds.splice(index, 1);
    this.persist();
    return true;
  }

  private persist(): void {
    this.file.save(this.current);
  }
}
