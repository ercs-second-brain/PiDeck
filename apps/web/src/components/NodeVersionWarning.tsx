import { useEffect, useState } from "react";
import { apiGetNodeStatus, type NodeStatus } from "../lib/api";

/**
 * Warning strip for a daemon booted on a Node too old for pi (issue: pi's
 * vendored undici requests zstd-encoded responses and decodes them with
 * `zlib.createZstdDecompress`, which only exists on Node >= 22.15 — on an
 * older node every pi session crashes on the first provider response
 * instead of working). The daemon reports its effective runtime
 * (`nodeVersion`/`nodeTooOld`) on /api/status and warns in its own log at
 * startup; this surface makes the same condition visible in the webapp
 * rather than a mystery error inside every worker. Quiet when the runtime
 * is fine; a fetch failure stays quiet too (an unreachable daemon already
 * has its own error state in the app shell).
 */
export function NodeVersionWarning() {
  const [node, setNode] = useState<NodeStatus | null>(null);
  useEffect(() => {
    let alive = true;
    apiGetNodeStatus()
      .then((status) => {
        if (alive) setNode(status);
      })
      .catch(() => {}); // daemon unreachable — its own error surface covers it
    return () => {
      alive = false;
    };
  }, []);
  if (node === null || !node.nodeTooOld) return null;
  return <NodeTooOldStrip nodeVersion={node.nodeVersion} />;
}

/** Pure view for the too-old strip — kept separate for direct test rendering. */
export function NodeTooOldStrip({ nodeVersion }: { nodeVersion: string }) {
  return (
    <div className="update-banner" role="alert">
      <span className="update-banner-error">
        PiDeck&rsquo;s daemon runs on Node {nodeVersion}, which is too old for the pi agent — pi sessions will
        crash on first use. Run <code>pideck update</code> to refresh the private Node runtime.
      </span>
    </div>
  );
}
