/**
 * Regression tests for the api layer's write invalidation (issue #203): a
 * successful `POST /api/projects` must not let later projects-list reads
 * join an in-flight GET that started before the registration completed —
 * they would see the pre-registration list and render the new project as
 * "not found" until the next poll.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { projectSchema, type Project } from "@pideck/shared";
import { apiRegisterProject, fetchProjects } from "./api";

const project: Project = projectSchema.parse({
  id: "fresh",
  name: "Fresh",
  repoUrl: "https://github.com/o/r",
  defaultBranch: "main",
  settings: { autoAgentUsername: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("api write invalidation (issue #203)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a projects GET after a successful registration refetches instead of joining the stale in-flight one", async () => {
    let releaseStale!: (response: Response) => void;
    const stale = new Promise<Response>((resolve) => {
      releaseStale = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale) // pre-registration GET /api/projects (pending)
      .mockResolvedValueOnce(jsonResponse(project)) // POST /api/projects
      .mockResolvedValueOnce(jsonResponse([project])); // post-registration GET
    vi.stubGlobal("fetch", fetchMock);

    const preRegistration = fetchProjects();
    const registered = await apiRegisterProject({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const postRegistration = fetchProjects(); // must NOT join `preRegistration`
    releaseStale(jsonResponse([]));

    await expect(preRegistration).resolves.toEqual([]);
    await expect(postRegistration).resolves.toEqual([project]);
    expect(registered).toEqual(project);
    // Three network calls: the stale GET, the POST, and a fresh GET.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
