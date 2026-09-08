/**
 * Step 4 — auto-create-agents question: should issues auto-create agents?
 * Answering yes captures the GitHub username stored as the project's
 * `autoAgentUsername`. Form state lives in the wizard parent
 * ({@link WizardForm}); validation happens in the parent's finish handler.
 */
import type { WizardForm } from "./wizard-form";
import { StepPanel } from "./StepPanel";

export function AutoAgentStep(props: {
  form: WizardForm;
  onChange: (patch: Partial<WizardForm>) => void;
  error: string | null;
  submitting: boolean;
  onFinish: () => void;
  onBack: () => void;
}) {
  const { form, onChange, error, submitting, onFinish, onBack } = props;
  return (
    <StepPanel title="Auto-create agents?">
      <p className="empty">Should newly created or assigned issues automatically spawn a worker agent?</p>
      <div className="choice-row">
        <label className={`choice-card ${form.autoAgent === "no" ? "selected" : ""}`}>
          <input
            type="radio"
            name="autoagent"
            checked={form.autoAgent === "no"}
            onChange={() => onChange({ autoAgent: "no" })}
          />
          <span>
            <strong>No</strong>
            <small>Workers are spawned manually.</small>
          </span>
        </label>
        <label className={`choice-card ${form.autoAgent === "yes" ? "selected" : ""}`}>
          <input
            type="radio"
            name="autoagent"
            checked={form.autoAgent === "yes"}
            onChange={() => onChange({ autoAgent: "yes" })}
          />
          <span>
            <strong>Yes</strong>
            <small>Watch a GitHub username's issues.</small>
          </span>
        </label>
      </div>
      {form.autoAgent === "yes" && (
        <div className="field">
          <label htmlFor="auto-agent-username">GitHub username to watch</label>
          <input
            id="auto-agent-username"
            type="text"
            placeholder="e.g. your-login"
            value={form.username}
            onChange={(e) => onChange({ username: e.target.value })}
          />
          <small className="field-hint">
            Issues created by or assigned to this user spawn a worker automatically.
          </small>
        </div>
      )}
      {error !== null && <p className="error-note">{error}</p>}
      <div className="wizard-actions">
        <button type="button" className="button button-primary" disabled={submitting} onClick={onFinish}>
          {submitting ? "Registering…" : "Finish — register project"}
        </button>
        <button type="button" className="button" onClick={onBack}>
          Back
        </button>
      </div>
    </StepPanel>
  );
}
