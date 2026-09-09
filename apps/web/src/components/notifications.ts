/**
 * Notification history (issue #178): the durable counterpart to the
 * ephemeral toasts (#111). Every notification event the daemon fans out
 * over the websocket is recorded here and persisted to localStorage, so
 * the bell dropdown survives reloads while keeping toasts as the live
 * popup surface. Deliberately simple: one flat list, newest first,
 * deduped by event key, capped.
 */

import type { AgentKind, NotificationEvent } from "@pideck/shared";
import { toastKey } from "./Toasts";

/** One persisted notification (merged PRs #111; agent audit reports #300/#302). */
export interface CenterNotification {
  /** Stable dedupe key, shared with toasts. */
  key: string;
  projectId: string;
  /** PR number (merged-PR notifications only). */
  prNumber?: number;
  /** The agent kind that finished (agent-report notifications only). */
  agentKind?: AgentKind;
  /** The agent-kind session that ran (agent-report notifications only). */
  sessionId?: string;
  /** Session the report was delivered to (agent-report notifications only):
   * the project orchestrator, where the report lives. */
  reportTargetSessionId?: string;
  /** Headline detail (PR title at merge / report summary). */
  title: string;
  /** Event timestamp (ISO), shown in the dropdown. */
  at: string;
  /** False until the user clicks the item in the dropdown. */
  read: boolean;
}

/** Maximum stored notifications; the oldest drop off. */
export const MAX_NOTIFICATIONS = 50;

const STORAGE_KEY = "pideck.notifications.v1";

/** Stable dedupe key for a notification event, shared with toasts. */
function notificationKey(event: NotificationEvent): string {
  return event.type === "notification.pr.merged"
    ? toastKey(event.projectId, event.prNumber)
    : `agent:${event.projectId}:${event.sessionId}`;
}

/** Appends an event as an unread notification, deduped and newest-first — pure. */
export function appendNotification(list: CenterNotification[], event: NotificationEvent): CenterNotification[] {
  const key = notificationKey(event);
  if (list.some((n) => n.key === key)) return list;
  const base = { key, projectId: event.projectId, title: event.title, at: event.at, read: false };
  const next =
    event.type === "notification.pr.merged"
      ? { ...base, prNumber: event.prNumber }
      : { ...base, agentKind: event.agentKind, sessionId: event.sessionId, reportTargetSessionId: event.reportTargetSessionId };
  return [{ ...next }, ...list].slice(0, MAX_NOTIFICATIONS);
}

/** Marks one notification read — pure. */
export function markNotificationRead(list: CenterNotification[], key: string): CenterNotification[] {
  return list.map((n) => (n.key === key ? { ...n, read: true } : n));
}

/** Removes one notification — pure. */
export function clearNotification(list: CenterNotification[], key: string): CenterNotification[] {
  return list.filter((n) => n.key !== key);
}

/** Removes every notification — pure. */
export function clearAllNotifications(): CenterNotification[] {
  return [];
}

/** Number of unread notifications (the bell badge). */
export function countUnread(list: CenterNotification[]): number {
  return list.filter((n) => !n.read).length;
}

/** Loads persisted notifications; a missing/corrupt store is just empty. */
function loadNotifications(): CenterNotification[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (n): n is CenterNotification =>
        typeof n === "object" && n !== null &&
        typeof (n as CenterNotification).key === "string" &&
        typeof (n as CenterNotification).projectId === "string" &&
        (typeof (n as CenterNotification).prNumber === "number" ||
          (typeof (n as CenterNotification).agentKind === "string" &&
            typeof (n as CenterNotification).sessionId === "string" &&
            typeof (n as CenterNotification).reportTargetSessionId === "string")) &&
        typeof (n as CenterNotification).title === "string" &&
        typeof (n as CenterNotification).at === "string" &&
        typeof (n as CenterNotification).read === "boolean",
    );
  } catch {
    return [];
  }
}

/** Persists notifications; storage failures (private mode, quota) are non-fatal. */
function saveNotifications(list: CenterNotification[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Unpersisted history is acceptable — the bell just resets next reload.
  }
}

let state: CenterNotification[] = loadNotifications();
const listeners = new Set<() => void>();

function setState(list: CenterNotification[]): void {
  state = list;
  saveNotifications(list);
  for (const listener of listeners) listener();
}

/**
 * App-wide notification history store: the bell badge and the dropdown
 * subscribe via `useSyncExternalStore`; the center records daemon events
 * through `record()`. Plain closures — no class machinery needed.
 */
export const notificationStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState(): CenterNotification[] {
    return state;
  },
  /** Records one daemon notification event into the history. */
  record(event: NotificationEvent): void {
    setState(appendNotification(state, event));
  },
  markRead(key: string): void {
    setState(markNotificationRead(state, key));
  },
  clear(key: string): void {
    setState(clearNotification(state, key));
  },
  clearAll(): void {
    setState(clearAllNotifications());
  },
};
