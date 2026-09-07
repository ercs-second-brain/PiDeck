/**
 * gh auth probe (webapp onboarding wizard, issue #13).
 */

import { GhClient, getAuthStatus, getRepoCreationPermissions } from "../github/index.js";
import { Router } from "./router.js";

/** Response body of `GET /api/gh-auth`: gh auth status + repo-creation permission. */
export interface GhAuthPayload {
  authenticated: boolean;
  /** Login of the authenticated user, `null` when unauthenticated. */
  login: string | null;
  tokenSource: string;
  scopes: string[];
  canCreateRepos: "yes" | "no" | "unknown";
  canCreatePrivateRepos: "yes" | "no" | "unknown";
  canCreatePublicRepos: "yes" | "no" | "unknown";
  /** Human-readable explanation, suitable for surfacing in the UI. */
  detail: string;
}

/**
 * Probes the daemon's `gh` authentication and repo-creation permissions
 * (github module's auth check from #22) for the webapp onboarding wizard.
 * Non-contract route (like `/api/status`): deliberately not in the shared
 * endpoint map — it is a daemon-side capability probe, not a resource API.
 */
export async function ghAuthPayload(gh: GhClient = new GhClient()): Promise<GhAuthPayload> {
  const [status, permissions] = await Promise.all([getAuthStatus(gh), getRepoCreationPermissions(gh)]);
  return {
    authenticated: status.authenticated,
    login: status.login,
    tokenSource: status.tokenSource,
    scopes: status.scopes,
    canCreateRepos: permissions.canCreateRepos,
    canCreatePrivateRepos: permissions.canCreatePrivateRepos,
    canCreatePublicRepos: permissions.canCreatePublicRepos,
    detail: permissions.detail,
  };
}

/** Mounts `GET /api/gh-auth` on the router. */
export function registerGhAuthRoute(router: Router): void {
  router.add("GET", "/api/gh-auth", () => ghAuthPayload().then((body) => ({ body })));
}
