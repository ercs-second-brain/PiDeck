/**
 * gh authentication and permission detection.
 *
 * Answers two questions the daemon needs before it can act:
 * - Is `gh` authenticated, and from where does the token come
 *   (GH_TOKEN / GITHUB_TOKEN env vars, or gh's hosts.yml)?
 * - Does the token have the scopes required to create repositories
 *   (the daemon defaults to private, which needs the `repo` scope)?
 */

import { GhClient, type GhRunner } from "./gh.js";

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------

export type TokenSource = "env:GH_TOKEN" | "env:GITHUB_TOKEN" | "gh hosts.yml" | "none";

/** Where the gh token used for API calls comes from. */
export function detectTokenSource(env: NodeJS.ProcessEnv = process.env): TokenSource {
  if (env["GH_TOKEN"]) return "env:GH_TOKEN";
  if (env["GITHUB_TOKEN"]) return "env:GITHUB_TOKEN";
  return "gh hosts.yml";
}

/** Result of probing gh authentication. */
export interface AuthStatus {
  authenticated: boolean;
  /** Login of the authenticated user, `null` when unauthenticated. */
  login: string | null;
  tokenSource: TokenSource;
  /** OAuth scopes of the token (`[]` for fine-grained/app tokens, which do not report scopes). */
  scopes: string[];
}

/** Whether a token is actually available (env vars or `gh auth token`). */
export async function hasGhToken(run: GhRunner): Promise<boolean> {
  if (process.env["GH_TOKEN"] || process.env["GITHUB_TOKEN"]) return true;
  try {
    const { stdout } = await run(["auth", "token"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Probes `gh` authentication: login, token source, and token scopes.
 * Scopes are read from the `x-oauth-scopes` response header of `GET /user`
 * (fine-grained and GitHub App tokens report none — see permission check).
 */
export async function getAuthStatus(gh: GhClient): Promise<AuthStatus> {
  const tokenSource = detectTokenSource();
  try {
    const { data, headers } = await gh.apiWithHeaders<{ login?: string }>("/user");
    const scopes = (headers["x-oauth-scopes"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { authenticated: true, login: data.login ?? null, tokenSource, scopes };
  } catch {
    return { authenticated: false, login: null, tokenSource, scopes: [] };
  }
}

// ---------------------------------------------------------------------------
// Repo-creation permission
// ---------------------------------------------------------------------------

/**
 * Tri-state permission result. `"unknown"` means the token did not report
 * scopes (fine-grained PAT / GitHub App token), so sufficiency cannot be
 * inferred client-side; the caller must try and handle the failure.
 */
type Permission = "yes" | "no" | "unknown";

export interface RepoCreationPermissions {
  /** Can create repos with the daemon's default (private) visibility — requires the `repo` scope. */
  canCreatePrivateRepos: Permission;
  /** Can create public repos (`repo` or `public_repo` scope). */
  canCreatePublicRepos: Permission;
  /** Overall verdict for the daemon's private-default flow. */
  canCreateRepos: Permission;
  scopes: string[];
  /** Human-readable explanation, suitable for surfacing in the UI. */
  detail: string;
}

/**
 * Detects whether the authenticated token may create repositories.
 * Classic PATs: `repo` covers private+public, `public_repo` covers public only.
 * Unauthenticated → `"no"`; scope-less tokens (fine-grained/App) → `"unknown"`.
 */
export async function getRepoCreationPermissions(gh: GhClient): Promise<RepoCreationPermissions> {
  const status = await getAuthStatus(gh);
  if (!status.authenticated) {
    return {
      canCreatePrivateRepos: "no",
      canCreatePublicRepos: "no",
      canCreateRepos: "no",
      scopes: [],
      detail: "gh is not authenticated; run `gh auth login` or set GH_TOKEN/GITHUB_TOKEN.",
    };
  }
  if (status.scopes.length === 0) {
    return {
      canCreatePrivateRepos: "unknown",
      canCreatePublicRepos: "unknown",
      canCreateRepos: "unknown",
      scopes: [],
      detail: "Token does not report scopes (fine-grained PAT or GitHub App); repo-creation permission cannot be verified locally.",
    };
  }
  const hasRepo = status.scopes.includes("repo");
  const hasPublicRepo = status.scopes.includes("public_repo");
  const canCreatePrivate: Permission = hasRepo ? "yes" : "no";
  const canCreatePublic: Permission = hasRepo || hasPublicRepo ? "yes" : "no";
  // The daemon creates repos private by default, so overall sufficiency
  // tracks the private-repo verdict.
  const overall: Permission = canCreatePrivate;
  const detail = hasRepo
    ? "Token has the `repo` scope; private (default) and public repo creation are allowed."
    : hasPublicRepo
      ? "Token only has `public_repo`; it cannot create private repos (the daemon default)."
      : `Token scopes (${status.scopes.join(", ")}) do not allow repo creation; \`repo\` scope is required.`;
  return { canCreatePrivateRepos: canCreatePrivate, canCreatePublicRepos: canCreatePublic, canCreateRepos: overall, scopes: status.scopes, detail };
}
