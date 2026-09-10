/**
 * The project onboarding wizard's form state and registration call (issue
 * #62): the repository source (clone vs create) captured in the single
 * step lives here so the step component stays presentational and the
 * wizard parent keeps owning the state. (Issue #416: the auto-agent
 * question is gone — worker spawning is assignment-driven by default.)
 */

import type { Project } from "@pideck/shared";
import { apiRegisterProject } from "../../lib/api";
import { boardStore } from "../../store/store";

export type WizardForm = {
  /** Step 1: register an existing repo, or create a new (private-by-default) one. */
  mode: "clone" | "create";
  repoUrl: string;
  repoName: string;
  isPublic: boolean;
};

export const INITIAL_FORM: WizardForm = {
  mode: "clone",
  repoUrl: "",
  repoName: "",
  isPublic: false,
};

/** Expands `owner/repo` shorthands to full GitHub https URLs. */
function normalizeRepoUrl(input: string): string {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return `https://github.com/${value}`;
  return value;
}

/** Step validation: the clone flow needs a repo URL, the create flow a name. */
export function sourceFormError(form: WizardForm): string | null {
  if (form.mode === "clone" && normalizeRepoUrl(form.repoUrl).trim().length === 0) {
    return "Select a repository to clone.";
  }
  if (form.mode === "create" && form.repoName.trim().length === 0) {
    return "Enter a name for the new repository.";
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
  const body =
    form.mode === "clone"
      ? { mode: "clone" as const, repoUrl: normalizeRepoUrl(form.repoUrl), ...(trimmedName ? { name: trimmedName } : {}) }
      : { mode: "create" as const, name: trimmedName, isPrivate: !form.isPublic };
  const project = await apiRegisterProject(body);
  boardStore.upsertProject(project);
  return project;
}
