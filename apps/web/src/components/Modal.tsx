/**
 * The shared modal shell (issue #396, KISS audit F11): one component renders
 * the `.modal-overlay`/`.modal-card` chrome every web modal used to
 * hand-copy, and owns the dialog behaviors once — Esc-to-close, backdrop
 * click, the focus trap, and focus return on close (none of which the
 * hand-copies had). Call sites keep their chrome variant classes via
 * `overlayClassName`/`cardClassName`, so the #390 styling holds unchanged;
 * everything inside the card stays call-site content.
 */

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

/** Elements Tab may move focus through (disabled controls cannot take focus). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** The dialog's accessible name (aria-label). Status overlays render without one. */
  label?: string;
  /**
   * Dismiss handler. Its presence makes the modal a dialog: close button,
   * Esc-to-close, backdrop click, and focus handling. Only the
   * non-interactive status overlays (the update-apply modal) omit it.
   */
  onClose?: () => void;
  /** The close button's aria-label; defaults to `Close <label>`. */
  closeLabel?: string;
  /** Extra overlay classes — the call-site chrome variants (asset-dialog-overlay, …). */
  overlayClassName?: string;
  /** Extra card classes — the call-site chrome variants (agent-assets-modal, …). */
  cardClassName?: string;
  /** Render the `×` close button (default true; the picker confirm modals have Cancel instead). */
  closeButton?: boolean;
  /** False blocks Esc and backdrop dismissal (a confirm request is in flight). Default true. */
  canClose?: boolean;
  /** Status-overlay mode (the update-apply modal): role="status" + aria-live, no dialog behavior. */
  status?: boolean;
  children: ReactNode;
}

/** The overlay element's dialog-vs-status semantics (the two modal kinds). */
function overlayAria(props: ModalProps): {
  role: "dialog" | "status";
  "aria-modal"?: "true";
  "aria-label"?: string;
  "aria-live"?: "assertive";
} {
  if (props.status === true) return { role: "status", "aria-live": "assertive" };
  return { role: "dialog", "aria-modal": "true", "aria-label": props.label };
}

/** Backdrop-click dismissal (backdrop clicks only — clicks in the card stay). */
function backdropHandler(props: ModalProps): ((event: React.MouseEvent) => void) | undefined {
  const { onClose, canClose = true } = props;
  if (onClose === undefined || canClose === false) return undefined;
  return (event) => {
    if (event.target === event.currentTarget) onClose();
  };
}

/** Keyboard handling inside the dialog: Esc dismisses, Tab is trapped. */
function dialogKeyDown(cardRef: React.RefObject<HTMLDivElement | null>, onClose: () => void, canClose: boolean) {
  return (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      if (!canClose) return;
      // Stop at the innermost open dialog: a nested dialog (AssetDialog over
      // the agent-assets modal) closes alone, not together with its host.
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") trapTab(event, cardRef.current);
  };
}

/** Keep Tab cycling inside the dialog: from the last control wrap to the first, and back. */
function trapTab(event: KeyboardEvent<HTMLDivElement>, card: HTMLDivElement | null): void {
  const focusable = card?.querySelectorAll<HTMLElement>(FOCUSABLE);
  const first = focusable?.item(0);
  const last = focusable?.item(focusable.length - 1);
  if (first == null || last == null) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function Modal(props: ModalProps) {
  const { onClose, closeLabel, overlayClassName, cardClassName, closeButton = true, status = false } = props;
  const cardRef = useRef<HTMLDivElement>(null);
  // A status overlay is not a dialog: no dismissal, no focus management.
  const dialog = onClose !== undefined && status === false;

  // Focus, once per open: remember where the user was, move focus into the
  // dialog (its first focusable control, else the card), and give it back on
  // close. Skipped when focus already sits inside (an autoFocus field).
  useEffect(() => {
    if (!dialog) return;
    const card = cardRef.current;
    if (card === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (previous === null || !card.contains(previous)) {
      (card.querySelector<HTMLElement>(FOCUSABLE) ?? card).focus();
    }
    return () => previous?.focus();
    // Open/close only: the handlers below read props from the fresh render
    // closures; re-running this effect per render would yank focus back to
    // the first control on every parent re-render.
  }, [dialog]);

  if (status === true) {
    return (
      <div className={withBase("modal-overlay", overlayClassName)} {...overlayAria(props)}>
        <div className={withBase("modal-card", cardClassName)}>{props.children}</div>
      </div>
    );
  }
  return (
    <div className={withBase("modal-overlay", overlayClassName)} {...overlayAria(props)} onClick={backdropHandler(props)} onKeyDown={dialog ? dialogKeyDown(cardRef, onClose!, props.canClose !== false) : undefined}>
      <div ref={cardRef} tabIndex={dialog ? -1 : undefined} className={withBase("modal-card", cardClassName)}>
        {dialog && closeButton !== false && (
          <button type="button" className="modal-close" aria-label={closeLabel ?? `Close ${props.label ?? ""}`} onClick={onClose}>
            ×
          </button>
        )}
        {props.children}
      </div>
    </div>
  );
}

/** Join the shared chrome class with the call-site's variant classes. */
function withBase(base: string, extra: string | undefined): string {
  return extra === undefined ? base : `${base} ${extra}`;
}
