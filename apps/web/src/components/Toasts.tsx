import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationEvent, Project } from "@pideck/shared";
import { apiGetSettings } from "../lib/api";
import { boardStore, useAppState } from "../store/store";

/** How long a toast stays up before auto-dismissing. */
const TOAST_MS = 6_000;
/** Maximum simultaneous toasts; the oldest drop off. */
export const MAX_TOASTS = 4;

/**
 * One merged-PR toast (issue #111). agent-orchestrator surfaces `pr_merged`
 * as a notification that is never held as unresolved — a terminal fact,
 * shown once. Mirrored here: toasts are ephemeral (no history, no ack), the
 * board's `done` card carries the durable state.
 */
export interface MergedPRToast {
  /** Stable key (`<projectId>#<prNumber>`) — dedupes re-emissions. */
  key: string;
  projectId: string;
  prNumber: number;
  title: string;
}

/** Stable dedupe key for a merged-PR event/toast. */
export function toastKey(projectId: string, prNumber: number): string {
  return `${projectId}#${prNumber}`;
}

/** Toast headline ("kisstest #42 merged"); project name when known. */
export function toastText(projectName: string | undefined, toast: MergedPRToast): string {
  return `${projectName ?? toast.projectId} #${toast.prNumber} merged`;
}

/** Appends an event as a toast, deduped by key and bounded — pure. */
export function appendToast(toasts: MergedPRToast[], event: NotificationEvent): MergedPRToast[] {
  const key = toastKey(event.projectId, event.prNumber);
  if (toasts.some((t) => t.key === key)) return toasts;
  const next = [...toasts, { key, projectId: event.projectId, prNumber: event.prNumber, title: event.title }];
  return next.slice(-MAX_TOASTS);
}

export interface ToastStackProps {
  toasts: MergedPRToast[];
  projects: Project[];
  onDismiss: (key: string) => void;
}

/**
 * Pure toast view: a bottom-right stack, one row per merged PR ("kisstest
 * #42 merged" + the PR title). Clicking a toast dismisses it; timers live
 * in the wrapper. agent-orchestrator deliberately never suppresses PR
 * outcomes for the visible session ("not visible in the terminal pane") —
 * same reasoning: a merge shows up as a toast even while the worker's pane
 * is on screen.
 */
export function ToastStack({ toasts, projects, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.key}
          type="button"
          className="toast"
          title="Dismiss"
          onClick={() => onDismiss(toast.key)}
        >
          <strong>{toastText(projects.find((p) => p.id === toast.projectId)?.name, toast)}</strong>
          <span className="toast-title">{toast.title}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Merged-PR toast surface (issue #111), mounted from main.tsx next to the
 * router — deliberately not inside App.tsx, so it survives route churn and
 * needs no router context. Subscribes to the store's notification fan-out;
 * when the daemon-side toggle (`browserMergeNotifications`, default OFF)
 * is enabled and the browser granted permission, each merge additionally
 * fires a browser Notification.
 */
export function Toasts() {
  const [toasts, setToasts] = useState<MergedPRToast[]>([]);
  const { projects } = useAppState();
  /** Latest `browserMergeNotifications` setting; a ref so focus refreshes don't rerender. */
  const browserNotifyRef = useRef(false);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((key: string): void => {
    const timer = timers.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(key);
    }
    setToasts((current) => current.filter((t) => t.key !== key));
  }, []);

  useEffect(() => {
    const load = (): void => {
      apiGetSettings()
        .then((settings) => {
          browserNotifyRef.current = settings.browserMergeNotifications;
        })
        .catch(() => {}); // a failed fetch keeps the last known preference
    };
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return boardStore.onNotification((event) => {
      const key = toastKey(event.projectId, event.prNumber);
      setToasts((current) => appendToast(current, event));
      if (!pending.has(key)) {
        pending.set(
          key,
          window.setTimeout(() => dismiss(key), TOAST_MS),
        );
      }
      maybeBrowserNotify(event, browserNotifyRef.current);
    });
    // Unmount: clear every pending timer (StrictMode remount included).
  }, [dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return <ToastStack toasts={toasts} projects={projects} onDismiss={dismiss} />;
}

/** Fires the OS-level notification when the opt-in is on and permitted. */
function maybeBrowserNotify(event: NotificationEvent, enabled: boolean): void {
  if (!enabled || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const project = boardStore.getState().projects.find((p) => p.id === event.projectId);
  try {
    new Notification(`${project?.name ?? event.projectId} #${event.prNumber} merged`, { body: event.title });
  } catch {
    // Some environments throw on construction despite the permission check.
  }
}
