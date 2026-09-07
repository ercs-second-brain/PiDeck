import { useEffect, useState } from "react";
import type { UpdateStatus } from "@agentskiss/shared";
import { apiGetUpdateStatus, errorMessage } from "../lib/api";

/**
 * Self-update banner (issue #55): shown across pages when the daemon's
 * update check reports a newer upstream revision. Deliberately silent when
 * the install is up to date (or the check failed — the CLI reports that
 * loudly; the webapp just stays quiet).
 *
 * Applying the update restarts the daemon, so it is a CLI/service action
 * (`agentskiss update`); the banner points there instead of offering a
 * button that would kill the server answering it.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiGetUpdateStatus()
      .then((result) => {
        if (alive) setStatus(result);
      })
      .catch((err: unknown) => {
        if (alive) setFailed(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failed !== null) return null;
  return <UpdateBannerView status={status} />;
}

/**
 * Pure view for the fetched status (`null` while loading) — kept separate so
 * tests can exercise the rendering without React effects/fetch.
 */
export function UpdateBannerView({ status }: { status: UpdateStatus | null }) {
  if (status === null || !status.updateAvailable || status.remoteSha === null) return null;

  return (
    <div className="update-banner" role="status">
      Update available — new version <code>{status.remoteSha.slice(0, 7)}</code> on{" "}
      <code>{`${status.repo}@${status.ref}`}</code>. Run <code>agentskiss update</code> to apply.
    </div>
  );
}
