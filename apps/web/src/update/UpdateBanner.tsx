import { useEffect, useState } from "react";
import type { UpdateCheck } from "@pideck/shared";
import { api } from "../lib/api";
import { updateButtonLabel, useUpdateApply } from "./use-update-apply";
import "./update.css";

/** How often the pill re-checks for a newly available update. */
const CHECK_POLL_MS = 10 * 60 * 1000;

type CheckEndpoint = "updateCheck" | "updateCheckNow";

/**
 * The header update pill. Renders nothing until the daemon reports an
 * update — on mount from the cached check, then periodically from an
 * explicit fresh check so a newly available update appears without a
 * reload. Clicking applies it via the shared apply hook.
 */
export function UpdateBanner() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const apply = useUpdateApply(check?.updateAvailable === true);

  useEffect(() => {
    let mounted = true;
    const checkForUpdate = (name: CheckEndpoint) =>
      api(name)
        .then((result) => {
          if (mounted && result.updateAvailable) setCheck(result);
        })
        .catch(() => {});
    void checkForUpdate("updateCheck");
    const timer = setInterval(() => void checkForUpdate("updateCheckNow"), CHECK_POLL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  if (check === null || !check.updateAvailable) return null;

  const stuck = apply.phase === "stuck";
  return (
    <div className="update">
      <button
        type="button"
        className={`update__pill${stuck ? " update__pill--stuck" : ""}`}
        title={stuck ? "Reload PiDeck" : `Update to ${check.latestVersion}`}
        disabled={apply.phase === "updating" || (apply.phase === "idle" && apply.agentsLive)}
        onClick={() => (stuck ? apply.reload() : void apply.apply())}
      >
        {updateButtonLabel(apply.phase, "Update")}
      </button>
      {apply.hint !== null && (
        <span className="update__hint" title={apply.hint}>
          {apply.hint}
        </span>
      )}
    </div>
  );
}