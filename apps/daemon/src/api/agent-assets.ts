/**
 * Per-persona agent assets (issue #315): the one store for user-owned prompt
 * overrides and skills, persisted under the daemon state dir
 * (`<stateDir>/agent-assets.json`) — user-owned and update-safe, never in
 * the PiDeck checkout (docs/PHILOSOPHY.md: PiDeck is the editor/deployer of
 * user-owned pi assets and stays unopinionated about their content).
 *
 * Two asset kinds:
 *
 * - **Prompt overrides** — one slot per persona (`PERSONAS`): the rendered
 *   boot prompt uses the override instead of the shipped
 *   `agent/prompts/<persona>.md` default, which stays the fallback.
 * - **Skills** — user-created single-file pi skills (v1, KISS), each applied
 *   to zero or many personas. Saved content is deployed verbatim to
 *   `<stateDir>/agent-assets/skills/<id>.md`; the launch paths surface it to
 *   the persona's pane via pi's `--skill <file>` (prompt overrides deploy to
 *   `agent-assets/prompts/<persona>.md` the same way for the worker persona,
 *   whose command is recorded rather than rebuilt at boot).
 *
 * Consumers of the launch-shaped view: `OrchestratorBootstrap`
 * (orchestrator / global-agent / agent-kind panes) and
 * `SessionManager.spawnWorker` (worker panes) — both via
 * {@link skillLaunchArgs} / {@link promptLaunchArgs}.
 */

import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  PERSONAS,
  agentSkillSchema,
  personaSchema,
  promptOverrideSchema,
  type AgentAssets,
  type AgentSkill,
  type Persona,
  type PromptOverride,
} from "@pideck/shared";

import { atomicWrite, JsonStore } from "../json-store.js";
import { findAgentPromptPath } from "../orchestrator/prompt.js";

const persistedSchema = z.object({
  version: z.literal(1),
  // Partial record: at most one override per persona (zod 4's enum-keyed
  // `z.record` demands exhaustiveness; overrides are sparse by design).
  prompts: z.partialRecord(personaSchema, promptOverrideSchema),
  skills: z.array(agentSkillSchema),
});

/**
 * One-time persona-id migration (issue #335, docs/agent-kinds.md §7): stored
 * overrides/skills may reference the researcher persona's legacy id (spelled
 * "investigator"). Without this rewrite they would fail the persona enum and
 * the whole file would silently fall back to empty assets — the user's edits
 * would vanish. Rewritten on load; the next save persists the new id.
 */
function migrateLegacyPersonas(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const raw = value as {
    prompts?: Record<string, unknown>;
    skills?: Array<{ personas?: unknown }>;
  };
  const prompts = raw.prompts;
  const skills = raw.skills?.map((skill) => ({
    ...skill,
    personas: Array.isArray(skill.personas)
      ? skill.personas.map((p) => (p === "investigator" ? "researcher" : p))
      : skill.personas,
  }));
  return {
    ...raw,
    ...(prompts === undefined
      ? {}
      : {
          prompts: Object.fromEntries(
            Object.entries(prompts).map(([k, v]) => [
              k === "investigator" ? "researcher" : k,
              // The override record repeats the persona as a field — rewrite it too.
              k === "investigator" && typeof v === "object" && v !== null
                ? { ...(v as Record<string, unknown>), persona: "researcher" }
                : v,
            ]),
          ),
        }),
    ...(skills === undefined ? {} : { skills }),
  };
}

type PersistedAssets = z.infer<typeof persistedSchema>;

/** The launch-shaped view of the store (`SessionManager` / bootstrap deps). */
export interface PersonaLaunchAssets {
  /** A persona's stored prompt override content, when one exists. */
  promptOverride: (persona: Persona) => string | undefined;
  /** `--skill <file>` argv pairs for the skills applied to the persona. */
  skillLaunchArgs: (persona: Persona) => string[];
  /** System-prompt argv for the persona's deployed override file (worker panes). */
  promptLaunchArgs: (persona: Persona) => string[];
}

