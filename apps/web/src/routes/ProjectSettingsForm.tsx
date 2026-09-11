/**
 * Per-project settings form (issues #264, #322): the worker concurrency cap
 * (#168) and the tri-state per-project overrides of the daemon-wide
 * pipeline toggles (#322 — "inherit" sends `null`, meaning the daemon-wide
 * toggle applies; "on"/"off" send explicit overrides). Rendered inside the
 * project settings modal below the global toggles. (Issue #416: the
 * auto-agent username setting is gone — assignment spawning is default.)
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

/** The free-form per-project fields (worker cap, reuse-threshold override). */
function ProjectCoreFields(props: {
  concurrency: string;
  onConcurrency: (value: string) => void;
  reuseThreshold: string;
  onReuseThreshold: (value: string) => void;
}) {
  return (
    <>
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
      <div className="field">
        <label htmlFor="reuse-threshold">Worker reuse context threshold (%)</label>
        <input
          id="reuse-threshold"
          type="number"
          min={1}
          max={100}
          placeholder="empty = inherit daemon-wide setting"
          value={props.reuseThreshold}
          onChange={(e) => props.onReuseThreshold(e.target.value)}
        />
        <small className="field-hint">
          A done same-lane worker above this context-usage percent (1–100) is not reused for follow-on tasks — a fresh
          worker spawns instead. Empty = inherit the daemon-wide threshold.
        </small>
      </div>
    </>
  );
}

export function SettingsForm({ project }: { project: Project }) {
  const [concurrency, setConcurrency] = useState(project.settings.workerConcurrency?.toString() ?? "");
  const [reuseThreshold, setReuseThreshold] = useState(project.settings.workerReuseContextThreshold?.toString() ?? "");
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
    // Issue #471: an empty threshold sends `null` (explicit clear → the
    // daemon-wide threshold applies); a value must be an integer 1..100.
    let threshold: number | null = null;
    if (reuseThreshold.trim().length > 0) {
      threshold = Number(reuseThreshold);
      if (!Number.isInteger(threshold) || threshold < 1 || 100 < threshold) {
        setError("Worker reuse context threshold must be an integer between 1 and 100 (empty = inherit).");
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await apiUpdateProject(project.id, {
        settings: {
          // Issue #168: an empty field sends `null` explicitly — the daemon
          // treats it as unset (unbounded); omitting the field would keep
          // the previous cap instead of clearing it.
          workerConcurrency: cap ?? null,
          workerReuseContextThreshold: threshold,
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
        concurrency={concurrency}
        onConcurrency={(value) => {
          setConcurrency(value);
          setSaved(false);
        }}
        reuseThreshold={reuseThreshold}
        onReuseThreshold={(value) => {
          setReuseThreshold(value);
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
