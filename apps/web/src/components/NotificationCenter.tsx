import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import type { Project } from "@pideck/shared";
import { boardStore } from "../store/store";
import {
  notificationStore,
  type CenterNotification,
} from "./notifications";
import { toastText } from "./Toasts";

/**
 * Notification center (issue #178): a header bell with an unread badge
 * opening a dropdown of the persisted notification history — the durable
 * counterpart to the ephemeral toasts (#111), which stay the live popup
 * surface. Items click through to the PR diff (merged PRs keep their diff
 * page), clear individually, or clear all at once.
 */

/** Human timestamp for a notification: today shows the time, older the date. */
export function notificationTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return at.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Where a notification click-through lands: the PR's diff page. */
export function notificationTarget(n: CenterNotification): string {
  return `/projects/${n.projectId}/pulls/${n.prNumber}`;
}

// --- Notification permission (issue #180) ----------------------------------

/** Platform permission state, collapsing the missing-API case (iOS in-browser). */
export type PermissionState = "unsupported" | "default" | "granted" | "denied";

function toPermissionState(permission: string): PermissionState {
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
}

/**
 * Current Notification permission state. "unsupported" covers iOS Safari
 * without the home-screen PWA install (no `Notification` API there) —
 * notifications stay in-app on those platforms (docs/pwa.md).
 */
export function permissionState(): PermissionState {
  if (typeof Notification === "undefined") return "unsupported";
  return toPermissionState(Notification.permission);
}

/**
 * Requests Notification permission (issue #180). Call from a user gesture;
 * resolves to the resulting state, never throws. A no-op when not in the
 * "default" state.
 */
export async function requestNotificationPermission(): Promise<PermissionState> {
  if (permissionState() !== "default") return permissionState();
  try {
    return toPermissionState(await Notification.requestPermission());
  } catch {
    return "denied";
  }
}

export interface PermissionRequestProps {
  state: PermissionState;
  onEnable: () => void;
}

/**
 * Pure panel footer: the enable button only when the platform supports the
 * API and the user has not decided yet ("default"). After granting, browser
 * notifications still require the daemon-side `browserMergeNotifications`
 * toggle (Settings, issue #111) — hence the hint.
 */
export function PermissionRequest({ state, onEnable }: PermissionRequestProps) {
  if (state !== "default") return null;
  return (
    <div className="notif-perm">
      <button type="button" className="notif-perm-enable" onClick={onEnable}>
        Enable browser notifications
      </button>
      <span className="notif-perm-hint">then turn on the merge toggle in Settings — in-app only on iOS</span>
    </div>
  );
}

export interface NotificationListProps {
  notifications: CenterNotification[];
  projects: Project[];
  onOpen: (n: CenterNotification) => void;
  onClear: (key: string) => void;
}

/** Pure dropdown content: one row per notification, newest first. */
export function NotificationList({ notifications, projects, onOpen, onClear }: NotificationListProps) {
  if (notifications.length === 0) {
    return <p className="notif-empty">No notifications yet.</p>;
  }
  return (
    <ul className="notif-list">
      {notifications.map((n) => {
        const project = projects.find((p) => p.id === n.projectId);
        return (
          <li key={n.key} className={`notif-item${n.read ? "" : " unread"}`}>
            <button type="button" className="notif-open" onClick={() => onOpen(n)}>
              <strong>{toastText(project?.name ?? project?.id, { key: n.key, projectId: n.projectId, prNumber: n.prNumber, title: n.title })}</strong>
              <span className="notif-title">{n.title}</span>
              <span className="notif-time">{notificationTime(n.at)}</span>
            </button>
            <button type="button" className="notif-clear" aria-label="Clear notification" title="Clear" onClick={() => onClear(n.key)}>
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The header bell + dropdown. Records daemon notification events into the
 * persisted history while mounted (always: it lives in the app header).
 */
export function NotificationBell() {
  const navigate = useNavigate();
  const notifications = useSyncExternalStore(notificationStore.subscribe, notificationStore.getState);
  const { projects } = useAppStateProjects();
  const [open, setOpen] = useState(false);
  // Re-read when the panel opens (the user may flip OS permissions meanwhile).
  const [permission, setPermission] = useState<PermissionState>(() => permissionState());
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Record daemon events into the persisted history (#178).
  useEffect(
    () => boardStore.onNotification((event) => notificationStore.record(event)),
    [],
  );

  // Close on Escape or an outside click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const unread = notifications.filter((n) => !n.read).length;

  const open_ = (n: CenterNotification): void => {
    notificationStore.markRead(n.key);
    setOpen(false);
    navigate(notificationTarget(n));
  };

  return (
    <div className="notif-root" ref={rootRef}>
      <button
        type="button"
        className="notif-bell"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        title="Notifications"
        aria-expanded={open}
        onClick={() => {
          setPermission(permissionState());
          setOpen((o) => !o);
        }}
      >
        🔔
        {unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-panel-head">
            <span>Notifications</span>
            <button type="button" className="notif-clear-all" onClick={() => notificationStore.clearAll()} disabled={notifications.length === 0}>
              Clear all
            </button>
          </div>
          <NotificationList
            notifications={notifications}
            projects={projects}
            onOpen={open_}
            onClear={(key) => notificationStore.clear(key)}
          />
          <PermissionRequest
            state={permission}
            onEnable={() => {
              void requestNotificationPermission().then(setPermission);
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Projects slice of the app store (names for the notification rows). */
function useAppStateProjects(): { projects: Project[] } {
  const projects = useSyncExternalStore(
    boardStore.subscribe,
    () => boardStore.getState().projects,
  );
  return { projects };
}
