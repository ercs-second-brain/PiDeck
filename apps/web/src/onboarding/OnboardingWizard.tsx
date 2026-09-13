/**
 * The first-run onboarding wizard (docs/DESIGN.md §5 Onboarding): a four-step
 * chip stepper — pi · GitHub · Review account · Repo. The first two steps are
 * read-only probes with re-check; the third signs the reviewer's second GitHub
 * account in via gh's device flow (the token is stored by the daemon and never
 * rendered again), with a PAT form as a collapsed fallback; the fourth
 * registers the project by cloning a URL or creating a new repo.
 * Re-entering later with every prerequisite already satisfied jumps straight
 * to the repo step to add another project.
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  errorMessage,
  type GlobalSettingsPut,
  type PiProbe,
  type Probe,
  type Project,
  type ProjectCreate,
  type ReviewAccountPut,
  type ReviewLoginStart,
  type ReviewLoginStatus,
} from "@pideck/shared";
import { api } from "../lib/api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Page } from "../ui/Page";
import { Row } from "../ui/Row";
import { Section } from "../ui/Section";
import { Switch } from "../ui/Switch";

type StepId = "pi" | "github" | "review" | "repo";

const STEPS: readonly { id: StepId; label: string }[] = [
  { id: "pi", label: "pi" },
  { id: "github", label: "GitHub" },
  { id: "review", label: "Review account" },
  { id: "repo", label: "Repo" },
];

const dim: CSSProperties = { color: "var(--text-dim)" };
const red: CSSProperties = { color: "var(--red)", fontSize: 13 };
const row: CSSProperties = { display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" };
const codeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 22,
  letterSpacing: 2,
  padding: "4px 10px",
  background: "var(--bg-hover)",
  border: "1px solid var(--border)",
  borderRadius: 6,
};
const link: CSSProperties = { color: "var(--blue)" };

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

type DeviceFlowState = "starting" | "pending" | "done" | "failed";

/**
 * The review-account step. The primary path is gh's device-code login: the
 * daemon launches `gh auth login --web` under its own gh config dir and this
 * panel shows the one-time code + URL with a live status. A PAT form stays as
 * a collapsed fallback; either path stores the account and enables Next.
 */
function ReviewStep({
  initialTokenSet,
  onVerified,
}: {
  initialTokenSet: boolean;
  onVerified: () => void;
}) {
  const [login, setLogin] = useState<ReviewLoginStart | null>(null);
  const [flow, setFlow] = useState<DeviceFlowState>("starting");
  const [flowDetail, setFlowDetail] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verifiedAs, setVerifiedAs] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  // The stored token is write-only: the daemon reports only that one exists.
  // It starts as whatever onboarding already stored and is set once saved.
  const [tokenSet, setTokenSet] = useState(initialTokenSet);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; token?: string }>({});
  const [error, setError] = useState<string | null>(null);

  const startFlow = useCallback(async (): Promise<void> => {
    setFlow("starting");
    setFlowDetail(null);
    try {
      setLogin(await api("reviewLoginStart"));
      setFlow("pending");
    } catch (caught) {
      setFlow("failed");
      setFlowDetail(errorMessage(caught));
    }
  }, []);

  const markDone = useCallback(async (): Promise<void> => {
    try {
      const probe = await api("probeGhReview");
      if (probe.ok) {
        setVerified(true);
        setVerifiedAs(probe.detail);
        setFlow("done");
      } else {
        setFlow("failed");
        setFlowDetail(probe.detail);
      }
    } catch (caught) {
      setFlow("failed");
      setFlowDetail(errorMessage(caught));
    }
  }, []);

  // The device flow is the primary path: start it as soon as the step mounts
  // (idempotent on the daemon while a flow is already running).
  useEffect(() => {
    void startFlow();
  }, [startFlow]);

  useEffect(() => {
    if (flow !== "pending") return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const status: ReviewLoginStatus = await api("reviewLoginStatus");
        if (cancelled) return;
        setFlowDetail(status.detail);
        if (status.status === "done") {
          setFlow("done");
          await markDone();
        } else if (status.status === "failed") {
          setFlow("failed");
        }
      } catch {
        /* transient; keep polling */
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [flow, markDone]);

  function copyCode(): void {
    if (!login) return;
    void navigator.clipboard
      ?.writeText(login.code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        /* clipboard unavailable; the code is selectable as-is */
      });
  }

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
        setVerifiedAs(`verified as ${username.trim()}`);
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
      description="Reviewers file real GitHub reviews from a second account. Sign in with GitHub's device flow — PiDeck stores only the resulting token, never your password."
    >
      <div style={row}>
        <span>One-time code</span>
        {login ? <span style={codeStyle}>{login.code}</span> : null}
        <Button variant="ghost" disabled={!login} onClick={copyCode}>
          {copied ? "Copied" : "Copy code"}
        </Button>
      </div>
      {login ? (
        <p style={dim}>
          Open <a href={login.url} style={link}>{login.url}</a>, enter the code, and finish signed in as the reviewer
          account.
        </p>
      ) : null}
      {flow === "pending" ? <p style={dim}>Waiting for you to finish the sign-in…</p> : null}
      {flow === "failed" ? (
        <>
          <p style={red}>{flowDetail ?? "Device sign-in failed"}</p>
          <div style={row}>
            <Button onClick={() => void startFlow()}>Sign in as the reviewer</Button>
          </div>
        </>
      ) : null}
      {verified ? <Badge tone="green">✓ {verifiedAs ?? "review account signed in"}</Badge> : null}
      <details style={{ marginTop: 12 }}>
        <summary style={{ ...dim, cursor: "pointer" }}>Use a personal access token instead</summary>
        <p style={{ ...dim, marginTop: 8 }}>
          Create a PAT for the reviewer account (github.com/settings/tokens); its token is stored by the daemon and
          never shown again.
        </p>
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
        {error ? <p style={red}>{error}</p> : null}
        <div style={row}>
          <Button variant="primary" disabled={busy} onClick={() => void verify()}>
            Verify
          </Button>
        </div>
      </details>
      <div style={row}>
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
  // The review account is required: the step cannot be skipped, and its PAT
  // fallback must see a token stored by a previous onboarding run.
  const [reviewTokenSet, setReviewTokenSet] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [status, settings] = await Promise.all([api("status"), api("globalSettingsGet")]);
        if (cancelled) return;
        setReviewTokenSet(settings.reviewAccount?.tokenSet ?? false);
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
      {entered && step === "review" && (
        <ReviewStep initialTokenSet={reviewTokenSet} onVerified={() => advance("review")} />
      )}
      {entered && step === "repo" && <RepoStep onCreated={onDone} />}
    </Page>
  );
}
