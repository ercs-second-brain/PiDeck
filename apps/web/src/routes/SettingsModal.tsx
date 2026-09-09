/**
 * Settings as modal dialogs over the current view (issue #264): the
 * sidebar's per-project ⋯ menu opens {@link ProjectSettingsModal}, the
 * sidebar footer opens {@link GlobalSettingsModal} — there are no dedicated
 * settings routes or pages anymore, and no back links. The per-project vs
 * global distinction is unchanged: the project modal edits the project's
 * autoAgentUsername and workerConcurrency cap; both modals show the
 * daemon-wide {@link GlobalWorkerSettings} toggles.
 */
import { useEffect, useState } from "react";
import type { Project, Settings } from "@pideck/shared";
import { apiUpdateProject, apiUpdateSettings, apiGetSettings, errorMessage } from "../lib/api";
import { useProject } from "../lib/use-project";
import { BROWSER_NOTIFICATIONS_UNSUPPORTED, permissionState, requestNotificationPermission } from "../components/NotificationCenter";
import { boardStore } from "../store/store";

/**
 * Global settings modal (issue #264, originally the global settings page
 * #176): the daemon-wide worker-pipeline toggles (#106) and the
 * merged-PR browser-notification toggle (#111), reachable from the sidebar
 * footer without picking a project first. pi/gh auth is PiDeck-global
 * (issue #183) — it surfaces via the global onboarding modal, not here.
 */
export function GlobalSettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Global settings">
      <div className="modal-card">
        <button type="button" className="modal-close" aria-label="Close global settings" onClick={onClose}>
          ×
        </button>
        <h1 className="page-title">Global settings</h1>
        <p className="project-repo">Daemon-wide — applies to every project.</p>
        <GlobalWorkerSettings />
      </div>
    </div>
  );
}

/**
 * Project settings modal (issue #264, originally the project settings
 * page): auto-agent username and the worker concurrency cap, plus the
 * daemon-wide worker-pipeline toggles (issue #106) and the merged-PR
 * browser-notification toggle (issue #111). pi/gh auth is PiDeck-global,
 * configured once (issue #183) — it is no longer surfaced per project
 * here; the global onboarding modal opens whenever pi has no ready
 * provider.
 */
export function ProjectSettingsModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { project, loaded } = useProject(projectId);
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Project settings">
      <div className="modal-card">
        <button type="button" className="modal-close" aria-label="Close project settings" onClick={onClose}>
          ×
        </button>
        {project === undefined ? (
          <p className="empty">{loaded ? `Project “${projectId}” not found.` : "Loading…"}</p>
        ) : (
          <>
            <h1 className="page-title">{project.name} — settings</h1>
            <p className="project-repo">{project.repoUrl}</p>
            <GlobalWorkerSettings />
            <SettingsForm key={project.id} project={project} />
          </>
        )}
      </div>
    </div>
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
 * Notification permission (a denied grant keeps the toggle off). Rendered
 * by both settings modals (issue #264). Exported for tests (the
 * toggle-display ratchet in SettingsModal.test.tsx).
 */
export function GlobalWorkerSettings() {
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
    if (key === "browserMergeNotifications" && value) {
      // Issue #204: on insecure origins (plain-HTTP LAN deployments) the
      // permission can never be granted — say so honestly and keep the
      // daemon setting off instead of pointing at impossible browser settings.
      if (permissionState() === "unsupported") {
        setError(BROWSER_NOTIFICATIONS_UNSUPPORTED);
        return;
      }
      // Issue #111: the permission prompt needs a user gesture — this click.
      // A denied/blocked grant reverts (the daemon setting stays off).
      if ((await requestNotificationPermission()) !== "granted") {
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
        {/* Issue #204: the Notification API only exists in secure contexts (HTTPS or
            localhost) — on plain-HTTP LAN deployments the toggle is disabled with an
            honest message instead of the impossible "allow them in browser settings". */}
        {permissionState() === "unsupported" ? (
          <label className="toggle-row">
            <input type="checkbox" checked={false} readOnly disabled />
            <span>
              {NOTIFICATION_TOGGLE.label}
              <small className="field-hint"> {BROWSER_NOTIFICATIONS_UNSUPPORTED}</small>
            </span>
          </label>
        ) : (
          <div className="settings-form">{renderToggle(NOTIFICATION_TOGGLE)}</div>
        )}
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
