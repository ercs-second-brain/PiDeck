/**
 * Step 3 — repository source: clone from git, or create a new GitHub repo
 * (created repos are **private by default** with an explicit public toggle).
 * Form state lives in the wizard parent ({@link WizardForm}); this step
 * validates its own fields before handing control back.
 */
import type { WizardForm } from "./wizard-form";
import { StepPanel } from "./StepPanel";

export function RepoSourceStep(props: {
  form: WizardForm;
  onChange: (patch: Partial<WizardForm>) => void;
  onError: (message: string | null) => void;
  error: string | null;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { form, onChange, onError, error, onContinue, onBack } = props;
  return (
    <StepPanel title="Connect a repository">
      <div className="choice-row">
        <label className={`choice-card ${form.mode === "clone" ? "selected" : ""}`}>
          <input
            type="radio"
            name="mode"
            checked={form.mode === "clone"}
            onChange={() => {
              onChange({ mode: "clone" });
              onError(null);
            }}
          />
          <span>
            <strong>Clone from git</strong>
            <small>Register an existing GitHub repository.</small>
          </span>
        </label>
        <label className={`choice-card ${form.mode === "create" ? "selected" : ""}`}>
          <input
            type="radio"
            name="mode"
            checked={form.mode === "create"}
            onChange={() => {
              onChange({ mode: "create" });
              onError(null);
            }}
          />
          <span>
            <strong>Create a new repo</strong>
            <small>Created via gh on the daemon host.</small>
          </span>
        </label>
      </div>

      {form.mode === "clone" ? (
        <div className="field">
          <label htmlFor="repo-url">Repository URL</label>
          <input
            id="repo-url"
            type="text"
            placeholder="https://github.com/owner/repo (or owner/repo)"
            value={form.repoUrl}
            onChange={(e) => onChange({ repoUrl: e.target.value })}
          />
          <div className="field">
            <label htmlFor="repo-name">Project name (optional)</label>
            <input id="repo-name" type="text" placeholder="defaults to owner-repo" value={form.repoName} onChange={(e) => onChange({ repoName: e.target.value })} />
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="new-repo-name">New repository name</label>
            <input id="new-repo-name" type="text" placeholder="my-project" value={form.repoName} onChange={(e) => onChange({ repoName: e.target.value })} />
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={form.isPublic} onChange={(e) => onChange({ isPublic: e.target.checked })} />
            <span>
              Public repository <small>(recommended default is private)</small>
            </span>
          </label>
        </>
      )}

      {error !== null && <p className="error-note">{error}</p>}
      <div className="wizard-actions">
        <button type="button" className="button button-primary" onClick={onContinue}>
          Continue
        </button>
        <button type="button" className="button" onClick={onBack}>
          Back
        </button>
      </div>
    </StepPanel>
  );
}
