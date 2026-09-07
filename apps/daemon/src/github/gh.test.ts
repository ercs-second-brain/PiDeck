import { describe, expect, it } from "vitest";

import { GhClient, ghErrorFromExecError, parseRepoUrl, type GhRunResult } from "./gh.js";

describe("parseRepoUrl", () => {
  it("parses https URLs with and without .git", () => {
    expect(parseRepoUrl("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseRepoUrl("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses ssh URLs", () => {
    expect(parseRepoUrl("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("rejects non-GitHub URLs", () => {
    expect(() => parseRepoUrl("https://gitlab.com/owner/repo")).toThrow(/GitHub/);
    expect(() => parseRepoUrl("not a url")).toThrow(/GitHub/);
  });
});

describe("GhClient", () => {
  it("apiJson parses the JSON body", async () => {
    const gh = new GhClient(async (args) => {
      expect(args).toEqual(["api", "/repos/o/r"]);
      return { stdout: '{"hello":"world"}', stderr: "" };
    });
    await expect(gh.apiJson("/repos/o/r")).resolves.toEqual({ hello: "world" });
  });

  it("apiList follows pages until a short page", async () => {
    const seen: string[] = [];
    const gh = new GhClient(async (args) => {
      expect(args[0]).toBe("api");
      seen.push(args[1] ?? "");
      const page = Number(/[?&]page=(\d+)/.exec(args[1] ?? "")?.[1]);
      const items = page === 1 ? ["a", "b"] : ["c"];
      return { stdout: JSON.stringify(items), stderr: "" };
    });
    await expect(gh.apiList("/repos/o/r/issues", { perPage: 2 })).resolves.toEqual(["a", "b", "c"]);
    expect(seen).toEqual(["/repos/o/r/issues?per_page=2&page=1", "/repos/o/r/issues?per_page=2&page=2"]);
  });

  it("apiList appends page params with & when the path already has a query", async () => {
    const gh = new GhClient(async (args) => {
      expect(args[1]).toContain("&per_page=5");
      return { stdout: "[]", stderr: "" };
    });
    await gh.apiList("/repos/o/r/issues?state=open", { perPage: 5 });
  });

  it("apiWithHeaders returns lowercase headers and parsed body", async () => {
    const raw = [
      "HTTP/1.1 200 OK",
      "X-OAuth-Scopes: repo, workflow",
      "Content-Type: application/json",
      "",
      '{"login":"eric"}',
    ].join("\r\n");
    const gh = new GhClient(async (args) => {
      expect(args).toEqual(["api", "-i", "/user"]);
      return { stdout: raw, stderr: "" };
    });
    const res = await gh.apiWithHeaders<{ login: string }>("/user");
    expect(res.data).toEqual({ login: "eric" });
    expect(res.headers["x-oauth-scopes"]).toBe("repo, workflow");
  });

  it("graphql passes string vars with -f and numeric vars with -F", async () => {
    const seen: string[][] = [];
    const gh = new GhClient(async (args) => {
      seen.push(args);
      return { stdout: '{"data":{"ok":true}}', stderr: "" };
    });
    await expect(gh.graphql("query { ok }", { owner: "o", number: 7 })).resolves.toEqual({ ok: true });
    expect(seen[0]).toEqual(["api", "graphql", "-f", "query=query { ok }", "-f", "owner=o", "-F", "number=7"]);
  });

  it("graphql unwraps data and throws on GraphQL-level errors", async () => {
    const gh = new GhClient(async () => ({ stdout: JSON.stringify({ errors: [{ message: "bad query" }] }), stderr: "" }));
    await expect(gh.graphql("query { nope }")).rejects.toThrow(/bad query/);
  });

  it("exec returns raw stdout/stderr", async () => {
    const gh = new GhClient(async () => ({ stdout: "out", stderr: "err" }) satisfies GhRunResult);
    await expect(gh.exec(["repo", "view"])).resolves.toEqual({ stdout: "out", stderr: "err" });
  });
});

describe("ghErrorFromExecError", () => {
  it("captures exit code and stderr", () => {
    const err = Object.assign(new Error("boom"), { code: 1, stderr: "gh: not found" });
    const ghErr = ghErrorFromExecError(["api", "/user"], err);
    expect(ghErr.exitCode).toBe(1);
    expect(ghErr.stderr).toBe("gh: not found");
    expect(ghErr.args).toEqual(["api", "/user"]);
    expect(ghErr.message).toContain("gh api /user");
  });

  it("handles missing code/stderr", () => {
    const ghErr = ghErrorFromExecError(["auth", "token"], new Error("ENOENT"));
    expect(ghErr.exitCode).toBeNull();
    expect(ghErr.stderr).toBe("");
  });
});
