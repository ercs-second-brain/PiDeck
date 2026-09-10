/**
 * The nested asset dialog (issue #358, B11): the prompt/skill/kind editors
 * open as proper modal dialogs over the agent-assets modal instead of
 * appending inline to it. Fixed-position overlay (later DOM order paints it
 * over the host modal at the same z-index band; the `+1` keeps it above).
 */

import type { ReactNode } from "react";

import { EditorActions } from "./AssetEditorActions";

/** The dialog's shared footer: error note plus Cancel/Save (the #315 chrome). */
export interface AssetDialogFooter {
  error: string | null;
  saving: boolean;
  onSave: () => void;
}

export function AssetDialog(props: { ariaLabel: string; title?: string; footer?: AssetDialogFooter; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-overlay asset-dialog-overlay" role="dialog" aria-modal="true" aria-label={props.ariaLabel}>
      <div className="modal-card asset-dialog">
        <button type="button" className="modal-close" aria-label={`Close ${props.ariaLabel}`} onClick={props.onClose}>
          ×
        </button>
        {props.title !== undefined && <h2 className="modal-title">{props.title}</h2>}
        {props.children}
        {props.footer !== undefined && (
          <>
            {props.footer.error !== null && <p className="error-note">{props.footer.error}</p>}
            <EditorActions saving={props.footer.saving} onSave={props.footer.onSave} onCancel={props.onClose} />
          </>
        )}
      </div>
    </div>
  );
}
