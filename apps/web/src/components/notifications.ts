/**
 * Notification history (issue #178): the durable counterpart to the
 * ephemeral toasts (#111). Every notification event the daemon fans out
 * over the websocket is recorded here and persisted to localStorage, so
 * the bell dropdown survives reloads while keeping toasts as the live
 * popup surface. Deliberately simple: one flat list, newest first,
 * deduped by event key, capped.
 */

import type { NotificationEvent } from "@pideck/shared";
import { toastKey } from "./Toasts";

/** One persisted notification (today: merged PRs; the union grows later). */
export interface CenterNotification {
  /** Stable dedupe key (`<projectId>#<prNumber>`), shared with toasts. */
  key: string;
  projectId: string;
  prNumber: number;
  /** PR title at merge time. */
  title: string;
  /** Event timestamp (ISO), shown in the dropdown. */
  at: string;
  /** False until the user clicks the item in the dropdown. */
  read: boolean;
}

/** Maximum stored notifications; the oldest drop off. */
export const MAX_NOTIFICATIONS = 50;

const STORAGE_KEY = "pideck.notifications.v1";

/** Appends an event as an unread notification, deduped and newest-first — pure. */
export function appendNotification(list: CenterNotification[], event: NotificationEvent): CenterNotification[] {
  const key = toastKey(event.projectId, event.prNumber);
  if (list.some((n) => n.key === key)) return list;
  const next = [{ key, projectId: event.projectId, prNumber: event.prNumber, title: event.title, at: event.at, read: false }, ...list];
  return next.slice(0, MAX_NOTIFICATIONS);
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
        typeof (n as CenterNotification).prNumber === "number" &&
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
