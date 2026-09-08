/**
 * Step 3 — repository source: pick one of the gh-authenticated user's repos
 * (issue #217: searchable selector backed by `GET /api/gh/repos`; the clone
 * URL is derived verbatim from real repo data, so the #216 case-mangle bug
 * class is structurally impossible in this path), or create a new GitHub
 * repo (created repos are **private by default** with an explicit public
 * toggle). Cross-step form state lives in the wizard parent
 * ({@link WizardForm}); the repo list is the selector's own fetch state.
 */
import { useCallback, useEffect, useState } from "react";

import type { AccessibleRepo } from "@pideck/shared";

import { apiListAccessibleRepos, errorMessage } from "../../lib/api";
import type { WizardForm } from "./wizard-form";
import { StepPanel } from "./StepPanel";

/** Clone URL for a listed repo — composed verbatim from real repo data. */
export function cloneUrl(repo: AccessibleRepo): string {
  return `https://github.com/${repo.owner}/${repo.name}`;
}

/** Case-insensitive `owner/name` filter for the repo list. */
export function filterRepos(repos: AccessibleRepo[], needle: string): AccessibleRepo[] {
  const query = needle.trim().toLowerCase();
  if (query.length === 0) return repos;
  return repos.filter((repo) => `${repo.owner}/${repo.name}`.toLowerCase().includes(query));
}

/**
 * Searchable repo selector (issue #217). Loads the accessible repos once on
 * mount, filters case-insensitively on `owner/name`, and hands the selected
 * repo's verbatim clone URL back to the wizard form.
 */
function RepoSelector(props: { selectedUrl: string; onSelect: (repoUrl: string) => void }) {
  const { selectedUrl, onSelect } = props;
  const [repos, setRepos] = useState<AccessibleRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(() => {
    setError(null);
    apiListAccessibleRepos()
      .then(setRepos)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  useEffect(load, [load]);

  if (error !== null) {
    return (
      <div className="field">
        <p className="error-note">Could not load your repositories: {error}</p>
        <button type="button" className="button" onClick={load}>
          Retry
        </button>
      </div>
    );
  }
  if (repos === null) return <p className="empty">Loading your repositories…</p>;

  const visible = filterRepos(repos, filter);
  return (
    <div className="field">
      <label htmlFor="repo-filter">Filter repositories</label>
      <input
        id="repo-filter"
        type="text"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="owner/name"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {visible.length === 0 ? (
        <p className="empty">No repositories match{filter.trim().length > 0 ? ` "${filter.trim()}"` : ""}.</p>
      ): (
        <ul className="repo-selector">
          {visible.map((repo) => {
            const url = cloneUrl(repo);
            return (
              <li key={url}>
                <button
                  type="button"
                  className={`repo-option ${selectedUrl === url ? "selected" : ""}`}
                  onClick={() => onSelect(url)}
                >
                  <code>
                    {repo.owner}/{repo.name}
                  </code>
                  <small>{repo.isPrivate ? "private" : "public"}</small>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function RepoSourceStep(props: {
  form: WizardForm;
  onChange: (patch: Partial<WizardForm>) => void;
  onError: (message: string | null) => void;
  error: string | null;
  onContinue: () => void;
  onBack?: () => void;
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
            <strong>Clone from GitHub</strong>
            <small>Pick one of your repositories.</small>
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
        <>
          <RepoSelector selectedUrl={form.repoUrl} onSelect={(repoUrl) => onChange({ repoUrl })} />
          <div className="field">
            <label htmlFor="repo-name">Project name (optional)</label>
            {/* autoCapitalize/autoCorrect off (issue #216): browser
                autocapitalize mangled typed repo names (pidecktest →
                Pidecktest), 404ing the clone. */}
            <input
              id="repo-name"
              type="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="defaults to owner-repo"
              value={form.repoName}
              onChange={(e) => onChange({ repoName: e.target.value })}
            />
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="new-repo-name">New repository name</label>
            <input
              id="new-repo-name"
              type="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="my-project"
              value={form.repoName}
              onChange={(e) => onChange({ repoName: e.target.value })}
            />
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
        {onBack !== undefined && (
          <button type="button" className="button" onClick={onBack}>
            Back
          </button>
        )}
      </div>
    </StepPanel>
  );
}
