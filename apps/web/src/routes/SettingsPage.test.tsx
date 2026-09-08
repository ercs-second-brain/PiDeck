/**
 * Tests for the settings page's notification toggle display (issue #204):
 * on insecure origins (plain-HTTP LAN deployments — the primary mode) the
 * browser-notification toggle is disabled with an honest message, and the
 * daemon setting is never saved; on secure contexts the normal flow stays.
 * The GlobalWorkerSettings component is exercised directly (same
 * renderToString pattern as the other view tests) with the api layer mocked.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import type { Settings } from "@pideck/shared";

vi.mock("../lib/api", () => ({
  apiGetSettings: vi.fn(),
  apiUpdateSettings: vi.fn(),
  apiUpdateProject: vi.fn(),
  errorMessage: (err: unknown) => String(err),
}));

import { GlobalWorkerSettings } from "./SettingsPage";

const SETTINGS: Settings = {
  autoAgentUsername: null,
  defaultWorkerConcurrency: 0,
  terminateOnMerge: true,
  autoFixCi: true,
  autoFixReviewComments: true,
  autoReview: true,
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
