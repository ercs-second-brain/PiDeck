import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { Project, Settings } from "@pideck/shared";
import { apiGetSettings, apiUpdateProject, apiUpdateSettings, errorMessage } from "../lib/api";
import { PiAuthBanner } from "../components/PiAuthBanner";
import { useProject } from "../lib/use-project";
import { boardStore } from "../store/store";

/**
 * Project settings surface: auto-agent username, the worker concurrency
 * cap, the persistent pi auth status banner (issue #57), the daemon-
 * wide worker-pipeline toggles (issue #106), and the merged-PR browser-
 * notification toggle (issue #111).
 * `workerConcurrency` unset means unbounded (issue #14 semantics: every
 * unblocked issue spawns a worker immediately); saving an empty field sends
 * `null` explicitly so the cap actually clears (issue #168).
 */
export function SettingsPage() {
  const { projectId } = useParams();
  const { project, fallback } = useProject(projectId);
  if (project === undefined) return fallback;

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

/** The merged-PR browser-notification toggle (issue #111, default OFF). */
const NOTIFICATION_TOGGLE: { key: "browserMergeNotifications"; label: string; hint: string } = {
  key: "browserMergeNotifications",
  label: "Browser notifications for merged PRs",
  hint: "Fires an OS-level browser notification when a worker's PR merges, in addition to the in-app toast. Default off.",
};

type ToggleKey = (typeof WORKER_TOGGLES)[number]["key"] | (typeof NOTIFICATION_TOGGLE)["key"];

/**
 * Daemon-wide toggles (issues #106, #111): global for all projects,
 * persisted by the daemon, read fresh on every pipeline decision — a
 * change here takes effect without a daemon restart. Each toggle saves
 * immediately. Enabling browser notifications first asks the browser for
 * Notification permission (a denied grant keeps the toggle off).
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

  const toggle = async (key: ToggleKey, value: boolean): Promise<void> => {
    // Issue #111: the permission prompt needs a user gesture — this click.
    // A denied/blocked grant reverts (the daemon setting stays off).
    if (key === "browserMergeNotifications" && value && typeof Notification !== "undefined" && Notification.permission !== "granted") {
      if ((await Notification.requestPermission()) !== "granted") {
        setError("Browser notifications are blocked for this site — allow them in the browser's site settings, then try again.");
        return;
      }
    }
    setSavingKey(key);
    setError(null);
    apiUpdateSettings({ [key]: value })
      .then(setSettings)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setSavingKey(null));
  };

  const renderToggle = (toggleDef: { key: ToggleKey; label: string; hint: string }) => (
    <label key={toggleDef.key} className="toggle-row">
      <input
        type="checkbox"
        checked={settings !== null && settings[toggleDef.key]}
        disabled={savingKey !== null || settings === null}
        onChange={(e) => void toggle(toggleDef.key, e.target.checked)}
      />
      <span>
        {toggleDef.label}
        <small className="field-hint"> {toggleDef.hint}</small>
      </span>
    </label>
  );

  return (
    <>
      <section className="global-worker-settings">
        <h2 className="section-title">Worker pipeline (all projects)</h2>
        {loadError !== null && <p className="error-note">Failed to load global settings: {loadError}</p>}
        <div className="settings-form">{WORKER_TOGGLES.map(renderToggle)}</div>
      </section>
      <section className="global-worker-settings">
        <h2 className="section-title">Notifications (all projects)</h2>
        <div className="settings-form">{renderToggle(NOTIFICATION_TOGGLE)}</div>
      </section>
      {error !== null && <p className="error-note">{error}</p>}
    </>
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
        setError("Worker concurrency must be an integer between 1 and 16 (empty = unlimited).");
        return;
      }
      cap = parsed;
    }
    setSaving(true);
    setError(null);
    try {
      await apiUpdateProject(project.id, {
        settings: {
          autoAgentUsername: trimmed.length > 0 ? trimmed : null,
          // Issue #168: an empty field sends `null` explicitly — the daemon
          // treats it as unset (unbounded); omitting the field would keep
          // the previous cap instead of clearing it.
          workerConcurrency: cap ?? null,
        },
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
          placeholder="empty = unlimited"
          value={concurrency}
          onChange={(e) => {
            setConcurrency(e.target.value);
            setSaved(false);
          }}
        />
        <small className="field-hint">
          Max workers running concurrently for this project (1–16). Empty = unlimited.
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
