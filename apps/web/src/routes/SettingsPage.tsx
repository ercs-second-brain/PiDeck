import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { Project } from "@agentskiss/shared";
import { apiUpdateProject, errorMessage } from "../lib/api";
import { UpdateBanner } from "../components/UpdateBanner";
import { PiAuthBanner } from "../components/PiAuthBanner";
import { boardStore, useAppState } from "../store/store";

/**
 * Project settings surface: auto-agent username, the worker concurrency
 * cap, and the persistent pi auth status banner (issue #57).
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
      <UpdateBanner />
      <h1 className="page-title">{project.name} — settings</h1>
      <p className="project-repo">{project.repoUrl}</p>
      <PiAuthBanner />
      <SettingsForm key={project.id} project={project} />
      <Link to={`/projects/${project.id}`} className="back-link">
        ← Board
      </Link>
    </main>
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
