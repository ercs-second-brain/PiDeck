import { describe, expect, it } from "vitest";

import { GhClient } from "./gh.js";
import { cloneRepo, createRepo, defaultGitRunner, GitError, listAccessibleRepos } from "./repos.js";

describe("listAccessibleRepos", () => {
  it("maps `gh repo list` output to owner/name/isPrivate verbatim (issue #217)", async () => {
    const seen: string[][] = [];
    const gh = new GhClient(async (args) => {
      seen.push(args);
      return {
        stdout: JSON.stringify([
          { name: "pidecktest", owner: { login: "eric" }, isPrivate: true },
          { name: "MixedCase", owner: { login: "eric" }, isPrivate: false },
        ]),
        stderr: "",
      };
    });
    const repos = await listAccessibleRepos(gh);
    expect(seen).toEqual([["repo", "list", "--limit", "200", "--json", "name,owner,isPrivate"]]);
    expect(repos).toEqual([
      { owner: "eric", name: "pidecktest", isPrivate: true },
      { owner: "eric", name: "MixedCase", isPrivate: false },
    ]);
  });
});

describe("cloneRepo", () => {
  it("builds a plain git clone command", async () => {
    const seen: string[][] = [];
    const git = async (args: string[]) => {
      seen.push(args);
      return { stdout: "", stderr: "" };
    };
    const res = await cloneRepo(git, "https://github.com/o/r", "/tmp/proj");
    expect(seen).toEqual([["clone", "https://github.com/o/r", "/tmp/proj"]]);
    expect(res).toEqual({ destDir: "/tmp/proj", repoUrl: "https://github.com/o/r" });
  });

  it("supports branch and depth options", async () => {
    const seen: string[][] = [];
    const git = async (args: string[]) => {
      seen.push(args);
      return { stdout: "", stderr: "" };
    };
    await cloneRepo(git, "https://github.com/o/r", "/tmp/proj", { branch: "dev", depth: 1 });
    expect(seen[0]).toEqual(["clone", "--branch", "dev", "--depth", "1", "https://github.com/o/r", "/tmp/proj"]);
  });

  it("wraps unexpected runner errors in GitError", async () => {
    const git = async () => {
      throw new Error("ENOENT");
    };
    await expect(cloneRepo(git, "https://github.com/o/r", "/tmp/proj")).rejects.toThrow(GitError);
  });

  it("defaultGitRunner wraps git failures in GitError", async () => {
    // `git clone` into a non-empty existing dir fails fast and locally.
    await expect(defaultGitRunner(["clone", "https://example.invalid/o/r.git", "/tmp"])).rejects.toThrow(GitError);
  });
});

describe("createRepo", () => {
  function runnerFor(seen: string[][], apiRepo: object) {
    return async (args: string[]) => {
      seen.push(args);
      if (args[0] === "repo") return { stdout: "https://github.com/eric/new-repo\n", stderr: "" };
      if (args[0] === "api" && args[1] === "/repos/eric/new-repo") {
        return { stdout: JSON.stringify(apiRepo), stderr: "" };
      }
      throw new Error(`unexpected args: ${JSON.stringify(args)}`);
    };
  }

  it("defaults to private and verifies visibility via the API", async () => {
    const seen: string[][] = [];
    const gh = new GhClient(runnerFor(seen, { html_url: "https://github.com/eric/new-repo", private: true, owner: { login: "eric" }, name: "new-repo" }));
    const created = await createRepo(gh, { name: "new-repo", description: "test" });
    expect(seen[0]).toEqual(["repo", "create", "new-repo", "--private", "--description", "test"]);
    expect(created).toEqual({ url: "https://github.com/eric/new-repo", owner: "eric", repo: "new-repo", isPrivate: true });
  });

  it("uses --public when explicitly toggled, and reports the API's authoritative visibility", async () => {
    const seen: string[][] = [];
    const gh = new GhClient(runnerFor(seen, { html_url: "https://github.com/eric/new-repo", private: false, owner: { login: "eric" }, name: "new-repo" }));
    const created = await createRepo(gh, { name: "new-repo", isPrivate: false });
    expect(seen[0]).toEqual(["repo", "create", "new-repo", "--public"]);
    expect(created.isPrivate).toBe(false);
  });

  it("supports owner/name targets", async () => {
    const seen: string[][] = [];
    const gh = new GhClient(async (args) => {
      seen.push(args);
      if (args[0] === "repo") return { stdout: "https://github.com/org/new-repo\n", stderr: "" };
      return { stdout: JSON.stringify({ html_url: "https://github.com/org/new-repo", private: true, owner: { login: "org" }, name: "new-repo" }), stderr: "" };
    });
    await createRepo(gh, { name: "org/new-repo" });
    expect(seen[0]).toEqual(["repo", "create", "org/new-repo", "--private"]);
  });
});
