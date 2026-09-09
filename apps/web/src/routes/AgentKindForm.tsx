/**
 * The agent-kind editor form (issue #332): identity (kind id, editable only
 * on create), persona content, and the spec-v2 config — spawnableBy
 * (multi-select of roles), callerWaits/readOnly/workerLike toggles, trigger
 * (auto/waitForInput, with the task template shown exactly for `auto`),
 * and the report target. Validation runs against the shared upsert schema
 * (the same zod contract the daemon enforces) in {@link parseDraft}.
 */

import type { ReactNode } from "react";
import {
  AGENT_KIND_SPAWNABLE_ROLES,
  upsertAgentKindRequestSchema,
  type AgentKindReportTarget,
  type AgentKindSpawnableRole,
  type AgentKindTrigger,
  type AgentKindSpec,
  type UpsertAgentKindRequest,
} from "@pideck/shared";

import { EditorActions } from "./AssetEditorActions";

/** Human labels for the spawnableBy role checkboxes. */
const ROLE_LABELS: Record<AgentKindSpawnableRole, string> = {
  global: "Global agent",
  orchestrator: "Orchestrator",
  worker: "Worker",
  reviewer: "Reviewer",
};

const REPORT_TARGET_LABELS: Record<AgentKindReportTarget, string> = {
  caller: "Calling session",
  orchestrator: "Project orchestrator",
};

/**
 * The form's working state: every spec-v2 field the editor touches, with
 * empty strings where the schema wants `undefined` (persona, taskTemplate)
 * so the textareas stay controlled.
 */
export interface KindDraft {
  name: string;
  label: string;
  persona: string;
  spawnableBy: AgentKindSpawnableRole[];
  callerWaits: boolean;
  readOnly: boolean;
  trigger: AgentKindTrigger;
  taskTemplate: string;
  reportTarget: AgentKindReportTarget;
  workerLike: boolean;
}

/** Prefill for the create-new-kind flow: all roles, reactive, worker-like. */
export const NEW_KIND_DRAFT: KindDraft = {
  name: "",
  label: "",
  persona: "",
  spawnableBy: [...AGENT_KIND_SPAWNABLE_ROLES],
  callerWaits: false,
  readOnly: false,
  trigger: "waitForInput",
  taskTemplate: "",
  reportTarget: "caller",
  workerLike: true,
};

export const draftFromSpec = (spec: AgentKindSpec): KindDraft => ({
  name: spec.name,
  label: spec.label,
  persona: spec.persona ?? "",
  spawnableBy: [...spec.spawnableBy],
  callerWaits: spec.callerWaits,
  readOnly: spec.readOnly,
  trigger: spec.trigger,
  taskTemplate: spec.taskTemplate ?? "",
  reportTarget: spec.reportTarget,
  workerLike: spec.workerLike,
});

/**
 * Client-side validation against the shared upsert schema: returns the
 * typed request body or the first issue as a readable string.
 * `persona`/`taskTemplate` only enter the parse when non-empty, so their
 * `min(1)` rules fire as the schema intends; a `waitForInput` draft never
 * carries a template (the trigger pairing is the schema's job).
 */
export function parseDraft(draft: KindDraft): UpsertAgentKindRequest | string {
  const result = upsertAgentKindRequestSchema.safeParse({
    name: draft.name.trim(),
    label: draft.label.trim(),
    persona: draft.persona.trim() === "" ? undefined : draft.persona.trim(),
    spawnableBy: draft.spawnableBy,
    callerWaits: draft.callerWaits,
    readOnly: draft.readOnly,
    trigger: draft.trigger,
    taskTemplate: draft.trigger === "auto" && draft.taskTemplate.trim() !== "" ? draft.taskTemplate.trim() : undefined,
    reportTarget: draft.reportTarget,
    workerLike: draft.workerLike,
  });
  if (!result.success) {
    const issue = result.error.issues[0];
    return issue === undefined ? "validation failed" : `${issue.path.join(".")} — ${issue.message}`;
  }
  return result.data;
}

/** One labeled checkbox row (the toggle chrome from the #315 editor). */
function ToggleCheck(props: { checked: boolean; label: string; onToggle: () => void }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={props.checked} onChange={props.onToggle} />
      <span>{props.label}</span>
    </label>
  );
}

/** The spawnableBy role multi-select (spec v2). */
function RoleChecks(props: { selected: AgentKindSpawnableRole[]; onToggle: (role: AgentKindSpawnableRole) => void }) {
  return (
    <div className="asset-persona-checks">
      {AGENT_KIND_SPAWNABLE_ROLES.map((role) => (
        <ToggleCheck
          key={role}
          checked={props.selected.includes(role)}
          label={ROLE_LABELS[role]}
          onToggle={() => props.onToggle(role)}
        />
      ))}
    </div>
  );
}

