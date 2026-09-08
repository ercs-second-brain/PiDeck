/**
 * Tests for the notification center (issue #178). The store's side effects
 * (localStorage persistence, socket subscription) are thin; the pure parts —
 * append/dedupe/cap, read/clear, the view, and the click-through target —
 * are exercised directly, same pattern as the toast tests.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { NotificationEvent, Project } from "@pideck/shared";

import {
  appendNotification,
  clearAllNotifications,
  clearNotification,
  countUnread,
  MAX_NOTIFICATIONS,
  markNotificationRead,
} from "./notifications";
import { notificationTarget, NotificationList, notificationTime } from "./NotificationCenter";

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

describe("appendNotification (issue #178)", () => {
  it("prepends an event as an unread notification, newest first", () => {
    const first = appendNotification([], mergedEvent());
    expect(first).toEqual([
      { key: "kisstest#42", projectId: "kisstest", prNumber: 42, title: "Fix the flaky test", at: NOW, read: false },
    ]);
    const second = appendNotification(first, mergedEvent({ projectId: "p", prNumber: 7 }));
    expect(second.map((n) => n.prNumber)).toEqual([7, 42]);
  });

  it("dedupes re-emissions of the same merge", () => {
    const once = appendNotification([], mergedEvent());
    expect(appendNotification(once, mergedEvent({ at: "2026-01-02T03:09:05.000Z" }))).toBe(once);
  });

  it("caps the history at the newest notifications", () => {
    let list = appendNotification([], mergedEvent({ prNumber: 0 }));
    for (let n = 1; n <= MAX_NOTIFICATIONS; n++) {
      list = appendNotification(list, mergedEvent({ projectId: "p", prNumber: n }));
    }
    expect(list).toHaveLength(MAX_NOTIFICATIONS);
    expect(list.map((n) => n.prNumber)[0]).toBe(MAX_NOTIFICATIONS);
  });
});

describe("read/clear helpers (issue #178)", () => {
  const list = appendNotification([], mergedEvent());

  it("marks one read", () => {
    const marked = markNotificationRead(list, "kisstest#42");
    expect(marked[0]?.read).toBe(true);
    expect(list[0]?.read).toBe(false); // immutable
  });

  it("clears one and all", () => {
    expect(clearNotification(list, "kisstest#42")).toEqual([]);
    expect(clearAllNotifications()).toEqual([]);
  });

  it("counts unread", () => {
    expect(countUnread(list)).toBe(1);
    expect(countUnread(markNotificationRead(list, "kisstest#42"))).toBe(0);
  });
});

describe("notificationTime (issue #178)", () => {
  it("formats today as a time and older entries with the date", () => {
    const now = new Date("2026-01-02T15:00:00.000Z");
    expect(notificationTime("2026-01-02T03:04:05.000Z", now)).toMatch(/\d{2}:\d{2}/);
    expect(notificationTime("2025-12-31T03:04:05.000Z", now)).toMatch(/Dec 31/);
  });

  it("renders an empty string for an unparsable timestamp", () => {
    expect(notificationTime("not-a-date")).toBe("");
  });
});

describe("NotificationList (issue #178)", () => {
  const item = { key: "kisstest#42", projectId: "kisstest", prNumber: 42, title: "Fix the flaky test", at: NOW, read: false };

  it("renders an empty-state note without notifications", () => {
    const html = renderToString(<NotificationList notifications={[]} projects={[KISSTEST]} onOpen={() => {}} onClear={() => {}} />);
    expect(html).toContain("notif-empty");
  });

  it("renders '<project> #42 merged' with title, time, and per-item clear", () => {
    const html = renderToString(<NotificationList notifications={[item]} projects={[KISSTEST]} onOpen={() => {}} onClear={() => {}} />);
    expect(html).toContain("kisstest #42 merged");
    expect(html).toContain("Fix the flaky test");
    expect(html).toContain("Clear notification");
    expect(html).toContain("notif-item unread");
  });

  it("falls back to the project id for unknown projects", () => {
    const html = renderToString(
      <NotificationList notifications={[{ ...item, projectId: "ghost" }]} projects={[KISSTEST]} onOpen={() => {}} onClear={() => {}} />,
    );
    expect(html).toContain("ghost #42 merged");
  });
});

describe("notificationTarget (issue #178)", () => {
  it("clicks through to the PR diff page", () => {
    expect(notificationTarget({ key: "k", projectId: "kisstest", prNumber: 42, title: "t", at: NOW, read: false })).toBe(
      "/projects/kisstest/pulls/42",
    );
  });
});
