/**
 * Agent assets modal (issue #315): the webapp's per-persona asset editor,
 * opened from the sidebar button above Settings. The shell fetches
 * `GET /api/agent-assets` and hands the state to the pure
 * {@link AgentAssetsView} (the repo's split-view pattern) — the lists:
 *
 * - **Persona prompts** — one entry per boot persona; editing one opens a proper dialog (issue #358, B11) with the
 *   prompt override (takes precedence over the shipped `agent/prompts/<persona>.md` default; pre-filled from the
 *   override, else the daemon-served default; "Reset to shipped default" removes it) AND the persona's skill
 *   assignment (issue #358, B13 — managed on the persona edit, each toggle saves immediately).
 * - **Skills** — user-created single-file pi skills; the edit dialog is
 *   id + content only (B13: personas are managed from the persona edit);
 *   every newly spawned pane of an applied persona gets the skill via pi's
 *   `--skill <file>`.
 * - **Agent kinds** (issue #332) — the registry-v2 persona editor
 *   ({@link AgentKindsSection}); its editor opens as the same nested dialog.
 *
 * Content is edited in a plain textarea (KISS): the daemon persists the text
 * verbatim in its state dir — user-owned and update-safe, unopinionated
 * (docs/PHILOSOPHY.md). Changes reach panes on their next spawn/relaunch;
 * live panes are untouched.
 */

import { useEffect, useState } from "react";
import { PERSONAS, agentKindInfo, agentSkillIdSchema, type AgentAssets, type AgentSkill, type Persona } from "@pideck/shared";

import { AssetDialog } from "./AssetDialog";
import { AgentKindsSection } from "./AgentKindsSection";
import { apiDeleteAgentSkill, apiDeletePromptOverride, apiGetAgentAssets, apiSaveAgentSkill, apiSavePromptOverride, errorMessage } from "../lib/api";

/**
 * Human labels for the persona rows and the persona-edit skill assignment:
 * the three platform personas stay hardcoded; the kind personas derive
 * from the kind registry's presentation metadata (issue #351 F3 — no
 * duplicated labels to drift).
 */
export const PERSONA_LABELS: Record<Persona, string> = {
  "global-agent": "Global agent",
  orchestrator: "Orchestrator",
  worker: "Worker",
  researcher: agentKindInfo("researcher").menuLabel,
  "devex-audit": agentKindInfo("devex-audit").menuLabel,
  "kiss-audit": agentKindInfo("kiss-audit").menuLabel,
};

/**
 * The in-modal editor target (issue #358): one persona's prompt editor
 * (override content + the persona's skill assignment), or one skill (id
 * editable only when creating). The skill editor carries the skill's
 * current `personas` through to the save — assignment is edited on the
 * persona, not here (B13).
 */
export type AssetEditor =
  | { kind: "prompt"; persona: Persona; content: string }
  | { kind: "skill"; id: string; idEditable: boolean; content: string; personas: Persona[] };

