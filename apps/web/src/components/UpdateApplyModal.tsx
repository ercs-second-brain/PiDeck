import type { UpdatingState } from "./UpdateBanner";
import { formatElapsed, updatingText } from "./UpdateBanner";
import { Modal } from "./Modal";
import { RECOVERY_HINT_MS } from "./update-polling";

/**
 * Full-screen update-apply modal (issue #113): while a banner-initiated
 * apply runs, the updating state is a modal over the dimmed application —
 * the update is app-wide (the daemon restarts under it), so the
 * presentation matches the scope.
 *
 * Issue #450 redesign: deliberately bare — a spinner and two plain text
 * lines (what is happening, the shim's live stage, and the elapsed time).
 * No title, no decorated SHA, no bold clock. The states that must stay
 * informative stay: the daemon-restarting text when the API is unreachable,
 * and the #95 recovery hint once the daemon has been down past its
 * threshold. There is no completion state — when the apply resolves, the
 * page reloads straight into the new build (issue #450, user decision: the
 * post-update message "can just go away").
 *
 * Status overlay, not a dialog (issue #113): nothing is dismissible — the
 * apply runs app-wide and the page reloads under it — so it renders through
 * {@link Modal}'s `status` mode (role="status", no close button, no
 * Esc/focus handling). Pure view: effects and polling live in the banner
 * wrapper.
 */

export interface UpdateApplyModalProps {
  /** Live apply state while the daemon rebuilds. */
  updating: UpdatingState;
}

export function UpdateApplyModal({ updating }: UpdateApplyModalProps) {
  return (
    <Modal status overlayClassName="update-modal-overlay" cardClassName="update-modal">
      <span className="update-modal-spinner" aria-hidden="true" />
      <p className="update-modal-line">Updating PiDeck to {updating.targetSha.slice(0, 7)}&hellip;</p>
      <p className="update-modal-line">
        {updatingText(updating.stage, updating.apiUp)} — {formatElapsed(updating.elapsedMs)} elapsed.
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
