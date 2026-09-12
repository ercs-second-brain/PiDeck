/**
 * The apply half of the update flow, shared by the header pill and the
 * settings page's inline update button: the workers/reviewers-live gate,
 * applying via the daemon, and the restart watch that polls /api/status
 * until the daemon answers with its new version — with recovery hints when
 * it stays down or never reports a change.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionView, UpdateState } from "@pideck/shared";
import { api, ApiError } from "../lib/api";

const SESSION_POLL_MS = 30_000;
const STATUS_POLL_MS = 2_000;
/** Give the restarting daemon this long before declaring it stuck. */
const DOWN_LIMIT_MS = 60_000;
/** Same-version answers for this long also count as stuck. */
const SAME_VERSION_LIMIT_MS = 90_000;

export const AGENTS_LIVE_HINT = "agents are live — the update waits until they finish";

export type UpdatePhase = "idle" | "updating" | "stuck";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isLiveAgent(view: SessionView): boolean {
  return (
    view.session.archivedAt === undefined &&
    (view.session.persona === "worker" || view.session.persona === "reviewer")
  );
}

/** Button label for an update control: busy, the stuck reload path, or the idle label. */
export function updateButtonLabel(phase: UpdatePhase, idle: string): string {
  if (phase === "updating") return "Updating…";
  if (phase === "stuck") return "Reload";
  return idle;
}

/** Idle label for the actionable state: a stale daemon restarts, the rest update. */
export function updateActionLabel(state: UpdateState): string {
  return state === "restartNeeded" ? "Restart" : "Update";
}

export interface UpdateApply {
  /** The check's state this hook was given; null before the first check. */
  state: UpdateState | null;
  /** An update or a restart is actionable right now. */
  actionable: boolean;
  /** Workers or reviewers are live; the daemon refuses the apply until they finish. */
  agentsLive: boolean;
  phase: UpdatePhase;
  hint: string | null;
  apply: () => Promise<void>;
  reload: () => void;
}

export function useUpdateApply(state: UpdateState | null): UpdateApply {
  const actionable = state !== null && state !== "upToDate";
  const [agentsLive, setAgentsLive] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [hint, setHint] = useState<string | null>(null);

  const activeRef = useRef(true);
  const versionRef = useRef<string | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      const views = await api("sessionList");
      setAgentsLive(views.some(isLiveAgent));
    } catch {
      // The daemon is mid-restart or briefly unreachable; keep the last verdict.
    }
  }, []);

  useEffect(() => {
    if (!actionable || phase !== "idle") return;
    void refreshAgents();
    const timer = setInterval(() => void refreshAgents(), SESSION_POLL_MS);
    return () => clearInterval(timer);
  }, [actionable, phase, refreshAgents]);

  /** Polls /api/status until the daemon answers with its new version. */
  const watchRestart = useCallback(async (startedAt: number): Promise<void> => {
    for (;;) {
      await sleep(STATUS_POLL_MS);
      if (!activeRef.current) return;
      const elapsed = Date.now() - startedAt;
      let version: string | null = null;
      try {
        version = (await api("status")).version;
      } catch {
        if (elapsed >= DOWN_LIMIT_MS) {
          setHint("the daemon has been down since the update — check `pideck logs`, then reload");
          setPhase("stuck");
          return;
        }
        continue;
      }
      if (versionRef.current !== null && version !== versionRef.current) {
        window.location.reload();
        return;
      }
      if (elapsed >= SAME_VERSION_LIMIT_MS) {
        setHint("the daemon is back but reports the old version — reload to re-check");
        setPhase("stuck");
        return;
      }
    }
  }, []);

  const apply = useCallback(async () => {
    setHint(
      state === "restartNeeded"
        ? "restarting the service…"
        : "fetching, rebuilding and restarting…",
    );
    setPhase("updating");
    try {
      versionRef.current = (await api("status")).version;
      await api("updateApply");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setAgentsLive(true);
        setHint(AGENTS_LIVE_HINT);
      } else {
        setHint("update failed — see `pideck logs`");
      }
      setPhase("idle");
      return;
    }
    void watchRestart(Date.now());
  }, [state, watchRestart]);

  const reload = useCallback(() => window.location.reload(), []);

  const shownHint = hint ?? (phase === "idle" && agentsLive ? AGENTS_LIVE_HINT : null);
  return { state, actionable, agentsLive, phase, hint: shownHint, apply, reload };
}