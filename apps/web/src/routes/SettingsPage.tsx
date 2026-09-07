import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { Project, Settings } from "@agentskiss/shared";
import { apiGetSettings, apiUpdateProject, apiUpdateSettings, errorMessage } from "../lib/api";
import { PiAuthBanner } from "../components/PiAuthBanner";
import { boardStore, useAppState } from "../store/store";

/**
 * Project settings surface: auto-agent username, the worker concurrency
 * cap, the persistent pi auth status banner (issue #57), and the daemon-
 * wide worker-pipeline toggles (issue #106).
 * `workerConcurrency` unset means unbounded (issue #14 semantics: every
 * unblocked issue spawns a worker immediately).
 */
export function SettingsPage() {
  const { projectId } = useParams();
  const state = useAppState();

  useEffect(() => {
    if (projectId === undefined) return;
    void boardStore.loadProject(projectId).catch(() => boardStore.refresh());
  }, [projectId]);

  const project = state.projects.find((p) => p.id === projectId);
  if (projectId === undefined || project === undefined) {
    return (
      <main className="page">
        <p className="empty">{state.loaded ? `Project “${projectId ?? "?"}” not found.` : "Loading…"}</p>
        <Link to="/" className="back-link">
          ← All projects
        </Link>
      </main>
    );
  }

  return (
    <main className="page">
      <h1 className="page-title">{project.name} — settings</h1>
      <p className="project-repo">{project.repoUrl}</p>
      <PiAuthBanner />
      <GlobalWorkerSettings />
      <SettingsForm key={project.id} project={project} />
      <Link to={`/projects/${project.id}`} className="back-link">
        ← Board
      </Link>
    </main>
  );
}

/** The three worker-pipeline toggles (issue #106): what they gate, in the PR loop. */
const WORKER_TOGGLES: Array<{ key: "terminateOnMerge" | "autoFixCi" | "autoFixReviewComments"; label: string; hint: string }> = [
  {
    key: "terminateOnMerge",
    label: "Terminate workers on merge",
    hint: "When a worker's PR merges, its terminal pane is killed and it is archived. Off: the worker stays as done.",
  },
  {
    key: "autoFixCi",
    label: "Automatically fix CI failures",
    hint: "Workers are driven to fix failing CI on their PRs. Off: the pipeline skips the CI-fix step.",
  },
  {
    key: "autoFixReviewComments",
    label: "Automatically fix review comments",
    hint: "New review comments are delivered to the PR's worker for addressing. Off: the pipeline skips delivery.",
  },
];

/**
 * Daemon-wide worker-pipeline toggles (issue #106): global for all projects,
 * persisted by the daemon, read fresh on every pipeline decision — a change
 * here takes effect without a daemon restart. Each toggle saves immediately.
 */
function GlobalWorkerSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGetSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (key: (typeof WORKER_TOGGLES)[number]["key"], value: boolean): void => {
    setSavingKey(key);
    setError(null);
    apiUpdateSettings({ [key]: value })
      .then(setSettings)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setSavingKey(null));
  };

  return (
    <section className="global-worker-settings">
      <h2 className="section-title">Worker pipeline (all projects)</h2>
      {loadError !== null && <p className="error-note">Failed to load global settings: {loadError}</p>}
      {settings !== null && (
        <div className="settings-form">
          {WORKER_TOGGLES.map((toggleDef) => (
            <label key={toggleDef.key} className="toggle-row">
              <input
                type="checkbox"
                checked={settings[toggleDef.key]}
                disabled={savingKey !== null}
                onChange={(e) => toggle(toggleDef.key, e.target.checked)}
              />
              <span>
                {toggleDef.label}
                <small className="field-hint"> {toggleDef.hint}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {error !== null && <p className="error-note">{error}</p>}
    </section>
  );
}

function SettingsForm({ project }: { project: Project }) {
  const [username, setUsername] = useState(project.settings.autoAgentUsername ?? "");
  const [concurrency, setConcurrency] = useState(project.settings.workerConcurrency?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const trimmed = username.trim();
    const capRaw = concurrency.trim();
    let cap: number | undefined;
    if (capRaw.length > 0) {
      const parsed = Number(capRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
        setError("Worker concurrency must be an integer between 1 and 16 (empty = unbounded).");
        return;
      }
      cap = parsed;
    }
    setSaving(true);
    setError(null);
    try {
      await apiUpdateProject(project.id, {
        settings: { autoAgentUsername: trimmed.length > 0 ? trimmed : null, ...(cap !== undefined ? { workerConcurrency: cap } : {}) },
      });
      setSaved(true);
      await boardStore.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="field">
        <label htmlFor="auto-agent-username">Auto-agent username</label>
        <input
          id="auto-agent-username"
          type="text"
          placeholder="GitHub username, empty = disabled"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setSaved(false);
          }}
        />
        <small className="field-hint">
          Issues created by or assigned to this user auto-spawn a worker. Empty disables auto-spawn.
        </small>
      </div>
      <div className="field">
        <label htmlFor="worker-concurrency">Worker concurrency cap</label>
        <input
          id="worker-concurrency"
          type="number"
          min={1}
          max={16}
          placeholder="empty = unbounded"
          value={concurrency}
          onChange={(e) => {
            setConcurrency(e.target.value);
            setSaved(false);
          }}
        />
        <small className="field-hint">
          Max workers running concurrently for this project (1–16). Empty means unbounded.
        </small>
      </div>
      {error !== null && <p className="error-note">{error}</p>}
      <div className="wizard-actions">
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        {saved && <span className="saved-note">Saved ✓</span>}
      </div>
    </form>
  );
}
