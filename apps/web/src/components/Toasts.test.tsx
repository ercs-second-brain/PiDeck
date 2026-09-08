/**
 * Tests for the merged-PR toast surface (issue #111). The wrapper's
 * effects (store subscription, timers, browser notifications) are thin;
 * the pure parts — dedupe/bounding, text, view — are exercised directly,
 * same pattern as the update-banner tests.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { NotificationEvent, Project } from "@agentskiss/shared";

import { appendToast, MAX_TOASTS, ToastStack, toastKey, toastText, type MergedPRToast } from "./Toasts";

const NOW = "2026-01-02T03:04:05.000Z";

function mergedEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return { type: "notification.pr.merged", at: NOW, projectId: "kisstest", prNumber: 42, title: "Fix the flaky test", ...overrides };
}

const KISSTEST: Project = {
  id: "kisstest",
  name: "kisstest",
  repoUrl: "https://github.com/example/kisstest",
  defaultBranch: "main",
  settings: { autoAgentUsername: null },
  createdAt: NOW,
  updatedAt: NOW,
};

describe("toastKey / toastText (issue #111)", () => {
  it("keys toasts per project + PR", () => {
    expect(toastKey("kisstest", 42)).toBe("kisstest#42");
  });

  it("prefers the project name and falls back to the raw id", () => {
    const toast: MergedPRToast = { key: "kisstest#42", projectId: "kisstest", prNumber: 42, title: "x" };
    expect(toastText("kisstest", toast)).toBe("kisstest #42 merged");
    expect(toastText(undefined, toast)).toBe("kisstest #42 merged");
  });
});

describe("appendToast (issue #111)", () => {
  it("appends an event as a toast", () => {
    const toasts = appendToast([], mergedEvent());
    expect(toasts).toEqual([{ key: "kisstest#42", projectId: "kisstest", prNumber: 42, title: "Fix the flaky test" }]);
  });

  it("dedupes re-emissions of the same merge", () => {
    const once = appendToast([], mergedEvent());
    expect(appendToast(once, mergedEvent({ at: "2026-01-02T03:09:05.000Z" }))).toBe(once);
  });

  it("keeps at most the newest toasts", () => {
    let toasts: MergedPRToast[] = [];
    for (let n = 1; n <= MAX_TOASTS + 1; n++) {
      toasts = appendToast(toasts, mergedEvent({ projectId: "p", prNumber: n }));
    }
    expect(toasts.map((t) => t.prNumber)).toEqual([2, 3, 4, MAX_TOASTS + 1]);
  });
});

describe("ToastStack (issue #111)", () => {
  it("renders nothing without toasts", () => {
    expect(renderToString(<ToastStack toasts={[]} projects={[KISSTEST]} onDismiss={() => {}} />)).not.toContain("toasts");
  });

  it("renders '<project> #42 merged' with the PR title and a dismiss affordance", () => {
    const html = renderToString(
      <ToastStack
        toasts={[{ key: "kisstest#42", projectId: "kisstest", prNumber: 42, title: "Fix the flaky test" }]}
        projects={[KISSTEST]}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("toasts");
    expect(html).toContain("kisstest #42 merged");
    expect(html).toContain("Fix the flaky test");
    expect(html).toContain("Dismiss");
  });

  it("falls back to the project id for unknown projects", () => {
    const html = renderToString(
      <ToastStack
        toasts={[{ key: "ghost#7", projectId: "ghost", prNumber: 7, title: "Ghost PR" }]}
        projects={[KISSTEST]}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("ghost #7 merged");
  });
});
