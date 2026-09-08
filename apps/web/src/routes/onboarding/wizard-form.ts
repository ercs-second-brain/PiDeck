/**
 * The project onboarding wizard's cross-step form state and registration
 * call (issue #62): the repository source (clone vs create) captured in
 * step 1 and the auto-agent answer (with its GitHub username + the worker
 * concurrency cap) captured in step 2 both live here so the step components
 * stay presentational and the wizard parent keeps owning the state machine.
 */
import type { Project } from "@pideck/shared";
import { apiGetSettings, apiRegisterProject } from "../../lib/api";

/** The project flow's step keys (issue #183: pi/gh auth moved to the global flow). */
export type ProjectStep = "source" | "autoagent";

export type WizardForm = {
  /** Step 1: register an existing repo, or create a new (private-by-default) one. */
  mode: "clone" | "create";
  repoUrl: string;
  repoName: string;
  isPublic: boolean;
  /** Step 2: should issues auto-create agents? */
  autoAgent: "no" | "yes";
  username: string;
  /**
   * Step 2: worker concurrency cap, as the raw field text (issue #184).
   * Pre-filled with the daemon's default for new projects (3); #168's
   * semantics stand — explicitly clearing the field registers the project
   * unbounded (`null`), it does not fall back to the default.
   */
  concurrency: string;
};

export const INITIAL_FORM: WizardForm = {
  mode: "clone",
  repoUrl: "",
  repoName: "",
  isPublic: false,
  autoAgent: "no",
  username: "",
  concurrency: "3",
};

/**
 * Issue #184: the wizard pre-fills the concurrency field with the daemon's
 * actual default for new projects (`defaultWorkerConcurrency`, 3 out of the
 * box), so wizard and registration API cannot disagree. Falls back to the
 * shipped default when the daemon is unreachable.
 */
export async function defaultConcurrencyField(): Promise<string> {
  try {
    return String((await apiGetSettings()).defaultWorkerConcurrency);
  } catch {
    return INITIAL_FORM.concurrency;
  }
}

/** Expands `owner/repo` shorthands to full GitHub https URLs. */
function normalizeRepoUrl(input: string): string {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}`;
  return value;
}

/** Step 1 validation: the clone flow needs a repo URL, the create flow a name. */
export function sourceFormError(form: WizardForm): string | null {
  if (form.mode === "clone" && normalizeRepoUrl(form.repoUrl).trim().length === 0) {
    return "Enter a repository URL (or owner/repo).";
  }
  if (form.mode === "create" && form.repoName.trim().length === 0) {
    return "Enter a name for the new repository.";
  }
  return null;
}

/** Step 2 validation: watching a username requires the username. */
export function autoAgentFormError(form: WizardForm): string | null {
  if (form.autoAgent === "yes" && form.username.trim().length === 0) {
    return "Enter the GitHub username to watch (or choose No).";
  }
  return null;
}

/**
 * Step 2 validation for the concurrency cap (issues #168, #184): empty
 * means the explicit unbounded choice (`null` is sent); otherwise an
 * integer 1–16.
 */
export function concurrencyFormError(form: WizardForm): string | null {
  const raw = form.concurrency.trim();
  if (raw.length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
    return "Worker concurrency must be an integer between 1 and 16 (empty = unlimited).";
  }
  return null;
}

/** Registers the project via the real `POST /api/projects` endpoint. */
export async function registerProject(form: WizardForm): Promise<Project> {
  const trimmedName = form.repoName.trim();
  const capRaw = form.concurrency.trim();
  const settings = {
    autoAgentUsername: form.autoAgent === "yes" && form.username.trim().length > 0 ? form.username.trim() : null,
    // Issue #168: an explicit `null` clears the cap (unbounded). Issue #184:
    // the field is pre-filled with the daemon default (3); sending the
    // number pins the chosen value — omission never happens from the wizard.
    workerConcurrency: capRaw.length > 0 ? Number(capRaw) : null,
  };
  const body =
    form.mode === "clone"
      ? { mode: "clone" as const, repoUrl: normalizeRepoUrl(form.repoUrl), ...(trimmedName ? { name: trimmedName } : {}), settings }
      : { mode: "create" as const, name: trimmedName, isPrivate: !form.isPublic, settings };
  return apiRegisterProject(body);
}
