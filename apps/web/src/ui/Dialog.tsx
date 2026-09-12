import { useEffect, type ReactNode } from "react";
import { Button } from "./Button";
import "./dialog.css";

/**
 * Confirmation dialog, for destructive actions only. Escape and the overlay
 * cancel; `busy` disables the buttons while the confirmed action runs.
 */
export function Dialog({ open, title, children, confirmLabel = "Confirm", danger, busy, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busy !== true) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;
  return (
    <div className="dialog-overlay" onClick={busy ? undefined : onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <h2 className="dialog__title">{title}</h2>
        {children !== undefined && children !== null && <div className="dialog__body">{children}</div>}
        <div className="dialog__actions">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
