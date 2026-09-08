/**
 * The project onboarding wizard's cross-step form state and registration
 * call (issue #62): the repository source (clone vs create) captured in
 * step 1 and the auto-agent answer (with its GitHub username) captured in
 * step 2 both live here so the step components stay presentational and the
 * wizard parent keeps owning the state machine.
 */

/** The project flow's step keys (issue #183: pi/gh auth moved to the global flow). */
export type ProjectStep = "source" | "autoagent";
import type { Project } from "@pideck/shared";
import { apiRegisterProject } from "../../lib/api";
import { boardStore } from "../../store/store";

export type WizardForm = {
  /** Step 1: register an existing repo, or create a new (private-by-default) one. */
  mode: "clone" | "create";
  repoUrl: string;
  repoName: string;
  isPublic: boolean;
  /** Step 2: should issues auto-create agents? */
  autoAgent: "no" | "yes";
  username: string;
};

export const INITIAL_FORM: WizardForm = {
  mode: "clone",
  repoUrl: "",
  repoName: "",
  isPublic: false,
  autoAgent: "no",
  username: "",
};

/** Expands `owner/repo` shorthands to full GitHub https URLs. */
function normalizeRepoUrl(input: string): string {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}`;
  return value;
}

/** Step 3 validation: the clone flow needs a repo URL, the create flow a name. */
export function sourceFormError(form: WizardForm): string | null {
  if (form.mode === "clone" && normalizeRepoUrl(form.repoUrl).trim().length === 0) {
    return "Select a repository to clone.";
  }
  if (form.mode === "create" && form.repoName.trim().length === 0) {
    return "Enter a name for the new repository.";
  }
  return null;
}

/** Step 4 validation: watching a username requires the username. */
export function autoAgentFormError(form: WizardForm): string | null {
  if (form.autoAgent === "yes" && form.username.trim().length === 0) {
    return "Enter the GitHub username to watch (or choose No).";
  }
  return null;
}

/**
 * Registers the project via the real `POST /api/projects` endpoint. On
 * success the returned project is seeded into the shared store (issue #203):
 * without that, the store's project list stayed stale until the next poll
 * and the new project rendered as "not found" until a page refresh.
 */
export async function registerProject(form: WizardForm): Promise<Project> {
  const trimmedName = form.repoName.trim();
  const settings = {
    autoAgentUsername: form.autoAgent === "yes" && form.username.trim().length > 0 ? form.username.trim() : null,
  };
  const body =
    form.mode === "clone"
      ? { mode: "clone" as const, repoUrl: normalizeRepoUrl(form.repoUrl), ...(trimmedName ? { name: trimmedName } : {}), settings }
      : { mode: "create" as const, name: trimmedName, isPrivate: !form.isPublic, settings };
  const project = await apiRegisterProject(body);
  boardStore.upsertProject(project);
  return project;
}