export class AgentAssetsStore implements PersonaLaunchAssets {
  private readonly file: JsonStore<PersistedAssets>;
  private readonly stateDir: string;
  private current: PersistedAssets;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.file = new JsonStore(path.join(stateDir, "agent-assets.json"));
    // Fresh literal per construction (never a shared module constant): the
    // fallback is returned by reference and the store mutates `current` in
    // place, so a shared empty would leak state across reloads.
    this.current = this.file.load(
      (value) => {
        const parsed = persistedSchema.safeParse(migrateLegacyPersonas(value));
        return parsed.success ? parsed.data : undefined;
      },
      { version: 1, prompts: {} as Record<Persona, PromptOverride>, skills: [] },
    );
  }

  /** The full asset state for the webapp, plus shipped default prompt text. */
  list(): AgentAssets {
    const defaults: Record<Persona, string> = {} as Record<Persona, string>;
    for (const persona of PERSONAS) {
      try {
        defaults[persona] = readFileSync(findAgentPromptPath(undefined, `${persona}.md`), "utf8");
      } catch {
        defaults[persona] = ""; // no shipped file — the editor starts empty
      }
    }
    return {
      prompts: PERSONAS.map((persona) => this.current.prompts[persona]).filter((p): p is PromptOverride => p !== undefined),
      skills: this.current.skills,
      defaults,
    };
  }

  /** A persona's stored override content; `undefined` = shipped default runs. */
  promptOverride(persona: Persona): string | undefined {
    return this.current.prompts[persona]?.content;
  }

  /** Upserts the override and deploys its file; returns the stored record. */
  savePromptOverride(persona: Persona, content: string): PromptOverride {
    const override: PromptOverride = { persona, content, updatedAt: new Date().toISOString() };
    this.current.prompts[persona] = override;
    this.persist();
    atomicWrite(this.promptOverrideFilePath(persona), content);
    return override;
  }

  /** Removes the override (and its deployed file); false when none stored. */
  deletePromptOverride(persona: Persona): boolean {
    if (this.current.prompts[persona] === undefined) return false;
    delete this.current.prompts[persona];
    this.persist();
    try {
      unlinkSync(this.promptOverrideFilePath(persona));
    } catch {
      // Already gone — the deletion is done either way.
    }
    return true;
  }

  /** One stored skill by id, when it exists. */
  getSkill(id: string): AgentSkill | undefined {
    return this.current.skills.find((skill) => skill.id === id);
  }

  /** Upserts a skill (content + applied personas) and deploys its file. */
  saveSkill(id: string, body: { content: string; personas: Persona[] }): AgentSkill {
    const skill: AgentSkill = {
      id,
      content: body.content,
      // Deduped, insertion-ordered personas.
      personas: [...new Set(body.personas)],
      updatedAt: new Date().toISOString(),
    };
    const existing = this.current.skills.findIndex((entry) => entry.id === id);
    if (existing === -1) this.current.skills.push(skill);
    else this.current.skills[existing] = skill;
    this.persist();
    atomicWrite(this.skillFilePath(id), skill.content);
    return skill;
  }

  /** Removes a skill (and its deployed file); false for an unknown id. */
  deleteSkill(id: string): boolean {
    const index = this.current.skills.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.current.skills.splice(index, 1);
    this.persist();
    try {
      unlinkSync(this.skillFilePath(id));
    } catch {
      // Already gone — the deletion is done either way.
    }
    return true;
  }

  /** `["--skill", file, ...]` for the skills applied to the persona's panes. */
  skillLaunchArgs(persona: Persona): string[] {
    const args: string[] = [];
    for (const skill of this.current.skills) {
      if (skill.personas.includes(persona)) args.push("--skill", this.skillFilePath(skill.id));
    }
    return args;
  }

  /**
   * System-prompt argv for the persona's deployed override file, when one
   * exists (the shipped default is NOT loaded this way — the boot paths read
   * the shipped template directly; this is for the worker persona, whose
   * pane command is recorded at spawn rather than rebuilt at boot).
   */
  promptLaunchArgs(persona: Persona): string[] {
    if (this.current.prompts[persona] === undefined) return [];
    return ["--append-system-prompt", this.promptOverrideFilePath(persona)];
  }

  /** Where a skill's single file is deployed (`<stateDir>/agent-assets/skills/<id>.md`). */
  private skillFilePath(id: string): string {
    return path.join(this.stateDir, "agent-assets", "skills", `${id}.md`);
  }

  /** Where a prompt override is deployed (`<stateDir>/agent-assets/prompts/<persona>.md`). */
  private promptOverrideFilePath(persona: Persona): string {
    return path.join(this.stateDir, "agent-assets", "prompts", `${persona}.md`);
  }

  private persist(): void {
    this.file.save(this.current);
  }
}
