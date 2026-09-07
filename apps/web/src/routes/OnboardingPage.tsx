import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { Project } from "@agentskiss/shared";
import { apiGetGhAuth, apiGetPiAuth, apiRegisterProject, errorMessage, type GhAuth, type PiAuth } from "../lib/api";
import { PiAuthReport } from "../components/PiAuthBanner";

/**
 * First-run onboarding wizard — shown when no projects are registered.
 *
 * Flow (PRD: repo connection):
 * 1. pi auth check (daemon-side probe via `GET /api/pi-auth`, issue #57):
 *    workers cannot run unauthenticated, so this step must pass (re-verify
 *    after the handoff: `agentskiss onboard`, or pi /login) before the
 *    wizard proceeds.
 * 2. gh permission check (daemon-side probe via `GET /api/gh-auth`).
 * 3. Choose the repo source: clone from git OR create a new GitHub repo —
 *    created repos are **private by default** with an explicit public toggle.
 * 4. Auto-create-agents question: should issues auto-create agents? Captures
 *    the GitHub username stored as the project's `autoAgentUsername`.
 *
 * Registration goes through the real `POST /api/projects` endpoint.
 */

type Step = "pi" | "permission" | "source" | "autoagent";

const STEP_LABELS: Array<{ key: Step; label: string }> = [
  { key: "pi", label: "1 · pi agent" },
  { key: "permission", label: "2 · gh access" },
  { key: "source", label: "3 · repository" },
  { key: "autoagent", label: "4 · auto-agents" },
];

