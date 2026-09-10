import type { UpdatingState } from "./UpdateBanner";
import { formatElapsed, updatingText } from "./UpdateBanner";
import { Modal } from "./Modal";
import { RECOVERY_HINT_MS } from "./update-polling";

/**
 * Full-screen update-apply modal (issue #113): while a banner-initiated
 * apply runs, the updating-with-timer state is a modal over the dimmed
 * application instead of a strip above it — the update is app-wide (the
 * daemon restarts under it), so the presentation matches the scope.
 *
 * The backdrop greys the app out; the card carries "Updating…", the target
 * short SHA, an honest elapsed clock, the shim's live stage, and the #95
 * recovery hint once the daemon has been down past its threshold. When the
 * daemon returns with the new build, the same overlay announces
 * "Update complete" for a beat; the page reloads (scheduling lives in the
 * banner) and the modal — and the whole page — is replaced by the new
 * build. Pure view: effects and polling live in the banner wrapper.
 *
 * Both states are status overlays, not dialogs (issue #113): nothing is
 * dismissible — the apply runs app-wide and the page reloads under the
 * completion card — so they render through {@link Modal}'s `status` mode
 * (role="status", no close button, no Esc/focus handling). The completion
 * beat keeps its bare `.update-modal-overlay` div: it predates the shell's
 * `.modal-overlay` chrome and adding it would change the visuals (#396 kept
 * the appearance frozen).
 */

export interface UpdateApplyModalProps {
  /** Live apply state while the daemon rebuilds. */
  updating: UpdatingState | null;
  /** Apply resolved — the overlay says "Update complete", then the page reloads. */
  reloading: boolean;
}

export function UpdateApplyModal({ updating, reloading }: UpdateApplyModalProps) {
  if (reloading) {
    return (
      <div className="update-modal-overlay" role="status" aria-live="assertive">
        <div className="modal-card update-modal">
          <h2 className="modal-title">Update complete</h2>
          <p className="update-modal-detail">Reloading into the new build&hellip;</p>
        </div>
      </div>
    );
  }
  if (updating === null) return null;
  return (
    <Modal status overlayClassName="update-modal-overlay" cardClassName="update-modal">
      <h2 className="modal-title">Updating PiDeck&hellip;</h2>
      <p className="update-modal-detail">
        Moving to <code>{updating.targetSha.slice(0, 7)}</code>
      </p>
      <p className="update-modal-elapsed">
        <strong>{formatElapsed(updating.elapsedMs)}</strong> elapsed — {updatingText(updating.stage, updating.apiUp)}.
      </p>
      {updating.downMs > RECOVERY_HINT_MS && (
        <p className="update-banner-hint">
          Still waiting — if the site doesn't recover within a few minutes, run <code>pideck update</code> in a
          terminal or check <code>pideck service status</code>.
        </p>
      )}
    </Modal>
  );
}
