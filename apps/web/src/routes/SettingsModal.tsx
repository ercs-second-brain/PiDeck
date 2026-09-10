/**
 * Settings as modal dialogs over the current view (issue #264): the
 * sidebar's per-project ⋯ menu opens {@link ProjectSettingsModal}, the
 * sidebar footer opens {@link GlobalSettingsModal} — there are no dedicated
 * settings routes or pages anymore, and no back links. The per-project vs
 * global distinction is unchanged: the project modal edits the project's
 * workerConcurrency cap; both modals show the daemon-wide {@link
 * GlobalWorkerSettings} toggles.
 */
import { useEffect, useState } from "react";
import type { SettingsRead, UpdateSettingsRequest } from "@pideck/shared";
import { apiUpdateSettings, apiGetSettings, errorMessage } from "../lib/api";
import { useProject } from "../lib/use-project";
import { BROWSER_NOTIFICATIONS_UNSUPPORTED, permissionState, requestNotificationPermission } from "../components/NotificationCenter";
import { Toggle } from "../components/Toggle";
import { Modal } from "../components/Modal";
import { SettingsForm } from "./ProjectSettingsForm";

/**
 * Global settings modal (issue #264, originally the global settings page
 * #176): the daemon-wide worker-pipeline toggles (#106) and the
 * merged-PR browser-notification toggle (#111), reachable from the sidebar
 * footer without picking a project first. pi/gh auth is PiDeck-global
 * (issue #183) — it surfaces via the global onboarding modal, not here.
 */
export function GlobalSettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="Global settings" closeLabel="Close global settings" onClose={onClose}>
      <h1 className="modal-title">Global settings</h1>
      <p className="project-repo">Daemon-wide — applies to every project.</p>
      <GlobalWorkerSettings />
    </Modal>
  );
}

/**
 * Project settings modal (issue #264, originally the project settings
 * page): the worker concurrency cap plus the
 * daemon-wide worker-pipeline toggles (issue #106) and the merged-PR
 * browser-notification toggle (issue #111). pi/gh auth is PiDeck-global,
 * configured once (issue #183) — it is no longer surfaced per project
 * here; the global onboarding modal opens whenever pi has no ready
 * provider.
 */
export function ProjectSettingsModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { project, loaded } = useProject(projectId);
  return (
    <Modal label="Project settings" closeLabel="Close project settings" onClose={onClose}>
      {project === undefined ? (
        <p className="empty">{loaded ? `Project “${projectId}” not found.` : "Loading…"}</p>
      ) : (
        <>
          <h1 className="modal-title">{project.name} — settings</h1>
          <p className="project-repo">{project.repoUrl}</p>
          <GlobalWorkerSettings />
          <SettingsForm key={project.id} project={project} />
        </>
      )}
    </Modal>
  );
}

