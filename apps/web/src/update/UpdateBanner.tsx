import { useEffect, useState } from "react";
import type { UpdateCheck } from "@pideck/shared";
import { api } from "../lib/api";
import { updateActionLabel, updateButtonLabel, useUpdateApply } from "./use-update-apply";
import "./update.css";

/** How often the pill re-checks for a newly available update. */
const CHECK_POLL_MS = 10 * 60 * 1000;

type CheckEndpoint = "updateCheck" | "updateCheckNow";

/**
 * The header update pill. Renders nothing while the check says up to date;
 * on mount from the cached check, then periodically from an explicit fresh
 * check so a newly available update — or a daemon that is stale while its
 * checkout is current — appears without a reload. Clicking applies it via
 * the shared apply hook: an update through `pideck update`, a restart-needed
 * state through the same apply path (the daemon restarts the service).
 */
export function UpdateBanner() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const apply = useUpdateApply(check?.state ?? null);

  useEffect(() => {
    let mounted = true;
    const checkForUpdate = (name: CheckEndpoint) =>
      api(name)
        .then((result) => {
          if (mounted) setCheck(result);
        })
        .catch(() => {});
    void checkForUpdate("updateCheck");
    const timer = setInterval(() => void checkForUpdate("updateCheckNow"), CHECK_POLL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  if (check === null || !apply.actionable) return null;

  const restart = check.state === "restartNeeded";
  const stuck = apply.phase === "stuck";
  return (
    <div className="update">
      <button
        type="button"
        className={`update__pill${stuck ? " update__pill--stuck" : ""}`}
        title={
          stuck
            ? "Reload PiDeck"
            : restart
              ? `Restart to run ${check.latestVersion}`
              : `Update to ${check.latestVersion}`
        }
        disabled={apply.phase === "updating" || (apply.phase === "idle" && apply.agentsLive)}
        onClick={() => (stuck ? apply.reload() : void apply.apply())}
      >
        {updateButtonLabel(apply.phase, updateActionLabel(check.state))}
      </button>
      {apply.hint !== null && (
        <span className="update__hint" title={apply.hint}>
          {apply.hint}
        </span>
      )}
    </div>
  );
}