/** The in-modal kind editor: identity (create only), persona, and config. */
/** One labeled field wrapper: label + control + optional hint. */
function Field(props: { id?: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.children}
      {props.hint !== undefined && <small className="field-hint">{props.hint}</small>}
    </div>
  );
}

/** One labeled text input (kind id, label). */
function TextField(props: { id: string; label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <Field id={props.id} label={props.label}>
      <input
        id={props.id}
        type="text"
        placeholder="e.g. docs-writer"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </Field>
  );
}

/** One labeled textarea (persona content, task template). */
function TextArea(props: { id: string; label: string; className: string; value: string; onChange: (value: string) => void }) {
  return (
    <Field id={props.id} label={props.label}>
      <textarea
        id={props.id}
        className={props.className}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
      />
    </Field>
  );
}

/** One labeled select (trigger, report target). */
function SelectField(props: { id: string; label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return (
    <Field id={props.id} label={props.label}>
      <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
}

const TRIGGER_OPTIONS: readonly (readonly [string, string])[] = [
  ["auto", "Auto — deliver the task template on boot"],
  ["waitForInput", "Wait for input — reactive, the caller supplies it"],
];

export function AgentKindForm(props: {
  draft: KindDraft;
  /** Editing an existing custom kind pins the kind id (ids are immutable). */
  editing: boolean;
  saving: boolean;
  error: string | null;
  onChange: (draft: KindDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { draft, onChange } = props;
  const toggleRole = (role: AgentKindSpawnableRole): void =>
    onChange({
      ...draft,
      spawnableBy: draft.spawnableBy.includes(role)
        ? draft.spawnableBy.filter((entry) => entry !== role)
        : [...draft.spawnableBy, role],
    });
  return (
    <section className="agent-assets-editor">
      <h2 className="section-title">{props.editing ? `Edit agent kind "${draft.name}"` : "New agent kind"}</h2>
      <TextField id="agent-kind-id" label="Kind id" value={draft.name} disabled={props.editing} onChange={(name) => onChange({ ...draft, name })} />
      <TextField id="agent-kind-label" label="Label (sidebar name, ≤ 20 chars)" value={draft.label} onChange={(label) => onChange({ ...draft, label })} />
      <TextArea
        id="agent-kind-persona"
        label="Persona content (the boot prompt)"
        className="modal-textarea asset-editor-text"
        value={draft.persona}
        onChange={(persona) => onChange({ ...draft, persona })}
      />
      <Field label="Spawnable by" hint="Restricts which agent roles may spawn this kind; user-driven spawns are always allowed.">
        <RoleChecks selected={draft.spawnableBy} onToggle={toggleRole} />
      </Field>
      <div className="asset-persona-checks">
        <ToggleCheck checked={draft.callerWaits} label="Caller waits for the report" onToggle={() => onChange({ ...draft, callerWaits: !draft.callerWaits })} />
        <ToggleCheck checked={draft.readOnly} label="Read-only (no edit/write tools)" onToggle={() => onChange({ ...draft, readOnly: !draft.readOnly })} />
        <ToggleCheck
          checked={draft.workerLike}
          label="Worker-like (own worktree, counts against concurrency)"
          onToggle={() => onChange({ ...draft, workerLike: !draft.workerLike })}
        />
      </div>
      <SelectField
        id="agent-kind-trigger"
        label="Trigger"
        value={draft.trigger}
        options={TRIGGER_OPTIONS}
        onChange={(value) => onChange({ ...draft, trigger: value as AgentKindTrigger })}
      />
      {draft.trigger === "auto" && (
        <TextArea
          id="agent-kind-task"
          label="Task template (typed into the pane after boot)"
          className="modal-textarea"
          value={draft.taskTemplate}
          onChange={(taskTemplate) => onChange({ ...draft, taskTemplate })}
        />
      )}
      <SelectField
        id="agent-kind-report"
        label="Report target"
        value={draft.reportTarget}
        options={Object.entries(REPORT_TARGET_LABELS)}
        onChange={(value) => onChange({ ...draft, reportTarget: value as AgentKindReportTarget })}
      />
      {props.error !== null && <p className="error-note">{props.error}</p>}
      <EditorActions saving={props.saving} onSave={props.onSave} onCancel={props.onCancel} />
    </section>
  );
}
