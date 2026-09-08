/**
 * Contract tests for project registration (issue #216): repo-name casing
 * must survive the URL/slug pipeline verbatim, and a failed initial clone
 * surfaces as a 4xx with an actionable message — never a raw 500.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectSchema } from "@pideck/shared";

import { GitError } from "../github/repos.js";
import { startContractServer, type ContractServer } from "./contract-fixtures.js";

let server: ContractServer;

beforeAll(async () => {
  server = await startContractServer();
});

afterAll(async () => {
  await server?.close();
});

describe("project registration (issue #216)", () => {
  it("uses the exact lowercase clone URL for a lowercase repo name", async () => {
    const { api, daemon } = server;
    const created = await api("POST", "/api/projects", { mode: "create", name: "pidecktest" });
    expect(created.status).toBe(200);
    const project = projectSchema.parse(created.json);
    expect(project.repoUrl).toBe("https://github.com/o/pidecktest");
    expect(project.id).toBe("pidecktest");
    expect(daemon.cloned.has(`${daemon.stateDir}/projects/pidecktest/clone`)).toBe(true);
  });

  it("preserves mixed-case repo names verbatim", async () => {
    const { api } = server;
    const mixed = await api("POST", "/api/projects", { mode: "clone", repoUrl: "https://github.com/o/MixedCase" });
    expect(mixed.status).toBe(200);
    const project = projectSchema.parse(mixed.json);
    expect(project.repoUrl).toBe("https://github.com/o/MixedCase");
    // The project-dir slug matches the URL casing (no separate transform).
    expect(project.id).toBe("o-MixedCase");
  });

  it("returns a 4xx with an actionable message when the clone fails", async () => {
    const failing = await startContractServer({
      git: async (args) => {
        throw new GitError(args, 128, "fatal: repository 'https://github.com/o/ghost/' not found");
      },
    });
    try {
      const res = await failing.api("POST", "/api/projects", { mode: "clone", repoUrl: "https://github.com/o/ghost" });
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toContain(
        "repo not found at https://github.com/o/ghost — check the name and your gh access",
      );
    } finally {
      await failing.close();
    }
  });
});
