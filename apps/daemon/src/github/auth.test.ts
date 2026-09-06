import { describe, expect, it } from "vitest";

import { detectTokenSource, getAuthStatus, getRepoCreationPermissions } from "./auth.js";
import { GhClient } from "./gh.js";

function httpBody(login: string, scopes: string): string {
  return ["HTTP/1.1 200 OK", `X-OAuth-Scopes: ${scopes}`, "", JSON.stringify({ login })].join("\r\n");
}

describe("detectTokenSource", () => {
  it("prefers GH_TOKEN over GITHUB_TOKEN over gh hosts", () => {
    expect(detectTokenSource({})).toBe("gh hosts.yml");
    expect(detectTokenSource({ GITHUB_TOKEN: "t" })).toBe("env:GITHUB_TOKEN");
    expect(detectTokenSource({ GH_TOKEN: "t", GITHUB_TOKEN: "t2" })).toBe("env:GH_TOKEN");
  });
});

describe("getAuthStatus", () => {
  it("reports login and scopes on success", async () => {
    const gh = new GhClient(
      async (args) => {
        expect(args).toEqual(["api", "-i", "/user"]);
        return { stdout: httpBody("eric", "gist, repo, workflow"), stderr: "" };
      },
    );
    const status = await getAuthStatus(gh);
    expect(status).toEqual({ authenticated: true, login: "eric", tokenSource: "gh hosts.yml", scopes: ["gist", "repo", "workflow"] });
  });

  it("reports unauthenticated when the API call fails", async () => {
    const gh = new GhClient(
      async () => {
        const err = new Error("exit 1") as Error & { code?: number; stderr?: string };
        err.code = 1;
        err.stderr = "gh: Not Found";
        throw err;
      },
    );
    const status = await getAuthStatus(gh);
    expect(status.authenticated).toBe(false);
    expect(status.login).toBeNull();
    expect(status.scopes).toEqual([]);
  });
});

describe("getRepoCreationPermissions", () => {
  it("yes with the repo scope", async () => {
    const gh = new GhClient(async () => ({ stdout: httpBody("eric", "repo"), stderr: "" }));
    const perms = await getRepoCreationPermissions(gh);
    expect(perms.canCreateRepos).toBe("yes");
    expect(perms.canCreatePrivateRepos).toBe("yes");
    expect(perms.canCreatePublicRepos).toBe("yes");
    expect(perms.detail).toContain("repo");
  });

  it("public_repo only cannot create private repos", async () => {
    const gh = new GhClient(async () => ({ stdout: httpBody("eric", "public_repo"), stderr: "" }));
    const perms = await getRepoCreationPermissions(gh);
    expect(perms.canCreatePrivateRepos).toBe("no");
    expect(perms.canCreatePublicRepos).toBe("yes");
    expect(perms.canCreateRepos).toBe("no");
    expect(perms.detail).toContain("public_repo");
  });

  it("unknown when the token reports no scopes (fine-grained / App token)", async () => {
    const gh = new GhClient(async () => ({ stdout: httpBody("app-token", ""), stderr: "" }));
    const perms = await getRepoCreationPermissions(gh);
    expect(perms.canCreateRepos).toBe("unknown");
    expect(perms.canCreatePrivateRepos).toBe("unknown");
    expect(perms.detail).toContain("cannot be verified");
  });

  it("no when unauthenticated", async () => {
    const gh = new GhClient(
      async () => {
        throw Object.assign(new Error("exit 1"), { code: 1, stderr: "bad credentials" });
      },
    );
    const perms = await getRepoCreationPermissions(gh);
    expect(perms.canCreateRepos).toBe("no");
    expect(perms.detail).toContain("gh auth login");
  });
});
