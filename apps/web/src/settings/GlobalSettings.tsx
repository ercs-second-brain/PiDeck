/**
 * The global settings page with the General · Review account · Models ·
 * Prompts sub-nav. General shows read-only daemon facts plus an update
 * check; Review account replaces or clears the reviewer's GitHub identity
 * (the token is write-only and never displayed); Models assigns a pi model
 * per persona from the onboarding probe's model list; Prompts hosts the
 * prompt editor. All daemon access goes through ./client.
 */

import { useEffect, useState } from "react";
import {
  Personas,
  PERSONA_LABELS,
  type GlobalSettingsPut,
  type GlobalSettingsRead,
  errorMessage,
  type Persona,
  type PiProbe,
  type Status,
  type UpdateCheck,
} from "@pideck/shared";
import { Page } from "../ui/Page";
import { Section } from "../ui/Section";
import { Row } from "../ui/Row";
import { Field } from "../ui/Field";
import { Button } from "../ui/Button";
import { PromptEditor } from "./PromptEditor";
import { PERSONA_MODEL_DESCRIPTIONS } from "./personas";
import {
  checkForUpdateNow,
  loadGlobalSettings,
  loadPiProbe,
  loadStatus,
  saveGlobalSettings,
} from "./client";
import { actionLabel, useAction } from "./use-action";
import { updateActionLabel, updateButtonLabel, useUpdateApply } from "../update/use-update-apply";

const TABS = [
  { id: "general", label: "General" },
  { id: "account", label: "Review account" },
  { id: "models", label: "Models" },
  { id: "prompts", label: "Prompts" },
] as const;

type SettingsTab = (typeof TABS)[number]["id"];

export function GlobalSettings() {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<GlobalSettingsRead | null>(null);
  const [probe, setProbe] = useState<PiProbe | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([loadStatus(), loadGlobalSettings(), loadPiProbe()])
      .then(([status, settings, probe]) => {
        if (!alive) return;
        setStatus(status);
        setSettings(settings);
        setProbe(probe);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Page title="Settings" subnav={<SettingsNav tab={tab} onSelect={setTab} />}>
      {loadError && <p style={{ color: "var(--red)" }}>Settings could not be loaded: {loadError}</p>}
      {!loadError && tab === "general" && <GeneralSection status={status} />}
      {!loadError && tab === "account" && settings && (
        <ReviewAccountSection settings={settings} onSaved={setSettings} />
      )}
      {!loadError && tab === "models" && settings && (
        <ModelsSection settings={settings} probe={probe} onSaved={setSettings} />
      )}
      {!loadError && tab === "prompts" && <PromptEditor />}
    </Page>
  );
}

function SettingsNav({
  tab,
  onSelect,
}: {
  tab: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
}) {
  return (
    <nav aria-label="Settings sections" style={{ display: "flex", gap: "16px" }}>
      {TABS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-current={tab === entry.id ? "page" : undefined}
          onClick={() => onSelect(entry.id)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            font: "inherit",
            color: tab === entry.id ? "var(--accent)" : "var(--text-dim)",
          }}
        >
          {entry.label}
        </button>
      ))}
    </nav>
  );
}

function GeneralSection({ status }: { status: Status | null }) {
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const action = useAction();
  const apply = useUpdateApply(update?.state ?? null);
  const stateLine =
    update === null
      ? null
      : update.state === "updateAvailable"
        ? `Update available (${update.latestVersion ?? "unknown"})`
        : update.state === "restartNeeded"
          ? "Restart needed — the checkout is current but the daemon runs older code"
          : "Up to date";

  return (
    <Section
      title="General"
      description="Read-only daemon facts; the update check answers for the running daemon, not the checkout."
      footer={
        <>
          {action.error && <p style={{ color: "var(--red)", margin: 0 }}>{action.error}</p>}
          {stateLine !== null && <span style={{ color: "var(--text-dim)" }}>{stateLine}</span>}
          {apply.hint !== null && <span style={{ color: "var(--text-dim)" }}>{apply.hint}</span>}
          {apply.actionable && (
            <Button
              variant="primary"
              disabled={apply.phase === "updating" || apply.agentsLive}
              onClick={() => (apply.phase === "stuck" ? apply.reload() : void apply.apply())}
            >
              {updateButtonLabel(
                apply.phase,
                update === null ? "Update" : `${updateActionLabel(update.state)} now`,
              )}
            </Button>
          )}
          <Button
            disabled={action.state === "busy"}
            onClick={() => void action.run(async () => setUpdate(await checkForUpdateNow()))}
          >
            {actionLabel(action.state, "Check for updates", "Checking…", "Checked")}
          </Button>
        </>
      }
    >
      <Row label="Poll interval" description="How often the daemon reconciles with GitHub.">
        <span style={{ color: "var(--text-dim)" }}>
          {status ? `${status.pollIntervalSeconds}s` : "…"}
        </span>
      </Row>
      <Row label="State directory" description="Where PiDeck keeps its state.">
        <span style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>
          {status?.stateDir ?? "…"}
        </span>
      </Row>
      <Row label="Version">
        <span style={{ color: "var(--text-dim)" }}>{status?.version ?? "…"}</span>
      </Row>
    </Section>
  );
}