export function AgentAssetsModal({ onClose }: { onClose: () => void }) {
  const [assets, setAssets] = useState<AgentAssets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGetAgentAssets()
      .then((loaded) => {
        if (!cancelled) setAssets(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Agent assets">
      <div className="modal-card agent-assets-modal">
        <button type="button" className="modal-close" aria-label="Close agent assets" onClick={onClose}>
          ×
        </button>
        <h1 className="page-title">Agent assets</h1>
        <p className="project-repo">
          Per-persona prompts, skills, and agent kinds — user-owned, stored by the daemon, applied when a session
          spawns. Shipped defaults stay as fallback.
        </p>
        {loadError !== null && <p className="error-note">Failed to load agent assets: {loadError}</p>}
        {assets !== null && <AgentAssetsView assets={assets} onReload={setAssets} />}
      </div>
    </div>
  );
}

/** One list entry's shared action-button chrome. */
function AssetAction(props: { label: string; dim?: boolean; onAct: () => void }) {
  return (
    <button type="button" className={`asset-action${props.dim === true ? " asset-action-dim" : ""}`} onClick={props.onAct}>
      {props.label}
    </button>
  );
}

/** The two asset lists: one prompt row per persona, one row per skill. */
function AssetLists(props: {
  assets: AgentAssets;
  onEditPrompt: (persona: Persona) => void;
  onResetPrompt: (persona: Persona) => void;
  onEditSkill: (skill: AgentSkill) => void;
  onDeleteSkill: (id: string) => void;
  onNewSkill: () => void;
  confirmingDeleteId: string | null;
}) {
  return (
    <>
      <section className="global-worker-settings">
        <h2 className="section-title">Persona prompts</h2>
        <p className="field-hint">An override replaces the shipped boot prompt for every new session of that persona.</p>
        <ul className="asset-list">
          {PERSONAS.map((persona) => {
            const overridden = props.assets.prompts.some((entry) => entry.persona === persona);
            return (
              <li key={persona} className="asset-row">
                <span className="asset-name">{PERSONA_LABELS[persona]}</span>
                <span className={`asset-chip${overridden ? " asset-chip-on" : ""}`}>
                  {overridden ? "override" : "shipped default"}
                </span>
                <AssetAction label="Edit" onAct={() => props.onEditPrompt(persona)} />
                {overridden && <AssetAction label="Reset to default" dim onAct={() => props.onResetPrompt(persona)} />}
              </li>
            );
          })}
        </ul>
      </section>
      <AgentKindsSection />
      <section className="global-worker-settings">
        <h2 className="section-title">Skills</h2>
        <p className="field-hint">Single-file pi skills; personas are assigned from each persona&apos;s edit (above).</p>
        {props.assets.skills.length === 0 && <p className="empty">No skills yet.</p>}
        <ul className="asset-list">
          {props.assets.skills.map((skill) => (
            <li key={skill.id} className="asset-row">
              <span className="asset-name asset-name-mono">{skill.id}</span>
              <span className="asset-personas">
                {skill.personas.length === 0
                  ? "applied to no personas"
                  : skill.personas.map((persona) => PERSONA_LABELS[persona]).join(", ")}
              </span>
              <AssetAction label="Edit" onAct={() => props.onEditSkill(skill)} />
              <AssetAction
                label={props.confirmingDeleteId === skill.id ? "Confirm delete?" : "Delete"}
                dim
                onAct={() => props.onDeleteSkill(skill.id)}
              />
            </li>
          ))}
        </ul>
        <div className="wizard-actions">
          <button type="button" className="button button-primary" onClick={props.onNewSkill}>
            + New skill
          </button>
        </div>
      </section>
    </>
  );
}

/** One persona-skill checkbox row (the persona editor's assignment list). */
function SkillToggle(props: { skill: AgentSkill; persona: Persona; onToggle: () => void }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={props.skill.personas.includes(props.persona)} onChange={props.onToggle} />
      <span>{props.skill.id}</span>
    </label>
  );
}

/** The shared asset-content textarea (the two dialogs' duplicated chrome). */
function AssetContentTextarea(props: { value: string; onChange: (value: string) => void }) {
  return (
    <textarea
      className="modal-textarea asset-editor-text"
      aria-label="Asset content"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      spellCheck={false}
    />
  );
}

/**
 * The persona-edit dialog (issues #358 B11+B13): the persona's prompt
 * override plus its skill assignment — one checkbox per skill, each toggle
 * saving immediately (the GlobalWorkerSettings toggle behavior). This is
 * where personas get skills, per B13.
 */
export function PersonaEditorDialog(props: {
  editor: Extract<AssetEditor, { kind: "prompt" }>;
  assets: AgentAssets;
  saving: boolean;
  error: string | null;
  onChange: (editor: AssetEditor | null) => void;
  onSave: () => void;
  onToggleSkill: (skill: AgentSkill) => void;
}) {
  const persona = props.editor.persona;
  return (
    <AssetDialog
      ariaLabel={`Edit ${PERSONA_LABELS[persona]} prompt`}
      title={`Edit ${PERSONA_LABELS[persona]} prompt`}
      footer={{ error: props.error, saving: props.saving, onSave: props.onSave }}
      onClose={() => props.onChange(null)}
    >
      <p className="field-hint">An override replaces the shipped boot prompt for every new session of this persona.</p>
      <AssetContentTextarea value={props.editor.content} onChange={(content) => props.onChange({ ...props.editor, content })} />
      <div className="field">
        <label>Skills this persona loads</label>
        <div className="asset-persona-checks">
          {props.assets.skills.map((skill) => (
            <SkillToggle key={skill.id} skill={skill} persona={persona} onToggle={() => props.onToggleSkill(skill)} />
          ))}
        </div>
        <small className="field-hint">Toggles save immediately; the persona&apos;s next spawn loads the checked skills.</small>
      </div>
    </AssetDialog>
  );
}

/**
 * The skill-edit dialog (issues #358 B11+B13): a proper dialog holding the
 * skill id plus its content — and nothing else. Persona assignment is NOT
 * here anymore (B13: it moved to the persona edit, above); the skill's
 * current assignment is carried through to the save untouched, so editing
 * a skill's text never changes who loads it.
 */
export function SkillEditorDialog(props: {
  editor: Extract<AssetEditor, { kind: "skill" }>;
  saving: boolean;
  error: string | null;
  onChange: (editor: AssetEditor | null) => void;
  onSave: () => void;
}) {
  const title = props.editor.idEditable ? "New skill" : `Edit skill "${props.editor.id}"`;
  return (
    <AssetDialog
      ariaLabel={title}
      title={title}
      footer={{ error: props.error, saving: props.saving, onSave: props.onSave }}
      onClose={() => props.onChange(null)}
    >
      <div className="field">
        <label htmlFor="asset-skill-id">Skill id</label>
        <input
          id="asset-skill-id"
          type="text"
          placeholder="e.g. prd"
          value={props.editor.id}
          disabled={!props.editor.idEditable}
          onChange={(e) => props.onChange({ ...props.editor, id: e.target.value })}
        />
        <small className="field-hint">Assign personas from each persona&apos;s edit dialog.</small>
      </div>
      <AssetContentTextarea value={props.editor.content} onChange={(content) => props.onChange({ ...props.editor, content })} />
    </AssetDialog>
  );
}

/**
 * The pure asset-editor surface (one loaded `AgentAssets` in): the prompts
 * and skills lists plus the in-modal textarea editor. Editor state lives
 * here — it is view-local; every save goes straight to the daemon and
 * refreshes via `onReload`.
 */
export function AgentAssetsView({ assets, onReload }: { assets: AgentAssets; onReload: (assets: AgentAssets) => void }) {
  const [editor, setEditor] = useState<AssetEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setError(null);
    try {
      await action();
      onReload(await apiGetAgentAssets());
      after?.();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const openPromptEditor = (persona: Persona): void => {
    const override = assets.prompts.find((entry) => entry.persona === persona);
    setEditor({ kind: "prompt", persona, content: override?.content ?? assets.defaults[persona] ?? "" });
  };

  const saveEditor = (): void => {
    if (editor === null) return;
    setSaving(true);
    if (editor.kind === "prompt") {
      void run(() => apiSavePromptOverride(editor.persona, editor.content), () => setEditor(null)).finally(() => setSaving(false));
      return;
    }
    const parsedId = agentSkillIdSchema.safeParse(editor.id.trim());
    if (!parsedId.success) {
      setSaving(false);
      setError(`Skill id must be a short slug (letters, digits, "-" or "_").`);
      return;
    }
    void run(() => apiSaveAgentSkill(parsedId.data, { content: editor.content, personas: editor.personas }), () =>
      setEditor(null),
    ).finally(() => setSaving(false));
  };

  return (
    <>
      <AssetLists
        assets={assets}
        confirmingDeleteId={confirmingDeleteId}
        onEditPrompt={(persona) => {
          setError(null);
          setNote(null);
          openPromptEditor(persona);
        }}
        onResetPrompt={(persona) =>
          void run(() => apiDeletePromptOverride(persona)).then(() =>
            setNote(`${PERSONA_LABELS[persona]} prompt reset to the shipped default.`),
          )
        }
        onEditSkill={(skill) => {
          setError(null);
          setNote(null);
          setEditor({ kind: "skill", id: skill.id, idEditable: false, content: skill.content, personas: skill.personas });
        }}
        onDeleteSkill={(id) => {
          if (confirmingDeleteId !== id) {
            setConfirmingDeleteId(id);
            return;
          }
          setConfirmingDeleteId(null);
          void run(() => apiDeleteAgentSkill(id)).then(() => setNote(`Skill "${id}" deleted.`));
        }}
        onNewSkill={() => {
          setError(null);
          setNote(null);
          setEditor({ kind: "skill", id: "", idEditable: true, content: `---\nname: \ndescription: \n---\n\n`, personas: [] });
        }}
      />
      {note !== null && <p className="saved-note">{note}</p>}
      {editor !== null && editor.kind === "prompt" && (
        <PersonaEditorDialog
          editor={editor}
          assets={assets}
          saving={saving}
          error={error}
          onChange={setEditor}
          onSave={saveEditor}
          onToggleSkill={(skill) => {
            // B13: persona-skill assignment lives here — toggling updates
            // that skill's personas (immediate save, the toggle pattern).
            const personas = skill.personas.includes(editor.persona)
              ? skill.personas.filter((entry) => entry !== editor.persona)
              : [...skill.personas, editor.persona];
            void run(() => apiSaveAgentSkill(skill.id, { content: skill.content, personas }));
          }}
        />
      )}
      {editor !== null && editor.kind === "skill" && (
        <SkillEditorDialog editor={editor} saving={saving} error={error} onChange={setEditor} onSave={saveEditor} />
      )}
    </>
  );
}
