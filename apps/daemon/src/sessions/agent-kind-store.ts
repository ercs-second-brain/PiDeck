/**
 * User-defined agent-kind store + shipped-kind overrides (registry v2,
 * issue #330, docs/agent-kinds.md): the user-created kind specs, persisted
 * under the daemon state dir (`<stateDir>/agent-kinds.json`) — user-owned
 * and update-safe, never in the PiDeck checkout (the same rule as the
 * agent-assets store, issue #315). Shipped kinds are NOT stored here by
 * default: they ship as spec-v2 data in `@pideck/shared`
 * ({@link SHIPPED_AGENT_KINDS}).
 *
 * Shipped-kind overrides + tombstones (issue #368, B18 — the immutability
 * design from #349/#350/#347 is reversed by user decision): users can edit
 * and delete shipped kinds like regular personas.
 *
 * - An **override** is a stored spec whose name matches a shipped kind; the
 *   registry shadows the shipped spec with it (the pre-#330 shadowing rule,
 *   now open to shipped names too).
 * - A **tombstone** (`{ version: 1, kinds: [], tombstones: ["<name>"] }`)
 *   marks a shipped kind as deleted: the registry stops resolving and
 *   listing it. A tombstone for a name that never ships is meaningless but
 *   harmless (a later PiDeck release re-shipping the name stays deleted —
 *   the tombstone shadows it until the user re-creates the kind).
 *
 * Overrides and tombstones are mutually exclusive per name (saving an
 * override lifts the tombstone — the user re-created the kind; deleting an
 * override of a shipped kind drops the tombstone again).
 *
 * Validated entry-at-a-time on load (forward compatibility, mirroring the
 * session registry): a persisted spec that no longer matches the schema is
 * dropped with a logged warning instead of rejecting the whole file.
 */

import path from "node:path";
import { z } from "zod";

import { agentKindSpecSchema, SHIPPED_AGENT_KINDS, type AgentKindSpec } from "@pideck/shared";

import { JsonStore } from "../json-store.js";

const persistedSchema = z.object({
  version: z.literal(1),
  kinds: z.array(agentKindSpecSchema),
  // Shipped-kind tombstones (issue #368): shipped kinds the user deleted.
  tombstones: z.array(z.string()).default([]),
});

type PersistedKinds = z.infer<typeof persistedSchema>;

/** Fresh literal per construction — NEVER a shared module constant: the
 * fallback is returned by reference and the store mutates `current` in
 * place, so a shared empty would leak state across reloads (the documented
 * agent-assets trap; fixing the latent AgentKindStore instance, issue
 * #368). */
const emptyState = (): PersistedKinds => ({ version: 1, kinds: [], tombstones: [] });

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
        const raw = (value as PersistedKinds | undefined) ?? emptyState();
        const kinds = Array.isArray(raw.kinds) ? raw.kinds : [];
        const kept: AgentKindSpec[] = [];
        for (const entry of kinds) {
          const one = agentKindSpecSchema.safeParse(entry);
          if (one.success) kept.push(one.data);
          else console.error(`[pideck] dropping invalid agent-kind spec:`, one.error.issues[0]);
        }
        const tombstones = Array.isArray(raw.tombstones)
          ? raw.tombstones.filter((entry): entry is string => typeof entry === "string")
          : [];
        return { version: 1, kinds: kept, tombstones };
      },
      emptyState(),
    );
  }

  /** Every stored kind (user kinds + shipped-kind overrides), insertion order. */
  list(): AgentKindSpec[] {
    return [...this.current.kinds];
  }

  /**
   * One stored kind by id (user kind or shipped override); `undefined` when
   * absent. Shipped kinds without an override do NOT resolve from here —
   * the registry falls back to the shipped spec.
   */
  get(name: string): AgentKindSpec | undefined {
    return this.current.kinds.find((kind) => kind.name === name);
  }

  /** Upserts a kind by id (user kind or shipped override — a save lifts the name's tombstone); returns the stored spec. */
  save(spec: AgentKindSpec): AgentKindSpec {
    const existing = this.current.kinds.findIndex((kind) => kind.name === spec.name);
    if (existing === -1) this.current.kinds.push(spec);
    else this.current.kinds[existing] = spec;
    // Saving an override re-creates the shipped kind — the deletion (if any)
    // is lifted.
    if (this.current.tombstones.includes(spec.name)) {
      this.current.tombstones = this.current.tombstones.filter((entry) => entry !== spec.name);
    }
    this.persist();
    return spec;
  }

  /**
   * Removes a stored kind; false when none stored under the id. For a
   * shipped-kind override this ALSO tombstones the shipped kind (issue
   * #368): the user's delete of the shipped persona must stick across
   * reloads, so the registry stops resolving the shipped spec. For pure
   * user kinds, no tombstone is stored (they never ship).
   */
  delete(name: string): boolean {
    const index = this.current.kinds.findIndex((kind) => kind.name === name);
    if (index !== -1) this.current.kinds.splice(index, 1);
    const shipped = SHIPPED_AGENT_KINDS.some((kind) => kind.name === name);
    if (!shipped && index === -1) return false;
    if (shipped && !this.current.tombstones.includes(name)) this.current.tombstones.push(name);
    this.persist();
    return true;
  }

  /** Whether the shipped kind is tombstoned (user-deleted, issue #368). */
  isTombstoned(name: string): boolean {
    return this.current.tombstones.includes(name);
  }

  /** Removes a shipped kind's tombstone (the user re-created the kind). */
  liftTombstone(name: string): void {
    if (!this.current.tombstones.includes(name)) return;
    this.current.tombstones = this.current.tombstones.filter((entry) => entry !== name);
    this.persist();
  }

  private persist(): void {
    this.file.save(this.current);
  }
}
