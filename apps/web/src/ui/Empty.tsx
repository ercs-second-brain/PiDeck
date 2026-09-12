import type { ReactNode } from "react";
import "./empty.css";

/**
 * Dim one-liner with an optional CTA button, centred in its pane.
 */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__text">{children}</div>
      {action !== undefined && <div className="empty__action">{action}</div>}
    </div>
  );
}