/** The four worker-pipeline toggles (issues #106, #107, #322): what they gate, in the PR loop. */
const WORKER_TOGGLES: Array<{ key: "terminateOnMerge" | "autoFixCi" | "autoFixReviewComments" | "autoReview"; label: string; hint: string }> = [
  {
    key: "terminateOnMerge",
    label: "Delete workers on merge",
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
  {
    key: "autoReview",
    label: "Auto review agents",
    hint: "A review agent is spawned under a worker whose PR is CI-green, unapproved, and conflict-free. Off: the pipeline never spawns reviewers.",
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
 * The token field's placeholder (issue #428): a configured token is only ever
 * announced as "configured" — the stored value itself never reaches the DOM.
 * Exported for tests.
 */
export function reviewTokenPlaceholder(settings: SettingsRead | null): string {
  return settings?.reviewAccountTokenConfigured ? "configured — type to replace" : "personal access token";
}

/**
 * The PUT body for a review-account save (issue #428), honoring the daemon
 * settings store's both-or-neither rule (issue #424 — one half without the
 * other is a 400 the UI surfaces): a typed token replaces/clears the stored
 * one wholesale (both fields travel together); a blank token field keeps
 * whatever is stored — unless the username is also cleared, which must send
 * both halves to take the account offline. Exported for tests.
 */
export function reviewAccountSaveBody(settings: SettingsRead | null, username: string, token: string): UpdateSettingsRequest {
  const nextUsername = username.trim() === "" ? null : username.trim();
  if (token.trim() !== "") {
    return { reviewAccountUsername: nextUsername, reviewAccountToken: token.trim() };
  }
  if (nextUsername === null && (settings?.reviewAccountTokenConfigured ?? false)) {
    return { reviewAccountUsername: null, reviewAccountToken: null };
  }
  return { reviewAccountUsername: nextUsername };
}

/**
 * Review-account section (issues #407, #428): the username + write-only token
 * fields configuring the second GitHub identity the PR loop's reviewer runs
 * as. The token is write-only from the webapp's side — the daemon never
 * returns it (mask-on-read), so the field stays blank and blank means "keep
 * what is stored"; both halves travel together on save (both-or-neither,
 * issue #424) and the daemon's 400s surface verbatim. Saves via its own
 * button; owns its own busy/saved/error state. Exported for tests.
 */
export function ReviewAccountSettings({ settings }: { settings: SettingsRead | null }) {
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await apiUpdateSettings(reviewAccountSaveBody(settings, username, token));
      setUsername(updated.reviewAccountUsername ?? "");
      setToken("");
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="global-worker-settings">
      <h2 className="section-title">Review account (all projects)</h2>
      <div className="settings-form">
        <div className="field">
          <label htmlFor="review-account-username">Review account username</label>
          <input
            id="review-account-username"
            type="text"
            placeholder="second GitHub account's login, e.g. pideck-reviewer"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setSaved(false);
            }}
          />
          <small className="field-hint">
            A second GitHub account the PR loop&apos;s reviewer runs as — it files real PR reviews the primary account can react to. Empty = no review leg.
          </small>
        </div>
        <div className="field">
          <label htmlFor="review-account-token">Review account token</label>
          <input
            id="review-account-token"
            type="password"
            placeholder={reviewTokenPlaceholder(settings)}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setSaved(false);
            }}
          />
          <small className="field-hint">
            {settings?.reviewAccountTokenConfigured
              ? "A token is stored on the daemon and never displayed back. Leave blank to keep it; clearing both fields removes the account."
              : "GitHub personal access token for the review account (repo + PR read/write). Stored on the daemon; never displayed back."}
          </small>
        </div>
      </div>
      <div className="wizard-actions">
        <button type="button" className="button button-primary" disabled={saving || settings === null} onClick={() => void save()}>
          {saving ? "Saving…" : "Save review account"}
        </button>
        {saved && <span className="saved-note">Saved ✓</span>}
      </div>
      {error !== null && <p className="error-note">{error}</p>}
    </section>
  );
}

/**
 * Daemon-wide settings controls (issues #106, #111, #428): global for all
 * projects, persisted by the daemon, read fresh on every pipeline decision —
 * a change here takes effect without a daemon restart. The toggles save
 * immediately; the review-account fields (issue #407/#428, their own
 * {@link ReviewAccountSettings} section) save via their own button.
 * Enabling browser notifications first asks the browser for
 * Notification permission (a denied grant keeps the toggle off). Rendered
 * by both settings modals (issue #264). Exported for tests (the
 * toggle-display ratchet in SettingsModal.test.tsx).
 */
export function GlobalWorkerSettings() {
  const [settings, setSettings] = useState<SettingsRead | null>(null);
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
    <Toggle
      key={toggleDef.key}
      checked={settings !== null && settings[toggleDef.key]}
      disabled={savingKey !== null || settings === null}
      onToggle={(value) => void toggle(toggleDef.key, value)}
      label={
        <>
          {toggleDef.label}
          <small className="field-hint"> {toggleDef.hint}</small>
        </>
      }
    />
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
          <Toggle
            checked={false}
            onToggle={() => {}}
            disabled
            label={
              <>
                {NOTIFICATION_TOGGLE.label}
                <small className="field-hint"> {BROWSER_NOTIFICATIONS_UNSUPPORTED}</small>
              </>
            }
          />
        ) : (
          <div className="settings-form">{renderToggle(NOTIFICATION_TOGGLE)}</div>
        )}
      </section>
      <ReviewAccountSettings settings={settings} />
      {error !== null && <p className="error-note">{error}</p>}
    </>
  );
}
