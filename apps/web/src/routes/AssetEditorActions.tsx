/**
 * The shared Cancel/Save footer of the in-modal asset editors — the #315
 * prompt/skill editor and the #332 agent-kind form use the same buttons.
 */

export function EditorActions(props: { saving: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="wizard-actions">
      <button type="button" className="asset-action asset-action-dim" onClick={props.onCancel}>
        Cancel
      </button>
      <button type="button" className="button button-primary" onClick={props.onSave} disabled={props.saving}>
        {props.saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
