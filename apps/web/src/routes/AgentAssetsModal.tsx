/**
 * Agent assets modal (issue #315): the webapp's per-persona asset editor,
 * opened from the sidebar button above Settings. The shell fetches
 * `GET /api/agent-assets` and hands the state to the pure
 * {@link AgentAssetsView} (the repo's split-view pattern) — two lists:
 *
 * - **Persona prompts** — one entry per boot persona; editing one stores a
 *   user override that takes precedence over the shipped
 *   `agent/prompts/<persona>.md` default (the editor pre-fills from the
 *   override, else the shipped default the daemon serves). "Reset to shipped
 *   default" removes the override.
 * - **Skills** — user-created single-file pi skills, applied to zero or many
 *   personas via checkboxes; every newly spawned pane of an applied persona
 *   gets the skill via pi's `--skill <file>`.
 *
 * Content is edited in a plain textarea (KISS): the daemon persists the text
 * verbatim in its state dir — user-owned and update-safe — and stays
 * unopinionated about it (docs/PHILOSOPHY.md). Changes reach panes on their
 * next spawn/relaunch; live panes are untouched.
 */

import { useEffect, useState } from "react";
import { PERSONAS, agentSkillIdSchema, type AgentAssets, type AgentSkill, type Persona } from "@pideck/shared";

import {
  apiDeleteAgentSkill,
  apiDeletePromptOverride,
  apiGetAgentAssets,
  apiSaveAgentSkill,
  apiSavePromptOverride,
  errorMessage,
} from "../lib/api";

/** Human labels for the persona rows and skill-application checkboxes. */
export const PERSONA_LABELS: Record<Persona, string> = {
  "global-agent": "Global agent",
  orchestrator: "Orchestrator",
  worker: "Worker",
  researcher: "Researcher",
  "devex-audit": "Devex audit",
  "kiss-audit": "KISS audit",
};

/**
 * The in-modal editor target: one persona's prompt override (pre-filled from
 * the override or the shipped default), or one skill (id editable only when
 * creating).
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
          Per-persona prompts &amp; skills — user-owned, stored by the daemon, applied when a session spawns. Shipped
          defaults stay as fallback.
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
      <section className="global-worker-settings">
        <h2 className="section-title">Skills</h2>
        <p className="field-hint">Single-file pi skills; checked personas&apos; new sessions load the skill.</p>
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

/** The in-modal textarea editor: prompt override, or skill id + personas + content. */
function AssetEditorPanel(props: {
  editor: AssetEditor;
  saving: boolean;
  error: string | null;
  onChange: (editor: AssetEditor | null) => void;
  onSave: () => void;
}) {
  const { editor } = props;
  const title =
    editor.kind === "prompt"
      ? `Edit ${PERSONA_LABELS[editor.persona]} prompt`
      : editor.idEditable
        ? "New skill"
        : `Edit skill "${editor.id}"`;
  return (
    <section className="agent-assets-editor">
      <h2 className="section-title">{title}</h2>
      {editor.kind === "skill" && (
        <div className="field">
          <label htmlFor="asset-skill-id">Skill id</label>
          <input
            id="asset-skill-id"
            type="text"
            placeholder="e.g. prd"
            value={editor.id}
            disabled={!editor.idEditable}
            onChange={(e) => props.onChange({ ...editor, id: e.target.value })}
          />
          <div className="asset-persona-checks">
            {PERSONAS.map((persona) => (
              <label key={persona} className="toggle-row">
                <input
                  type="checkbox"
                  checked={editor.personas.includes(persona)}
                  onChange={() =>
                    props.onChange({
                      ...editor,
                      personas: editor.personas.includes(persona)
                        ? editor.personas.filter((entry) => entry !== persona)
                        : [...editor.personas, persona],
                    })
                  }
                />
                <span>{PERSONA_LABELS[persona]}</span>
              </label>
            ))}
          </div>
          <small className="field-hint">Applied personas load the skill when their session spawns.</small>
        </div>
      )}
      <textarea
        className="modal-textarea asset-editor-text"
        aria-label="Asset content"
        value={editor.content}
        onChange={(e) => props.onChange({ ...editor, content: e.target.value })}
        spellCheck={false}
      />
      {props.error !== null && <p className="error-note">{props.error}</p>}
      <div className="wizard-actions">
        <AssetAction label="Cancel" dim onAct={() => props.onChange(null)} />
        <button type="button" className="button button-primary" onClick={props.onSave} disabled={props.saving}>
          {props.saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
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
      {editor !== null && (
        <AssetEditorPanel editor={editor} saving={saving} error={error} onChange={setEditor} onSave={saveEditor} />
      )}
    </>
  );
}
