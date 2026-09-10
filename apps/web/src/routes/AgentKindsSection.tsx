/**
 * Agent-kinds section of the agent-assets modal (issue #332): the
 * registry-v2 persona editor. Consumes the #347 CRUD API. Issue #368
 * (B18 — the immutability design is reversed): shipped kinds are editable
 * and deletable like custom kinds — an edit stores an override shadowing
 * the shipped spec; a delete tombstones the shipped kind (persisted, so it
 * sticks across reloads, with a restore row). The daemon's 409 guardrail
 * blocks kinds with live sessions. The "+ New kind" flow creates a
 * validated spec. Changes affect future spawns only; live panes are
 * untouched.
 */

import { useEffect, useState } from "react";
import { SHIPPED_AGENT_KINDS, type AgentKindSpec } from "@pideck/shared";

import { apiCreateAgentKind, apiDeleteAgentKind, apiGetAgentAssets, apiListAgentKinds, apiUpdateAgentKind, errorMessage } from "../lib/api";
import { AgentKindForm, NEW_KIND_DRAFT, draftFromSpec, parseDraft, type KindDraft } from "./AgentKindForm";

/** The editor's modal state: create, or edit one custom kind. */
type KindEditor = { mode: "create"; draft: KindDraft } | { mode: "edit"; name: string; draft: KindDraft };

const isShippedName = (name: string): boolean => SHIPPED_AGENT_KINDS.some((shipped) => shipped.name === name);

/**
 * One row per registry kind: label, id, shipped/custom chip, actions. Every
 * kind is editable and deletable (issue #368); tombstoned shipped kinds
 * render a restore row after the list.
 */
