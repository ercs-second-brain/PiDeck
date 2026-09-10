/**
 * Tests for the settings modals (issue #264): settings are modal dialogs
 * over the current view — the global modal from the sidebar footer, the
 * project modal from the sidebar's ⋯ menu — with no dedicated routes and
 * no back links. The per-project vs global distinction is preserved
 * (workerConcurrency is project-level; the worker
 * pipeline + notification toggles are daemon-wide).
 *
 * The notification toggle display ratchet (issue #204) keeps its tests at
 * the bottom, exercised via GlobalWorkerSettings with the api layer mocked.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { projectSchema, type Project, type SettingsRead } from "@pideck/shared";

vi.mock("../lib/api", () => ({
  apiGetSettings: vi.fn(),
  apiUpdateSettings: vi.fn(),
  apiUpdateProject: vi.fn(),
  errorMessage: (err: unknown) => String(err),
}));

const store = vi.hoisted(() => ({
  state: null as import("../store/store").AppState | null,
}));

vi.mock("../store/store", () => ({
  useAppState: () => store.state,
  boardStore: {
    getState: () => store.state,
    subscribe: () => () => {},
    loadProject: async () => {},
    refresh: async () => {},
    upsertProject: () => {},
  },
}));

import { GlobalSettingsModal, GlobalWorkerSettings, ProjectSettingsModal, reviewAccountSaveBody, reviewTokenPlaceholder } from "./SettingsModal";
import type { AppState } from "../store/store";

const SETTINGS: SettingsRead = {
  defaultWorkerConcurrency: 0,
  terminateOnMerge: true,
  autoFixCi: true,
  autoFixReviewComments: true,
  autoReview: true,
  reviewAccountUsername: null,
  reviewAccountTokenConfigured: false,
  browserMergeNotifications: false,
};

const { apiGetSettings } = vi.mocked(await import("../lib/api"));

beforeEach(() => {
  apiGetSettings.mockResolvedValue(SETTINGS);
});

afterEach(() => {
  delete (globalThis as { Notification?: unknown }).Notification;
  delete (globalThis as { window?: unknown }).window;
});

const PROJECT_ID = "demo";

const project: Project = projectSchema.parse({
  id: PROJECT_ID,
  name: "Demo",
  repoUrl: "https://github.com/o/r",
  defaultBranch: "main",
  settings: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function storeState(projects: Project[], loaded: boolean): AppState {
  return { projects, loaded } as unknown as AppState;
}

describe("settings modals (issue #264)", () => {
  it("global modal: dialog over the current view, daemon-wide framing, close affordance", () => {
    const html = renderToString(<GlobalSettingsModal onClose={() => {}} />);
    expect(html).toContain('aria-label="Global settings"');
    expect(html).toContain("Daemon-wide — applies to every project.");
    expect(html).toContain("Worker pipeline (all projects)");
    // Issue #322: all four pipeline toggles render daemon-wide, incl. auto review.
    expect(html).toContain("Auto review agents");
    // Issue #359: on/off controls are the shared Toggle switch, not checkboxes.
    expect(html).toContain('role="switch"');
    expect(html).toContain("toggle-switch");
    expect(html).toContain('aria-label="Close global settings"');
    // No page chrome, no back link.
    expect(html).not.toContain("back-link");
    expect(html).not.toContain("← All projects");
  });

  it("project modal: loading state before the store resolves", () => {
    store.state = storeState([], false);
    const html = renderToString(<ProjectSettingsModal projectId={PROJECT_ID} onClose={() => {}} />);
    expect(html).toContain("Loading…");
  });

  it("project modal: not-found state once the store has loaded", () => {
    store.state = storeState([], true);
    const html = renderToString(<ProjectSettingsModal projectId={PROJECT_ID} onClose={() => {}} />);
    expect(html).toContain(`Project “${PROJECT_ID}” not found.`);
  });

  it("project modal: per-project form and daemon-wide toggles, no back link", () => {
    store.state = storeState([project], true);
    const html = renderToString(<ProjectSettingsModal projectId={PROJECT_ID} onClose={() => {}} />);
    // React marks the interpolated name with a comment node — assert the
    // pieces separately.
    expect(html).toContain(">Demo");
    expect(html).toContain("— settings");
    expect(html).toContain("https://github.com/o/r");
    // The per-project distinction: the worker cap field.
    expect(html).toContain('id="worker-concurrency"');
    // Issue #322: the four tri-state per-project toggle overrides, defaulting
    // to "inherit" for a project with no overrides.
    expect(html).toContain('id="project-autoReview"');
    expect(html).toContain('id="project-autoFixCi"');
    expect(html).toContain('id="project-autoFixReviewComments"');
    expect(html).toContain('id="project-terminateOnMerge"');
    expect((html.match(/Inherit daemon-wide setting/g) ?? []).length).toBe(4);
    // …plus the daemon-wide toggles shared with the global modal.
    expect(html).toContain("Worker pipeline (all projects)");
    expect(html).toContain('aria-label="Close project settings"');
    expect(html).not.toContain("back-link");
  });
});

describe("review account (issue #428)", () => {
  it("renders username + write-only token fields in the global settings", () => {
    const html = renderToString(<GlobalWorkerSettings />);
    expect(html).toContain("Review account (all projects)");
    expect(html).toContain('id="review-account-username"');
    expect(html).toContain('id="review-account-token"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Save review account");
    // Before settings load the token field is a plain write-only input.
    expect(html).toContain("personal access token");
  });

  it("reviewTokenPlaceholder never reveals a stored token — only its configured-ness", () => {
    expect(reviewTokenPlaceholder(null)).toBe("personal access token");
    expect(reviewTokenPlaceholder({ ...SETTINGS, reviewAccountTokenConfigured: false })).toBe("personal access token");
    expect(reviewTokenPlaceholder({ ...SETTINGS, reviewAccountTokenConfigured: true })).toBe("configured — type to replace");
  });

  it("reviewAccountSaveBody keeps the stored token when the token field is blank", () => {
    const configured: SettingsRead = { ...SETTINGS, reviewAccountTokenConfigured: true };
    // Rename only: username travels, token is left out (the daemon merges and
    // keeps the stored half — both-or-neither holds).
    expect(reviewAccountSaveBody(configured, "new-name", "")).toEqual({ reviewAccountUsername: "new-name" });
    // Typed token replaces the stored one — both halves together.
    expect(reviewAccountSaveBody(configured, "new-name", " ghp_new ")).toEqual({
      reviewAccountUsername: "new-name",
      reviewAccountToken: "ghp_new",
    });
    // Clearing the username while configured clears both halves (#424).
    expect(reviewAccountSaveBody(configured, "", "")).toEqual({ reviewAccountUsername: null, reviewAccountToken: null });
    // Not configured: setting a username without a token sends the username —
    // the daemon's both-or-neither refine rejects it with a 400 the UI shows.
    expect(reviewAccountSaveBody(SETTINGS, "new-name", "")).toEqual({ reviewAccountUsername: "new-name" });
    expect(reviewAccountSaveBody(SETTINGS, "", "")).toEqual({ reviewAccountUsername: null });
  });
});

describe("browser-notification toggle (issue #204)", () => {
  it("is disabled with an honest message on insecure origins", () => {
    const html = renderToString(<GlobalWorkerSettings />);
    expect(html).toContain("Browser notifications require HTTPS (or localhost). In-app toasts and the notification center still work.");
    expect(html).toContain("disabled");
  });

  it("keeps the normal toggle on secure contexts", () => {
    (globalThis as { Notification?: unknown }).Notification = { permission: "granted" };
    (globalThis as { window?: unknown }).window = { isSecureContext: true };
    const html = renderToString(<GlobalWorkerSettings />);
    expect(html).toContain("Fires an OS-level browser notification when a worker&#x27;s PR merges");
    expect(html).not.toContain("require HTTPS");
  });
});
