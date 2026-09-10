/**
 * Per-project settings form (issues #264, #322): the auto-agent username,
 * worker concurrency cap (#168), and the tri-state per-project overrides of
 * the daemon-wide pipeline toggles (#322 — "inherit" sends `null`, meaning
 * the daemon-wide toggle applies; "on"/"off" send explicit overrides).
 * Rendered inside the project settings modal below the global toggles.
 */

import { useState } from "react";
import type { Project } from "@pideck/shared";

import { apiUpdateProject, errorMessage } from "../lib/api";
import { boardStore } from "../store/store";

/** Tri-state per-project override (issue #322): "inherit" → `null` (clear → daemon-wide applies); "on"/"off" → explicit override. */
type ToggleChoice = "inherit" | "on" | "off";

const PROJECT_TOGGLES: Array<{ key: "autoReview" | "autoFixCi" | "autoFixReviewComments" | "terminateOnMerge"; label: string }> = [
  { key: "autoReview", label: "Auto review agents" },
  { key: "autoFixCi", label: "Automatically fix CI failures" },
  { key: "autoFixReviewComments", label: "Automatically fix review comments" },
  { key: "terminateOnMerge", label: "Delete workers on merge" },
];

function toChoice(value: boolean | null | undefined): ToggleChoice {
  return value === true ? "on" : value === false ? "off" : "inherit";
}

function toSetting(choice: ToggleChoice): boolean | null {
  return choice === "on" ? true : choice === "off" ? false : null;
}

/** Tri-state selects for the four per-project pipeline toggles (issue #322). */
function ProjectPipelineToggles(props: {
  choices: Record<(typeof PROJECT_TOGGLES)[number]["key"], ToggleChoice>;
  onChange: (key: (typeof PROJECT_TOGGLES)[number]["key"], choice: ToggleChoice) => void;
}) {
  return (
    <>
      {PROJECT_TOGGLES.map(({ key, label }) => (
        <div className="field" key={key}>
          <label htmlFor={`project-${key}`}>{label}</label>
          <select
            id={`project-${key}`}
            value={props.choices[key]}
            onChange={(e) => props.onChange(key, e.target.value as ToggleChoice)}
          >
            <option value="inherit">Inherit daemon-wide setting</option>
            <option value="on">On for this project</option>
            <option value="off">Off for this project</option>
          </select>
        </div>
      ))}
    </>
  );
}

/** The two free-form per-project fields (auto-agent username, worker cap). */
function ProjectCoreFields(props: {
  username: string;
  onUsername: (value: string) => void;
  concurrency: string;
  onConcurrency: (value: string) => void;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor="auto-agent-username">Auto-agent username</label>
        <input
          id="auto-agent-username"
          type="text"
          placeholder="GitHub username, empty = disabled"
          value={props.username}
          onChange={(e) => props.onUsername(e.target.value)}
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
          value={props.concurrency}
          onChange={(e) => props.onConcurrency(e.target.value)}
        />
        <small className="field-hint">
          Max workers running concurrently for this project (1–16). Empty = unlimited.
        </small>
      </div>
    </>
  );
}

export function SettingsForm({ project }: { project: Project }) {
  const [username, setUsername] = useState(project.settings.autoAgentUsername ?? "");
  const [concurrency, setConcurrency] = useState(project.settings.workerConcurrency?.toString() ?? "");
  const [toggles, setToggles] = useState(() => ({
    autoReview: toChoice(project.settings.autoReview),
    autoFixCi: toChoice(project.settings.autoFixCi),
    autoFixReviewComments: toChoice(project.settings.autoFixReviewComments),
    terminateOnMerge: toChoice(project.settings.terminateOnMerge),
  }));
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
          // Issue #322: "inherit" sends `null` (explicitly cleared → the
          // daemon-wide toggle applies); "on"/"off" send the override.
          ...Object.fromEntries(Object.entries(toggles).map(([key, choice]) => [key, toSetting(choice)])),
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
      <ProjectCoreFields
        username={username}
        onUsername={(value) => {
          setUsername(value);
          setSaved(false);
        }}
        concurrency={concurrency}
        onConcurrency={(value) => {
          setConcurrency(value);
          setSaved(false);
        }}
      />
      <ProjectPipelineToggles
        choices={toggles}
        onChange={(key, choice) => {
          setToggles((prev) => ({ ...prev, [key]: choice }));
          setSaved(false);
        }}
      />
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
