/**
 * The first-run onboarding wizard (docs/DESIGN.md §5 Onboarding): a four-step
 * chip stepper — pi · GitHub · Review account · Repo. The first two steps are
 * read-only probes with re-check; the third captures the reviewer's second
 * GitHub account (the token is saved by the daemon and never rendered again);
 * the fourth registers the project by cloning a URL or creating a new repo.
 * Re-entering later with every prerequisite already satisfied jumps straight
 * to the repo step to add another project.
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type {
  GlobalSettingsPut,
  PiProbe,
  Probe,
  Project,
  ProjectCreate,
  ReviewAccountPut,
} from "@pideck/shared";
import { api } from "../lib/api";
import { Badge, Button, Field, Page, Row, Section, Switch } from "../ui";

type StepId = "pi" | "github" | "review" | "repo";

const STEPS: readonly { id: StepId; label: string }[] = [
  { id: "pi", label: "pi" },
  { id: "github", label: "GitHub" },
  { id: "review", label: "Review account" },
  { id: "repo", label: "Repo" },
];

const dim: CSSProperties = { color: "var(--text-dim)" };
const red: CSSProperties = { color: "var(--red)", fontSize: 13 };
const row: CSSProperties = { display: "flex", gap: 8, marginTop: 12 };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Module-level so the probe steps' mount effect sees stable callbacks. */
function runPiProbe(): Promise<PiProbe> {
  return api("probePi");
}
function runGhPrimaryProbe(): Promise<Probe> {
  return api("probeGhPrimary");
}

function ProbeStep<T extends Probe>({
  title,
  description,
  run,
  render,
  onNext,
}: {
  title: string;
  description: string;
  run: () => Promise<T>;
  render?: (probe: T) => ReactNode;
  onNext: () => void;
}) {
  const [probe, setProbe] = useState<T | null>(null);
  const [probing, setProbing] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setProbing(true);
    setError(null);
    try {
      setProbe(await run());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setProbing(false);
    }
  }, [run]);

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <Section title={title} description={description}>
      {probing ? <p style={dim}>Checking…</p> : null}
      {probe && probe.ok && render ? render(probe) : null}
      {probe && !probe.ok ? <p style={red}>{probe.detail}</p> : null}
      {error ? <p style={red}>{error}</p> : null}
      <div style={row}>
        <Button variant="ghost" disabled={probing} onClick={() => void check()}>
          Re-check
        </Button>
        <Button variant="primary" disabled={probing || !probe?.ok} onClick={onNext}>
          Next
        </Button>
      </div>
    </Section>
  );
}