function ReviewAccountSection({
  settings,
  onSaved,
}: {
  settings: GlobalSettingsRead;
  onSaved: (settings: GlobalSettingsRead) => void;
}) {
  const [username, setUsername] = useState(settings.reviewAccount?.username ?? "");
  const [token, setToken] = useState("");
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const action = useAction();
  const tokenSet = settings.reviewAccount?.tokenSet ?? false;

  const onSave = () => {
    setUsernameError(null);
    setTokenError(null);
    const name = username.trim();
    const trimmed = token.trim();
    if (!name) {
      setUsernameError("Username is required.");
      return;
    }
    if (!trimmed && !tokenSet) {
      setTokenError("A personal access token is required.");
      return;
    }
    const put: GlobalSettingsPut = {
      reviewAccount: trimmed ? { username: name, token: trimmed } : { username: name },
    };
    void action.run(async () => {
      const saved = await saveGlobalSettings(put);
      onSaved(saved);
      setToken("");
    });
  };

  const onClear = () => {
    setUsernameError(null);
    setTokenError(null);
    void action.run(async () => {
      const saved = await saveGlobalSettings({ reviewAccount: null });
      onSaved(saved);
      setUsername("");
      setToken("");
    });
  };

  return (
    <Section
      title="Review account"
      description="The second GitHub account reviewers review from. Required for the loop."
      footer={
        <>
          {action.error && (
            <p style={{ color: "var(--red)", margin: 0 }}>{action.error}</p>
          )}
          {tokenSet && (
            <Button variant="ghost" disabled={action.state === "busy"} onClick={onClear}>
              {actionLabel(action.state, "Clear account", "Clearing…", "Cleared")}
            </Button>
          )}
          <Button variant="primary" disabled={action.state === "busy"} onClick={onSave}>
            {actionLabel(action.state, "Save", "Saving…")}
          </Button>
        </>
      }
    >
      <Row label="Username" description="The reviewer's GitHub login.">
        <Field
          type="text"
          value={username}
          onChange={setUsername}
          error={usernameError ?? undefined}
          label="Reviewer username"
        />
      </Row>
      <Row
        label="Token"
        description={
          tokenSet
            ? "A token is set. Leave blank to keep it; paste a new one to replace it."
            : "A fine-grained personal access token that can open reviews."
        }
      >
        <Field
          type="password"
          value={token}
          onChange={setToken}
          placeholder={tokenSet ? "••••••••" : ""}
          error={tokenError ?? undefined}
          label="Reviewer access token"
        />
      </Row>
    </Section>
  );
}

function ModelsSection({
  settings,
  probe,
  onSaved,
}: {
  settings: GlobalSettingsRead;
  probe: PiProbe | null;
  onSaved: (settings: GlobalSettingsRead) => void;
}) {
  const [models, setModels] = useState<Record<Persona, string>>(() => modelsOf(settings));
  const action = useAction();

  const onSave = () => {
    const put: GlobalSettingsPut = {
      modelByPersona: {
        global: models.global || null,
        orchestrator: models.orchestrator || null,
        worker: models.worker || null,
        reviewer: models.reviewer || null,
      },
    };
    void action.run(async () => {
      const saved = await saveGlobalSettings(put);
      onSaved(saved);
      setModels(modelsOf(saved));
    });
  };

  return (
    <Section
      title="Models"
      description='One pi model per persona. "pi default" uses the model chosen during onboarding.'
      footer={
        <>
          {action.error && <p style={{ color: "var(--red)", margin: 0 }}>{action.error}</p>}
          <Button variant="primary" disabled={action.state === "busy"} onClick={onSave}>
            {actionLabel(action.state, "Save", "Saving…")}
          </Button>
        </>
      }
    >
      {Personas.map((persona) => (
        <Row
          key={persona}
          label={PERSONA_LABELS[persona]}
          description={PERSONA_MODEL_DESCRIPTIONS[persona]}
        >
          <Field
            type="select"
            value={models[persona]}
            disabled={!probe}
            onChange={(value) => setModels((prev) => ({ ...prev, [persona]: value }))}
            options={[
              { value: "", label: "pi default" },
              ...(probe?.models ?? []).map((model) => ({ value: model, label: model })),
            ]}
          />
        </Row>
      ))}
    </Section>
  );
}

function modelsOf(settings: GlobalSettingsRead): Record<Persona, string> {
  return {
    global: settings.modelByPersona.global ?? "",
    orchestrator: settings.modelByPersona.orchestrator ?? "",
    worker: settings.modelByPersona.worker ?? "",
    reviewer: settings.modelByPersona.reviewer ?? "",
  };
}