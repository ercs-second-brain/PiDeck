/**
 * Agent-kinds section of the agent-assets modal (issue #332): the
 * registry-v2 persona editor. Consumes the #347 CRUD API — the shipped
 * kinds render as immutable rows (their prompts are editable via the
 * prompt-override surface above, issue #315); every user-defined kind can
 * be edited (persona content, task template, config, via
 * {@link AgentKindForm}) and deleted (the daemon's 409 guardrail blocks
 * kinds with live sessions). The "+ New kind" flow creates a validated
 * spec. Changes affect future spawns only; live panes are untouched.
 */

import { useEffect, useState } from "react";
import type { AgentKindSpec } from "@pideck/shared";

import { apiCreateAgentKind, apiDeleteAgentKind, apiListAgentKinds, apiUpdateAgentKind, errorMessage } from "../lib/api";
import { AgentKindForm, NEW_KIND_DRAFT, draftFromSpec, parseDraft, type KindDraft } from "./AgentKindForm";

/** The editor's modal state: create, or edit one custom kind. */
type KindEditor = { mode: "create"; draft: KindDraft } | { mode: "edit"; name: string; draft: KindDraft };

/** One row per registry kind: label, id, shipped/custom chip, actions. */
export function KindRows(props: {
  kinds: AgentKindSpec[];
  onEdit: (spec: AgentKindSpec) => void;
  onDelete: (name: string) => void;
  confirmingDeleteName: string | null;
}) {
  return (
    <ul className="asset-list">
      {props.kinds.map((spec) => (
        <li key={spec.name} className="asset-row">
          <span className="asset-name">{spec.menuLabel ?? spec.label}</span>
          <span className="asset-name asset-name-mono">{spec.name}</span>
          <span className={`asset-chip${spec.persona === undefined ? "" : " asset-chip-on"}`}>
            {spec.persona === undefined ? "shipped" : "custom"}
          </span>
          <span className="asset-personas">
            {spec.trigger === "auto" ? "auto" : "waits for input"} · reports to{" "}
            {spec.reportTarget === "orchestrator" ? "the orchestrator" : "the calling session"}
          </span>
          {spec.persona !== undefined && (
            <>
              <button type="button" className="asset-action" onClick={() => props.onEdit(spec)}>
                Edit
              </button>
              <button type="button" className="asset-action asset-action-dim" onClick={() => props.onDelete(spec.name)}>
                {props.confirmingDeleteName === spec.name ? "Confirm delete?" : "Delete"}
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
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

/** The self-fetching agent-kinds section (registry v2 via `GET /api/agent-kinds`). */
export function AgentKindsSection() {
  const { kinds, loadError, reload } = useAgentKinds();
  const [editor, setEditor] = useState<KindEditor | null>(null);
  const [confirmingDeleteName, setConfirmingDeleteName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
        Spawnable agent personas from the kind registry. Shipped kinds are immutable — edit their prompts via the
        overrides above. Custom kinds are yours: edit persona, task template, and config; deleting needs no live
        sessions of the kind. Changes affect future spawns.
      </p>
      {loadError !== null && <p className="error-note">Failed to load agent kinds: {loadError}</p>}
      {error !== null && <p className="error-note">{error}</p>}
      {note !== null && <p className="saved-note">{note}</p>}
      {kinds !== null && (
        <KindRows
          kinds={kinds}
          confirmingDeleteName={confirmingDeleteName}
          onEdit={(spec) => {
            setError(null);
            setNote(null);
            setEditor({ mode: "edit", name: spec.name, draft: draftFromSpec(spec) });
          }}
          onDelete={deleteKind}
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
