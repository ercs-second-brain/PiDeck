import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionView, UpdateCheck } from "@pideck/shared";
import { api, ApiError } from "../lib/api";
import "./update.css";

const SESSION_POLL_MS = 30_000;
const STATUS_POLL_MS = 2_000;
/** Give the restarting daemon this long before declaring it stuck. */
const DOWN_LIMIT_MS = 60_000;
/** Same-version answers for this long also count as stuck. */
const SAME_VERSION_LIMIT_MS = 90_000;

type Phase = "available" | "updating" | "stuck";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isLiveAgent(view: SessionView): boolean {
  return (
    view.session.archivedAt === undefined &&
    (view.session.persona === "worker" || view.session.persona === "reviewer")
  );
}

/**
 * The header update pill. Renders nothing until the daemon reports an
 * update; clicking applies it via the daemon (blocked with a hint while
 * workers or reviewers are live) and then polls /api/status until the
 * daemon answers with its new version, with a recovery hint if it stays
 * down or never reports a change.
 */
export function UpdateBanner() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [agentsLive, setAgentsLive] = useState(false);
  const [phase, setPhase] = useState<Phase>("available");
  const [hint, setHint] = useState<string | null>(null);

  const activeRef = useRef(true);
  const versionRef = useRef<string | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    api("updateCheck")
      .then((result) => {
        if (mounted && result.updateAvailable) setCheck(result);
      })
      .catch(() => {});
    return () => {
      mounted = false;
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
    if (check === null || phase !== "available") return;
    void refreshAgents();
    const timer = setInterval(() => void refreshAgents(), SESSION_POLL_MS);
    return () => clearInterval(timer);
  }, [check, phase, refreshAgents]);

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

  const start = useCallback(async () => {
    setHint("fetching, rebuilding and restarting…");
    setPhase("updating");
    try {
      versionRef.current = (await api("status")).version;
      await api("updateApply");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setAgentsLive(true);
        setHint("agents are live — the update waits until they finish");
      } else {
        setHint("update failed — see `pideck logs`");
      }
      setPhase("available");
      return;
    }
    void watchRestart(Date.now());
  }, [watchRestart]);

  if (check === null || !check.updateAvailable) return null;

  const stuck = phase === "stuck";
  return (
    <div className="update">
      <button
        type="button"
        className={`update__pill${stuck ? " update__pill--stuck" : ""}`}
        title={stuck ? "Reload PiDeck" : `Update to ${check.latestVersion}`}
        disabled={phase === "updating" || (phase === "available" && agentsLive)}
        onClick={() => (stuck ? window.location.reload() : void start())}
      >
        {phase === "updating" ? "Updating…" : stuck ? "Reload" : "Update"}
      </button>
      {hint !== null && (
        <span className="update__hint" title={hint}>
          {hint}
        </span>
      )}
    </div>
  );
}
