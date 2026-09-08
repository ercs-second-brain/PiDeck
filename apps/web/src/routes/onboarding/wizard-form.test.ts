/**
 * Registration-call tests (issue #203): `registerProject` posts the wizard
 * form to `POST /api/projects` and, on success, seeds the returned project
 * into the shared store so the sidebar row and the project's board work
 * immediately — no page refresh, no wait for the next poll.
 */

import { describe, expect, it, vi } from "vitest";
import { projectSchema, type Project } from "@pideck/shared";
import { boardStore } from "../../store/store";
import { INITIAL_FORM, prefillUsername, registerProject, type WizardForm } from "./wizard-form";

vi.mock("../../lib/api", () => ({
  apiRegisterProject: vi.fn(async () => {
    throw new Error("apiRegisterProject not stubbed");
  }),
  // The store's other REST reads (its board load runs after seeding).
  apiListProjects: vi.fn(async () => [] as Project[]),
  apiGetKanban: vi.fn(async () => {
    throw new Error("apiGetKanban not stubbed");
  }),
  apiListWorkers: vi.fn(async () => [] as import("@pideck/shared").Worker[]),
  apiListPullRequests: vi.fn(async () => [] as import("@pideck/shared").PullRequest[]),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { apiGetKanban, apiRegisterProject } from "../../lib/api";

const mockRegister = vi.mocked(apiRegisterProject);
const mockGetKanban = vi.mocked(apiGetKanban);

function form(patch: Partial<WizardForm>): WizardForm {
  return { ...INITIAL_FORM, ...patch };
}

describe("prefillUsername (autoAgentUsername prefill)", () => {
  it("fills an empty username with the authenticated login", () => {
    expect(prefillUsername(INITIAL_FORM, "octocat")).toEqual({ ...INITIAL_FORM, username: "octocat" });
  });

  it("never overwrites a username the user already typed", () => {
    const typed = form({ username: "someone-else" });
    expect(prefillUsername(typed, "octocat")).toBe(typed);
  });

  it("leaves the form unchanged when the daemon is unauthenticated", () => {
    expect(prefillUsername(INITIAL_FORM, null)).toBe(INITIAL_FORM);
    expect(prefillUsername(INITIAL_FORM, "")).toBe(INITIAL_FORM);
  });
});

describe("registerProject (issue #203)", () => {
  it("seeds the store so the board page finds the project without a refresh", async () => {
    const project = projectSchema.parse({
      id: "wizard-203",
      name: "Wizard Fresh",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      settings: { autoAgentUsername: null },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockRegister.mockResolvedValueOnce(project);

    const registered = await registerProject(form({ mode: "clone", repoUrl: "o/r" }));

    // POST went out with the normalized (expanded shorthand) repo URL.
    expect(mockRegister).toHaveBeenCalledWith({
      mode: "clone",
      repoUrl: "https://github.com/o/r",
      settings: { autoAgentUsername: null },
    });
    expect(registered).toEqual(project);
    // The shared store now knows the project…
    expect(boardStore.getState().projects.find((p) => p.id === project.id)).toEqual(project);
    // …and the board load was kicked through the single-flight path.
    await vi.waitFor(() => {
      expect(mockGetKanban).toHaveBeenCalledWith(project.id);
    });
  });

  it("does not seed the store when registration fails", async () => {
    mockRegister.mockRejectedValueOnce(new Error("clone failed"));
    await expect(registerProject(form({ mode: "clone", repoUrl: "https://github.com/o/fail" }))).rejects.toThrow(
      "clone failed",
    );
    expect(boardStore.getState().projects.some((p) => p.repoUrl === "https://github.com/o/fail")).toBe(false);
  });
});
