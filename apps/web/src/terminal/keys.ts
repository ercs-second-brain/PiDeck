/**
 * Key sequences for the mobile terminal key row (issues #105, #319): the
 * keys a touch keyboard lacks. Esc/Tab/Ctrl+C/Enter are single control
 * bytes (Ctrl+C is the "Cmd+C" terminal convention); arrow keys are full
 * CSI sequences.
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
  { label: "Ctrl+C", seq: "\x03" },
  { label: "Enter", seq: "\r" },
  { label: "↑", name: "Up arrow", seq: "\x1b[A" },
  { label: "↓", name: "Down arrow", seq: "\x1b[B" },
  { label: "←", name: "Left arrow", seq: "\x1b[D" },
  { label: "→", name: "Right arrow", seq: "\x1b[C" },
];