/** Expands `owner/repo` shorthands to full GitHub https URLs. */
export function normalizeRepoUrl(input: string): string {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}`;
  return value;
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("pi");
  const [pi, setPi] = useState<PiAuth | null>(null);
  const [piError, setPiError] = useState<string | null>(null);
  const [checkingPi, setCheckingPi] = useState(true);
  const [auth, setAuth] = useState<GhAuth | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  // Source form
  const [mode, setMode] = useState<"clone" | "create">("clone");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoName, setRepoName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Auto-agent form
  const [autoAgent, setAutoAgent] = useState<"no" | "yes">("no");
  const [username, setUsername] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const checkPi = useCallback(() => {
    setCheckingPi(true);
    setPiError(null);
    apiGetPiAuth()
      .then(setPi)
      .catch((err: unknown) => setPiError(errorMessage(err)))
      .finally(() => setCheckingPi(false));
  }, []);

  const checkPermissions = useCallback(() => {
    setChecking(true);
    setAuthError(null);
    apiGetGhAuth()
      .then((result) => {
        setAuth(result);
        setUsername((current) => current || result.login || "");
      })
      .catch((err: unknown) => setAuthError(errorMessage(err)))
      .finally(() => setChecking(false));
  }, []);

  useEffect(checkPi, [checkPi]);
  useEffect(checkPermissions, [checkPermissions]);

  const submit = async (): Promise<void> => {
    const trimmedName = repoName.trim();
    const settings = {
      autoAgentUsername: autoAgent === "yes" && username.trim().length > 0 ? username.trim() : null,
    };
    const body =
      mode === "clone"
        ? { mode: "clone" as const, repoUrl: normalizeRepoUrl(repoUrl), ...(trimmedName ? { name: trimmedName } : {}), settings }
        : { mode: "create" as const, name: trimmedName, isPrivate: !isPublic, settings };
    let project: Project;
    try {
      project = await apiRegisterProject(body);
    } catch (err) {
      setFormError(errorMessage(err));
      setSubmitting(false);
      return;
    }
    navigate(`/projects/${project.id}`);
  };

  const nextFromSource = (): void => {
    if (mode === "clone" && normalizeRepoUrl(repoUrl).trim().length === 0) {
      setFormError("Enter a repository URL (or owner/repo).");
      return;
    }
    if (mode === "create" && repoName.trim().length === 0) {
      setFormError("Enter a name for the new repository.");
      return;
    }
    setFormError(null);
    setStep("autoagent");
  };

  const stepIndex = STEP_LABELS.findIndex((s) => s.key === step);

  return (
    <main className="page">
      <h1 className="page-title">Welcome to agentsKISS</h1>
      <p className="empty">Connect your first project to start orchestrating agents.</p>

      <ol className="wizard-steps">
        {STEP_LABELS.map((entry, index) => (
          <li
            key={entry.key}
            className={`wizard-step ${entry.key === step ? "current" : ""} ${index < stepIndex ? "done" : ""}`}
          >
            {entry.label}
          </li>
        ))}
      </ol>

      {step === "pi" && (
        <section className="wizard-panel">
          <h2 className="panel-title">pi agent auth</h2>
          <p className="empty">
            Workers are pi coding agents spawned in tmux panes — they need working pi credentials before any prompt
            can be delivered.
          </p>
          {checkingPi && pi === null && <p className="empty">Checking pi auth on the daemon…</p>}
          {!checkingPi && piError !== null && (
            <>
              <p className="error-note">Could not reach the daemon: {piError}</p>
              <button type="button" className="button" onClick={checkPi}>
                Retry
              </button>
            </>
          )}
          {!checkingPi && piError === null && pi !== null && (
            <PiAuthReport auth={pi} onRecheck={checkPi} />
          )}
          {!checkingPi && piError === null && pi !== null && (
            <div className="wizard-actions">
              {/* Issue #57: re-verify before proceeding — the gate cannot be
                  clicked through while no provider is ready. */}
              <button
                type="button"
                className="button button-primary"
                disabled={!pi.ready}
                title={pi.ready ? undefined : "pi auth is not ready — complete the handoff above, then re-check"}
                onClick={() => setStep("permission")}
              >
                Continue
              </button>
            </div>
          )}
        </section>
      )}

      {step === "permission" && (
        <section className="wizard-panel">
          <h2 className="panel-title">gh permission check</h2>
          {checking && <p className="empty">Checking gh authentication on the daemon…</p>}
          {!checking && authError !== null && (
            <>
              <p className="error-note">Could not reach the daemon: {authError}</p>
              <button type="button" className="button" onClick={checkPermissions}>
                Retry
              </button>
            </>
          )}
          {!checking && authError === null && auth !== null && (
            <>
              <PermissionReport auth={auth} />
              <div className="wizard-actions">
                <button type="button" className="button button-primary" onClick={() => setStep("source")}>
                  Continue
                </button>
                <button type="button" className="button" onClick={checkPermissions}>
                  Re-check
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {step === "source" && (
        <section className="wizard-panel">
          <h2 className="panel-title">Connect a repository</h2>
          <div className="choice-row">
            <label className={`choice-card ${mode === "clone" ? "selected" : ""}`}>
              <input
                type="radio"
                name="mode"
                checked={mode === "clone"}
                onChange={() => {
                  setMode("clone");
                  setFormError(null);
                }}
              />
              <span>
                <strong>Clone from git</strong>
                <small>Register an existing GitHub repository.</small>
              </span>
            </label>
            <label className={`choice-card ${mode === "create" ? "selected" : ""}`}>
              <input
                type="radio"
                name="mode"
                checked={mode === "create"}
                onChange={() => {
                  setMode("create");
                  setFormError(null);
                }}
              />
              <span>
                <strong>Create a new repo</strong>
                <small>Created via gh on the daemon host.</small>
              </span>
            </label>
          </div>

          {mode === "clone" ? (
            <div className="field">
              <label htmlFor="repo-url">Repository URL</label>
              <input
                id="repo-url"
                type="text"
                placeholder="https://github.com/owner/repo (or owner/repo)"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
              />
              <div className="field">
                <label htmlFor="repo-name">Project name (optional)</label>
                <input id="repo-name" type="text" placeholder="defaults to owner-repo" value={repoName} onChange={(e) => setRepoName(e.target.value)} />
              </div>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="new-repo-name">New repository name</label>
                <input id="new-repo-name" type="text" placeholder="my-project" value={repoName} onChange={(e) => setRepoName(e.target.value)} />
              </div>
              <label className="toggle-row">
                <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
                <span>
                  Public repository <small>(recommended default is private)</small>
                </span>
              </label>
            </>
          )}

          {formError !== null && <p className="error-note">{formError}</p>}
          <div className="wizard-actions">
            <button type="button" className="button button-primary" onClick={nextFromSource}>
              Continue
            </button>
            <button type="button" className="button" onClick={() => setStep("permission")}>
              Back
            </button>
          </div>
        </section>
      )}

      {step === "autoagent" && (
        <section className="wizard-panel">
          <h2 className="panel-title">Auto-create agents?</h2>
          <p className="empty">Should newly created or assigned issues automatically spawn a worker agent?</p>
          <div className="choice-row">
            <label className={`choice-card ${autoAgent === "no" ? "selected" : ""}`}>
              <input
                type="radio"
                name="autoagent"
                checked={autoAgent === "no"}
                onChange={() => setAutoAgent("no")}
              />
              <span>
                <strong>No</strong>
                <small>Workers are spawned manually.</small>
              </span>
            </label>
            <label className={`choice-card ${autoAgent === "yes" ? "selected" : ""}`}>
              <input
                type="radio"
                name="autoagent"
                checked={autoAgent === "yes"}
                onChange={() => setAutoAgent("yes")}
              />
              <span>
                <strong>Yes</strong>
                <small>Watch a GitHub username's issues.</small>
              </span>
            </label>
          </div>
          {autoAgent === "yes" && (
            <div className="field">
              <label htmlFor="auto-agent-username">GitHub username to watch</label>
              <input
                id="auto-agent-username"
                type="text"
                placeholder="e.g. your-login"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <small className="field-hint">
                Issues created by or assigned to this user spawn a worker automatically.
              </small>
            </div>
          )}
          {formError !== null && <p className="error-note">{formError}</p>}
          <div className="wizard-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={submitting}
              onClick={() => {
                if (autoAgent === "yes" && username.trim().length === 0) {
                  setFormError("Enter the GitHub username to watch (or choose No).");
                  return;
                }
                setFormError(null);
                setSubmitting(true);
                void submit();
              }}
            >
              {submitting ? "Registering…" : "Finish — register project"}
            </button>
            <button type="button" className="button" onClick={() => setStep("source")}>
              Back
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

/** Verdict display for the gh permission probe. */
function PermissionReport({ auth }: { auth: GhAuth }) {
  return (
    <div className="perm-report">
      {auth.authenticated ? (
        <p>
          <span className="badge badge-open">gh authenticated</span>{" "}
          {auth.login && (
            <span>
              as <code>{auth.login}</code>{" "}
            </span>
          )}
          <span className="perm-detail">
            (token: <code>{auth.tokenSource}</code>)
          </span>
        </p>
      ) : (
        <p className="error-note">
          gh is not authenticated on the daemon host. Run <code>gh auth login</code> there, then re-check. You can
          still continue — cloning needs no extra scopes.
        </p>
      )}
      <p className={`perm-verdict perm-${auth.canCreateRepos}`}>
        Create repositories: <strong>{auth.canCreateRepos}</strong>
        {auth.canCreateRepos === "unknown" && " (token scopes not reported — creation will be attempted and verified)"}
      </p>
      <p className="perm-detail">{auth.detail}</p>
    </div>
  );
}