function ReviewStep({ onVerified }: { onVerified: () => void }) {
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [tokenSet, setTokenSet] = useState(false);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; token?: string }>({});
  const [error, setError] = useState<string | null>(null);

  async function verify(): Promise<void> {
    const usernameError = username.trim() ? undefined : "Username is required";
    const tokenError = token.trim() || tokenSet ? undefined : "A personal access token is required";
    setFieldErrors({ username: usernameError, token: tokenError });
    if (usernameError || tokenError) return;
    setBusy(true);
    setError(null);
    try {
      const account: ReviewAccountPut = token.trim()
        ? { username: username.trim(), token: token.trim() }
        : { username: username.trim() };
      const put: GlobalSettingsPut = { reviewAccount: account };
      await api("globalSettingsPut", undefined, put);
      setTokenSet(true);
      setToken("");
      const probe = await api("probeGhReview");
      if (probe.ok) {
        setVerified(true);
      } else {
        setError(probe.detail);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Review account"
      description="Reviewers file real GitHub reviews from a second account. Its token is stored by the daemon and never shown again."
    >
      <Field label="Username" value={username} onChange={setUsername} error={fieldErrors.username} disabled={busy} />
      <Field
        label="Personal access token"
        type="password"
        value={token}
        onChange={setToken}
        placeholder={tokenSet ? "Saved — leave blank to keep it" : "Token with repo scope"}
        error={fieldErrors.token}
        disabled={busy}
      />
      {verified ? <Badge tone="green">✓ Verified as {username.trim()}</Badge> : null}
      {error ? <p style={red}>{error}</p> : null}
      <div style={row}>
        <Button variant="primary" disabled={busy} onClick={() => void verify()}>
          {verified ? "Re-verify" : "Verify"}
        </Button>
        <Button variant="primary" disabled={!verified} onClick={onVerified}>
          Next
        </Button>
      </div>
    </Section>
  );
}

function RepoStep({ onCreated }: { onCreated: (project: Project) => void }) {
  const [mode, setMode] = useState<"clone" | "create">("clone");
  const [repoUrl, setRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ repoUrl?: string; name?: string }>({});
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const repoUrlError = mode === "clone" && !repoUrl.trim() ? "Repository URL is required" : undefined;
    const nameError = mode === "create" && !name.trim() ? "Repository name is required" : undefined;
    setFieldErrors({ repoUrl: repoUrlError, name: nameError });
    if (repoUrlError || nameError) return;
    setBusy(true);
    setError(null);
    try {
      const body: ProjectCreate =
        mode === "clone"
          ? { mode: "clone", repoUrl: repoUrl.trim() }
          : { mode: "create", name: name.trim(), private: isPrivate };
      onCreated(await api("projectCreate", undefined, body));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Project repository"
      description="Connect the repository this PiDeck orchestrates: clone an existing one, or create a new one on GitHub."
    >
      <div style={row}>
        <Button variant={mode === "clone" ? "primary" : "default"} disabled={busy} onClick={() => setMode("clone")}>
          Clone existing
        </Button>
        <Button variant={mode === "create" ? "primary" : "default"} disabled={busy} onClick={() => setMode("create")}>
          Create new
        </Button>
      </div>
      {mode === "clone" ? (
        <Field
          label="Repository URL"
          value={repoUrl}
          onChange={setRepoUrl}
          placeholder="https://github.com/owner/repo"
          error={fieldErrors.repoUrl}
          disabled={busy}
        />
      ) : (
        <>
          <Field label="Repository name" value={name} onChange={setName} error={fieldErrors.name} />
          <Row label="Private repository">
            <Switch label="Private repository" checked={isPrivate} onChange={setPrivate} />
          </Row>
        </>
      )}
      {error ? <p style={red}>{error}</p> : null}
      <div style={row}>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          Add project
        </Button>
      </div>
    </Section>
  );
}

export function OnboardingWizard({ onDone }: { onDone: (project: Project) => void }) {
  const [step, setStep] = useState<StepId>("pi");
  const [completed, setCompleted] = useState<ReadonlySet<StepId>>(() => new Set());
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [status, settings] = await Promise.all([api("status"), api("globalSettingsGet")]);
        if (status.piReady && status.ghReady && settings.reviewAccount?.tokenSet) {
          setCompleted(new Set<StepId>(["pi", "github", "review"]));
          setStep("repo");
        }
      } catch {
        /* the steps themselves surface probe errors; run them normally */
      } finally {
        if (!cancelled) setEntered(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function advance(from: StepId): void {
    setCompleted((previous) => new Set(previous).add(from));
    const next = STEPS[STEPS.findIndex((entry) => entry.id === from) + 1];
    if (next) setStep(next.id);
  }

  return (
    <Page title="Set up PiDeck">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
        {STEPS.map((entry) => (
          <span key={entry.id} aria-current={entry.id === step ? "step" : undefined}>
            <Badge tone={completed.has(entry.id) ? "green" : entry.id === step ? "blue" : "dim"}>
              {completed.has(entry.id) ? `✓ ${entry.label}` : entry.label}
            </Badge>
          </span>
        ))}
      </div>
      {entered && step === "pi" && (
        <ProbeStep
          title="pi coding agent"
          description="PiDeck drives pi in tmux panes. Verify the pi CLI is installed and authenticated; this shows its providers and default model."
          run={runPiProbe}
          render={(probe) => (
            <>
              <p style={dim}>
                {probe.providers.length > 0 ? `Providers: ${probe.providers.join(", ")}` : "No providers detected"}
              </p>
              <p style={dim}>{probe.defaultModel ? `Default model: ${probe.defaultModel}` : "No default model set"}</p>
            </>
          )}
          onNext={() => advance("pi")}
        />
      )}
      {entered && step === "github" && (
        <ProbeStep
          title="GitHub CLI"
          description="Workers and reviewers act through the primary gh auth on this machine."
          run={runGhPrimaryProbe}
          onNext={() => advance("github")}
        />
      )}
      {entered && step === "review" && <ReviewStep onVerified={() => advance("review")} />}
      {entered && step === "repo" && <RepoStep onCreated={onDone} />}
    </Page>
  );
}