export function KindRows(props: {
  kinds: AgentKindSpec[];
  /** Shipped kind ids the user deleted (tombstoned — restore rows). */
  tombstoned: string[];
  onEdit: (spec: AgentKindSpec) => void;
  onDelete: (name: string) => void;
  onRestore: (name: string) => void;
  confirmingDeleteName: string | null;
}) {
  return (
    <>
      <ul className="asset-list">
        {props.kinds.map((spec) => {
          const shipped = isShippedName(spec.name);
          const overridden = shipped && spec.persona !== undefined;
          return (
            <li key={spec.name} className="asset-row">
              <span className="asset-name">{spec.menuLabel ?? spec.label}</span>
              <span className="asset-name asset-name-mono">{spec.name}</span>
              <span className={`asset-chip${overridden ? " asset-chip-on" : ""}`}>
                {overridden ? "shipped · edited" : shipped ? "shipped" : "custom"}
              </span>
              <span className="asset-personas">
                {spec.trigger === "auto" ? "auto" : "waits for input"} · reports to{" "}
                {spec.reportTarget === "orchestrator" ? "the orchestrator" : "the calling session"}
              </span>
              <button type="button" className="asset-action" onClick={() => props.onEdit(spec)}>
                Edit
              </button>
              <button type="button" className="asset-action asset-action-dim" onClick={() => props.onDelete(spec.name)}>
                {props.confirmingDeleteName === spec.name ? "Confirm delete?" : "Delete"}
              </button>
            </li>
          );
        })}
      </ul>
      {props.tombstoned.length > 0 && (
        <ul className="asset-list">
          {props.tombstoned.map((name) => (
            <li key={name} className="asset-row">
              <span className="asset-name">{SHIPPED_AGENT_KINDS.find((shipped) => shipped.name === name)?.menuLabel ?? name}</span>
              <span className="asset-name asset-name-mono">{name}</span>
              <span className="asset-chip">deleted</span>
              <span className="asset-personas">shipped kind deleted — future spawns stopped</span>
              <button type="button" className="asset-action" onClick={() => props.onRestore(name)}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The registry list plus its fetch/refresh (the modal shell's data hook). */
function useAgentKinds() {
  const [kinds, setKinds] = useState<AgentKindSpec[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiListAgentKinds()
      .then((loaded) => {
        if (!cancelled) setKinds(loaded.kinds);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const reload = (): Promise<void> =>
    apiListAgentKinds()
      .then((loaded) => setKinds(loaded.kinds))
      .catch((err: unknown) => setLoadError(errorMessage(err)));
  return { kinds, loadError, reload };
}

/**
 * Shipped kinds the user deleted (issue #368), derived from the live list
 * minus the shipped names (the list response carries no separate tombstone
 * field — absence is the tombstone).
 */
function tombstonedShippedNames(kinds: AgentKindSpec[] | null): string[] {
  const liveNames = kinds === null ? [] : kinds.map((entry) => entry.name);
  return SHIPPED_AGENT_KINDS.filter((shipped) => !liveNames.includes(shipped.name)).map((shipped) => shipped.name);
}

/**
 * Opens the kind editor for one spec (issue #368): a shipped kind with no
 * persona content prefills the persona from the shipped default prompt
 * (the #315 prompt-override editor's prefill behavior) so the edit starts
 * from the shipped text.
 */
function openKindEditor(spec: AgentKindSpec, setEditor: (editor: KindEditor) => void): void {
  const draft = draftFromSpec(spec);
  if (draft.persona !== "" || !isShippedName(spec.name)) {
    setEditor({ mode: "edit", name: spec.name, draft });
    return;
  }
  void apiGetAgentAssets()
    .then((assets) => setEditor({ mode: "edit", name: spec.name, draft: { ...draft, persona: assets.defaults[spec.name as keyof typeof assets.defaults] ?? "" } }))
    .catch(() => setEditor({ mode: "edit", name: spec.name, draft }));
}

/**
 * Restores a tombstoned shipped kind (issue #368): re-creates the kind
 * from its shipped spec — the save lifts the tombstone.
 */
async function restoreShippedKind(name: string, reload: () => Promise<void>): Promise<void> {
  const shipped = SHIPPED_AGENT_KINDS.find((entry) => entry.name === name);
  if (shipped === undefined) return;
  await apiCreateAgentKind({ ...shipped, persona: "" });
  await reload();
}

/** The self-fetching agent-kinds section (registry v2 via `GET /api/agent-kinds`). */
export function AgentKindsSection() {
  const { kinds, loadError, reload } = useAgentKinds();
  const [editor, setEditor] = useState<KindEditor | null>(null);
  const [confirmingDeleteName, setConfirmingDeleteName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Tombstoned shipped kinds (issue #368): deleted shipped kinds, derived
  // from the live list minus the shipped names (the list response carries
  // no separate tombstone field — absence is the tombstone).
  const tombstoned = tombstonedShippedNames(kinds);

  const closeEditor = (message: string): Promise<void> => {
    setEditor(null);
    setNote(message);
    return reload();
  };

  const saveEditor = (): void => {
    if (editor === null) return;
    const parsed = parseDraft(editor.draft);
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    setSaving(true);
    const verb = editor.mode === "create" ? "created" : "saved";
    const action = editor.mode === "create" ? apiCreateAgentKind(parsed) : apiUpdateAgentKind(editor.name, parsed);
    void action
      .then(() => closeEditor(`Agent kind "${parsed.name}" ${verb} — future spawns use it.`))
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setSaving(false));
  };

  const deleteKind = (name: string): void => {
    if (confirmingDeleteName !== name) {
      setConfirmingDeleteName(name);
      return;
    }
    setConfirmingDeleteName(null);
    void apiDeleteAgentKind(name)
      .then(() => closeEditor(`Agent kind "${name}" deleted.`))
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  return (
    <section className="global-worker-settings">
      <h2 className="section-title">Agent kinds</h2>
      <p className="field-hint">
        Spawnable agent personas from the kind registry. Every kind is yours: edit persona, task template, and
        config — shipped kinds included (an edit shadows the shipped spec; the shipped default stays the fallback
        until then). Deleting a shipped kind tombstones it — restore any time. Deleting needs no live sessions of
        the kind. Changes affect future spawns.
      </p>
      {loadError !== null && <p className="error-note">Failed to load agent kinds: {loadError}</p>}
      {error !== null && <p className="error-note">{error}</p>}
      {note !== null && <p className="saved-note">{note}</p>}
      {kinds !== null && (
        <KindRows
          kinds={kinds}
          tombstoned={tombstoned}
          confirmingDeleteName={confirmingDeleteName}
          onEdit={(spec) => {
            setError(null);
            setNote(null);
            openKindEditor(spec, setEditor);
          }}
          onDelete={deleteKind}
          onRestore={(name) => {
            setError(null);
            setNote(null);
            restoreShippedKind(name, reload).catch((err: unknown) => setError(errorMessage(err)));
          }}
        />
      )}
      <div className="wizard-actions">
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            setError(null);
            setNote(null);
            setEditor({ mode: "create", draft: { ...NEW_KIND_DRAFT } });
          }}
        >
          + New kind
        </button>
      </div>
      {editor !== null && (
        <AgentKindForm
          draft={editor.draft}
          editing={editor.mode === "edit"}
          saving={saving}
          error={error}
          onChange={(draft) => setEditor({ ...editor, draft })}
          onSave={saveEditor}
          onCancel={() => setEditor(null)}
        />
      )}
    </section>
  );
}
