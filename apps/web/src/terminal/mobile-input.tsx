/**
 * Mobile terminal input: on touch devices the OS keyboard never types into
 * xterm's hidden textarea — see {@link applyMobileInputGate} for why that
 * textarea becomes a duplication bomb under mobile autocorrect — all composed
 * text enters through a dedicated visible input field
 * ({@link MobileComposer}, the design's primary way to type on phones) and is
 * sent to the pane verbatim once, with the trailing Enter. Direct xterm input
 * remains available on hardware keyboards.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";

/**
 * Media query that matches touch-primary devices (phones, tablets). These are
 * exactly the devices whose software keyboard turns xterm's hidden textarea
 * into the duplication path, so the same query gates the textarea lock-out,
 * the composer field, the key row, and touch scrolling.
 */
export const MOBILE_POINTER_QUERY = "(pointer: coarse)";

/** Reads the coarse-pointer query defensively (SSR/tests may lack matchMedia). */
function prefersCoarsePointer(): boolean {
  const mm = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia : null;
  return mm !== null && mm(MOBILE_POINTER_QUERY).matches;
}

/** Live coarse-pointer state (reacts to device changes, defaults false). */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(prefersCoarsePointer);
  useEffect(() => {
    const mm = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia : null;
    if (mm === null) return;
    const mql = mm(MOBILE_POINTER_QUERY);
    const onChange = () => setCoarse(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

/**
 * The slice of the hidden xterm textarea the mobile gate needs — kept
 * structural so tests can pass a stub instead of a live DOM element.
 */
export interface GatableTextarea {
  readOnly: boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Locks the OS keyboard out of xterm's hidden textarea.
 *
 * Mechanism of the bug this closes: an unmodified space is keyCode 32, which
 * xterm's keydown handler never claims, so the space is emitted to the pane
 * AND inserted into the hidden textarea, which is only cleared on Enter/Ctrl+C.
 * iOS's double-space "smart punctuation" period gesture (which ignores xterm's
 * `autocorrect="off"`) then rewrites the textarea value in place; that
 * mutation arrives as a keyCode-229 keydown routed into xterm's composition
 * helper, whose diff fails to match on in-place edits and re-emits the ENTIRE
 * accumulated value on top of what was already sent — the message appears
 * twice.
 *
 * `readOnly` makes value mutation (composition, autocorrect, dictation)
 * impossible, and `inputmode="none"` additionally keeps the virtual keyboard
 * from opening over the terminal. Hardware keyboards are unaffected: keydown
 * still fires on a readOnly textarea, so direct typing keeps working on e.g.
 * an iPad with a keyboard attached. The gate is only applied on coarse-pointer
 * devices; desktop is untouched.
 */
export function applyMobileInputGate(textarea: GatableTextarea): void {
  textarea.readOnly = true;
  textarea.setAttribute("inputmode", "none");
}

/** Lifts the mobile gate (device is no longer touch-primary). */
export function removeMobileInputGate(textarea: GatableTextarea): void {
  textarea.readOnly = false;
  textarea.removeAttribute("inputmode");
}

/**
 * Applies/lifts the textarea gate as the touch-device flag changes. Lives
 * behind the pane's own mount effect, so it only ever sees a live terminal.
 */
export function useMobileTextareaGate(
  termRef: RefObject<Terminal | null>,
  coarsePointer: boolean,
): void {
  useEffect(() => {
    const textarea = termRef.current?.textarea;
    if (!textarea) return;
    if (coarsePointer) applyMobileInputGate(textarea);
    else removeMobileInputGate(textarea);
  }, [coarsePointer, termRef]);
}

/**
 * Bytes the pane receives for composer `text`. A submission must submit
 * exactly once: interior line breaks collapse to single spaces (a PTY reads
 * every newline as its own Enter), and ends are stripped only where they
 * contained a line break, so a trailing newline from a paste cannot add a
 * second, empty-looking submission. Everything else is delivered verbatim —
 * including typed spaces — and packaged with the trailing `\r` that stands in
 * for Enter. Whitespace-only input sends nothing.
 */
export function terminalPayload(text: string): string {
  if (text.trim().length === 0) return "";
  const stripped = text.replace(/^(?:[\t ]*[\r\n])+/, "").replace(/(?:[\r\n][\t ]*)+$/, "");
  return `${stripped.replace(/[\r\n]+/g, " ")}\r`;
}

/** Composer submit: sends the payload exactly once, or nothing when empty. */
export function submitComposerText(text: string, send: (data: string) => void): boolean {
  const payload = terminalPayload(text);
  if (payload.length === 0) return false;
  send(payload);
  return true;
}

/**
 * Mobile composer: a multi-line field — Enter sends, Shift+Enter inserts a
 * newline. The OS keyboard, autocorrect and the double-space period gesture
 * behave here exactly as in any ordinary text field, and none of it can reach
 * the pane until send. Rendered only while the coarse-pointer flag is live,
 * so React gates the element itself (desktop sees none of it). 16px input
 * font prevents iOS zoom-on-focus.
 */
export function MobileComposer(props: {
  onSend: (payload: string) => void;
  ctrlArmed: boolean;
  /** Called for the next key press while Ctrl is armed; returns whether it was consumed as a control key. */
  onCtrlKey: (key: string) => boolean;
}) {
  const { onSend, ctrlArmed, onCtrlKey } = props;
  const [value, setValue] = useState("");
  // Synchronous mirror of `value`: clearing state alone would let a rapid
  // second submission re-read the just-sent text from the same render's
  // closure and send it twice.
  const valueRef = useRef("");
  const submit = () => {
    const text = valueRef.current;
    valueRef.current = "";
    setValue("");
    submitComposerText(text, onSend);
  };
  return (
    <form
      className="terminal-composer"
      aria-label="Terminal composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="terminal-composer-input"
        rows={1}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          valueRef.current = next;
          setValue(next);
        }}
        onKeyDown={(event) => {
          if (ctrlArmed && !event.shiftKey && !event.metaKey && onCtrlKey(event.key)) {
            event.preventDefault();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        enterKeyHint="send"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Type for this terminal…"
        aria-label="Terminal input"
      />
      <button type="submit" className="terminal-composer-send" aria-label="Send">
        ⏎
      </button>
    </form>
  );
}