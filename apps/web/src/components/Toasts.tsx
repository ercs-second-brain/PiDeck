import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentKind, NotificationEvent, Project } from "@pideck/shared";
import { apiGetSettings } from "../lib/api";
import { boardStore, useAppState } from "../store/store";

/** How long a toast stays up before auto-dismissing. */
const TOAST_MS = 6_000;
/** Maximum simultaneous toasts; the oldest drop off. */
export const MAX_TOASTS = 4;

/**
 * One PR-lifecycle toast (issues #111/#408): a PR merged, or a green +
 * approved PR is ready for merge. agent-orchestrator surfaces these as
 * notifications that are never held as unresolved — terminal facts, shown
 * once. Mirrored here: toasts are ephemeral (no history, no ack), the
 * board's card carries the durable state.
 */
export interface MergedPRToast {
  /** Stable key — dedupes re-emissions; the kind keeps merged/ready keys apart. */
  key: string;
  projectId: string;
  prNumber: number;
  /** Which PR lifecycle fact: `merged` (#111) or `ready_for_merge` (#408). */
  kind: "merged" | "ready_for_merge";
  title: string;
}

/**
 * One agent-report toast (docs/agent-kinds.md, issues #300/#302): an audit
 * kind (devex-audit, kiss-audit) finished and delivered its report to the
 * project orchestrator. Same ephemeral contract as the merged-PR toast.
 */
export interface AgentReportToast {
  key: string;
  projectId: string;
  agentKind: AgentKind;
  title: string;
}

/** Any toast the stack renders. */
export type AppToast = MergedPRToast | AgentReportToast;

/** Whether the event is a PR-lifecycle notification (merged #111, ready-for-merge #408). */
export function isPrNotification(event: NotificationEvent): event is Extract<NotificationEvent, { type: "notification.pr.merged" | "notification.pr.ready_for_merge" }> {
  return event.type === "notification.pr.merged" || event.type === "notification.pr.ready_for_merge";
}

/** Stable dedupe key for a merged-PR event/toast (kind-suffixed since #408). */
export function toastKey(projectId: string, prNumber: number, kind: "merged" | "ready_for_merge" = "merged"): string {
  return kind === "merged" ? `${projectId}#${prNumber}` : `ready:${projectId}#${prNumber}`;
}

/** Stable dedupe key for any notification event (toasts + the center record path). */
function eventKey(event: NotificationEvent): string {
  return isPrNotification(event)
    ? toastKey(event.projectId, event.prNumber, event.type === "notification.pr.merged" ? "merged" : "ready_for_merge")
    : `agent:${event.projectId}:${event.sessionId}`;
}

/** Toast headline: "kisstest #42 merged" / "kisstest #42 ready for merge"; project name when known. */
export function toastText(projectName: string | undefined, toast: MergedPRToast | AgentReportToast): string {
  const project = projectName ?? toast.projectId;
  if ("prNumber" in toast) return toast.kind === "ready_for_merge" ? `${project} #${toast.prNumber} ready for merge` : `${project} #${toast.prNumber} merged`;
  return `${project} ${toast.agentKind} report ready`;
}

/** Appends an event as a toast, deduped by key and bounded — pure. */
export function appendToast(toasts: AppToast[], event: NotificationEvent): AppToast[] {
  const key = eventKey(event);
  if (toasts.some((t) => t.key === key)) return toasts;
  const base = { key, projectId: event.projectId, title: event.title };
  const next = isPrNotification(event)
    ? { ...base, prNumber: event.prNumber, kind: event.type === "notification.pr.merged" ? ("merged" as const) : ("ready_for_merge" as const) }
    : { ...base, agentKind: event.agentKind };
  return [...toasts, next].slice(-MAX_TOASTS);
}

export interface ToastStackProps {
  toasts: AppToast[];
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
  const [toasts, setToasts] = useState<AppToast[]>([]);
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
      const key = eventKey(event);
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
  const name = project?.name ?? event.projectId;
  const headline = isPrNotification(event)
    ? event.type === "notification.pr.ready_for_merge"
      ? `${name} #${event.prNumber} ready for merge`
      : `${name} #${event.prNumber} merged`
    : `${name} ${event.agentKind} report ready`;
  try {
    new Notification(headline, { body: event.title });
  } catch {
    // Some environments throw on construction despite the permission check.
  }
}
