/**
 * Tests for the merged-PR toast surface (issue #111). The wrapper's
 * effects (store subscription, timers, browser notifications) are thin;
 * the pure parts — dedupe/bounding, text, view — are exercised directly,
 * same pattern as the update-banner tests.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { NotificationEvent, Project } from "@pideck/shared";

import { appendToast, headline, MAX_TOASTS, ToastStack, toastKey, type AgentReportToast, type AppToast, type MergedPRToast } from "./Toasts";

const NOW = "2026-01-02T03:04:05.000Z";

/** The merged-PR member of the notification union (the agent-report member has its own describe below). */
type MergedEvent = Extract<NotificationEvent, { type: "notification.pr.merged" }>;

function mergedEvent(overrides: Partial<MergedEvent> = {}): MergedEvent {
  return { type: "notification.pr.merged", at: NOW, projectId: "kisstest", prNumber: 42, title: "Fix the flaky test", ...overrides };
}

const KISSTEST: Project = {
  id: "kisstest",
  name: "kisstest",
  repoUrl: "https://github.com/example/kisstest",
  defaultBranch: "main",
  settings: {},
  createdAt: NOW,
  updatedAt: NOW,
};

describe("toastKey / headline (issue #111)", () => {
  it("keys toasts per project + PR", () => {
    expect(toastKey("kisstest", 42)).toBe("kisstest#42");
  });

  it("keys ready-for-merge toasts apart from merges of the same PR (issue #408)", () => {
    expect(toastKey("kisstest", 42, "ready_for_merge")).toBe("ready:kisstest#42");
  });

  it("prefers the project name and falls back to the raw id", () => {
    const toast: MergedPRToast = { key: "kisstest#42", projectId: "kisstest", prNumber: 42, kind: "merged", title: "x" };
    expect(headline("kisstest", toast)).toBe("kisstest #42 merged");
    expect(headline(undefined, toast)).toBe("kisstest #42 merged");
  });

  it("renders the ready-for-merge headline (issue #408)", () => {
    const ready: MergedPRToast = { key: "ready:kisstest#42", projectId: "kisstest", prNumber: 42, kind: "ready_for_merge", title: "x" };
    expect(headline("kisstest", ready)).toBe("kisstest #42 ready for merge");
  });

  it("renders the agent-report headline (docs/agent-kinds.md, #300/#302)", () => {
    const report: AgentReportToast = { key: "agent:kisstest:sess-agent-1", projectId: "kisstest", agentKind: "kiss-audit", title: "x" };
    expect(headline("kisstest", report)).toBe("kisstest kiss-audit report ready");
  });
});

describe("appendToast (issue #111)", () => {
  it("appends an event as a toast", () => {
    const toasts = appendToast([], mergedEvent());
    expect(toasts).toEqual([{ key: "kisstest#42", projectId: "kisstest", prNumber: 42, kind: "merged", title: "Fix the flaky test" }]);
  });

  it("appends a ready-for-merge event with its own key (issue #408)", () => {
    const event: NotificationEvent = {
      type: "notification.pr.ready_for_merge",
      at: NOW,
      projectId: "kisstest",
      prNumber: 42,
      title: "Fix the flaky test",
    };
    const toasts = appendToast([], event);
    expect(toasts).toEqual([
      { key: "ready:kisstest#42", projectId: "kisstest", prNumber: 42, kind: "ready_for_merge", title: "Fix the flaky test" },
    ]);
  });

  it("dedupes re-emissions of the same merge", () => {
    const once = appendToast([], mergedEvent());
    expect(appendToast(once, mergedEvent({ at: "2026-01-02T03:09:05.000Z" }))).toBe(once);
  });

  it("keeps at most the newest toasts", () => {
    let toasts: AppToast[] = [];
    for (let n = 1; n <= MAX_TOASTS + 1; n++) {
      toasts = appendToast(toasts, mergedEvent({ projectId: "p", prNumber: n }));
    }
    expect(toasts.map((t) => ("prNumber" in t ? t.prNumber : -1))).toEqual([2, 3, 4, MAX_TOASTS + 1]);
  });
});

describe("ToastStack (issue #111)", () => {
  it("renders nothing without toasts", () => {
    expect(renderToString(<ToastStack toasts={[]} projects={[KISSTEST]} onDismiss={() => {}} />)).not.toContain("toasts");
  });

  it("renders '<project> #42 merged' with the PR title and a dismiss affordance", () => {
    const html = renderToString(
      <ToastStack
        toasts={[{ key: "kisstest#42", projectId: "kisstest", prNumber: 42, kind: "merged", title: "Fix the flaky test" }]}
        projects={[KISSTEST]}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("toasts");
    expect(html).toContain("kisstest #42 merged");
    expect(html).toContain("Fix the flaky test");
    expect(html).toContain("Dismiss");
  });

  it("renders the ready-for-merge headline (issue #408)", () => {
    const html = renderToString(
      <ToastStack
        toasts={[{ key: "ready:kisstest#42", projectId: "kisstest", prNumber: 42, kind: "ready_for_merge", title: "Fix the flaky test" }]}
        projects={[KISSTEST]}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("kisstest #42 ready for merge");
});

  it("falls back to the project id for unknown projects", () => {
    const html = renderToString(
      <ToastStack
        toasts={[{ key: "ghost#7", projectId: "ghost", prNumber: 7, kind: "merged", title: "Ghost PR" }]}
        projects={[KISSTEST]}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("ghost #7 merged");
  });
});

describe("agent-report toasts (docs/agent-kinds.md, #300/#302)", () => {
  function agentEvent(): NotificationEvent {
    return { type: "notification.agent.report", at: NOW, projectId: "kisstest", agentKind: "devex-audit", sessionId: "sess-agent-1", reportTargetSessionId: "sess-orch-1", title: "Report ready for triage" };
  }

  it("appends an agent event as a toast keyed by the reporting session", () => {
    const toasts = appendToast([], agentEvent());
    expect(toasts).toEqual([{ key: "agent:kisstest:sess-agent-1", projectId: "kisstest", agentKind: "devex-audit", title: "Report ready for triage" }]);
  });

  it("dedupes re-emissions and keeps merged-PR keys separate", () => {
    const once = appendToast([], agentEvent());
    expect(appendToast(once, agentEvent())).toBe(once);
    const withMerge = appendToast(once, mergedEvent());
    expect(withMerge).toHaveLength(2);
  });

  it("renders '<project> devex-audit report ready' with the report summary", () => {
    const html = renderToString(
      <ToastStack toasts={appendToast([], agentEvent())} projects={[KISSTEST]} onDismiss={() => {}} />,
    );
    expect(html).toContain("kisstest devex-audit report ready");
    expect(html).toContain("Report ready for triage");
  });
});
