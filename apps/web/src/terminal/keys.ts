/**
 * Key sequences for the mobile terminal key row: the keys a touch keyboard
 * lacks. Esc/Tab/Enter are single control bytes; arrow keys are full CSI
 * sequences. The Ctrl button is not in this list — it is a sticky modifier
 * (see `controlSeq`), rendered between Tab and the arrows per the design.
 */

export interface TerminalKey {
  /** Short on-button label. */
  label: string;
  /** Accessible name (screen readers); falls back to the label. */
  name?: string;
  /** Byte(s) sent to the pane when pressed. */
  seq: string;
}

export const TERMINAL_KEYS: TerminalKey[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\x09" },
  { label: "↑", name: "Up arrow", seq: "\x1b[A" },
  { label: "↓", name: "Down arrow", seq: "\x1b[B" },
  { label: "←", name: "Left arrow", seq: "\x1b[D" },
  { label: "→", name: "Right arrow", seq: "\x1b[C" },
  { label: "⏎", name: "Enter", seq: "\r" },
];

/**
 * The control byte for a single-character key press while the sticky Ctrl
 * modifier is armed: C0 codes 0–31 map from `@A-Z[\]^_` (codes 64–95) and
 * space. Anything else is not a control key — the caller disarms and types it.
 */
export function controlSeq(key: string): string | null {
  if (key === " ") return "\x00";
  if (key.length !== 1) return null;
  const code = key.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
  return null;
}