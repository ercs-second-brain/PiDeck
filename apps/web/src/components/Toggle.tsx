/**
 * The app's shared toggle switch (issue #359): ONE component for every
 * on/off control, replacing the last raw `<input type="checkbox">` uses.
 *
 * Accessibility: a real checkbox input carries the semantics and the native
 * keyboard operation (tab reaches it, space toggles); it is visually hidden
 * while staying focusable, and the global `:focus-visible` outline is
 * mirrored onto the switch track via CSS. `role="switch"` announces on/off;
 * the visual track is aria-hidden decoration. The whole label row is the
 * click/touch target (≥ 40px tall on touch viewports, index.css). Disabled
 * rows drop the pointer affordance and dim the control.
 */
import type { ReactNode } from "react";

export function Toggle(props: {
  checked: boolean;
  /** Called with the new value on every change (click or keyboard). */
  onToggle: (checked: boolean) => void;
  /** The row's text: a plain string, or a label + hint fragment. */
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-row${props.disabled === true ? " toggle-row-disabled" : ""}`}>
      <input
        type="checkbox"
        role="switch"
        className="toggle-input"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onToggle(e.target.checked)}
      />
      <span className="toggle-switch" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{props.label}</span>
    </label>
  );
}