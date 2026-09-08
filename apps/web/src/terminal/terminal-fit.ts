/**
 * Fit/resize wiring for the browser terminal (issue #124): turns xterm's
 * fit addon measurements into `terminal.resize` frames on the daemon so the
 * tmux window (and therefore the pane's rendering width) follows the
 * browser viewport.
 *
 * Extracted from `TerminalPane` so the propagation rules are unit-testable
 * without a DOM:
 * - a failed `fit()` (container not measurable yet, e.g. hidden during a
 *   route transition) is swallowed — the next observer event re-fits;
 * - every invocation reports the terminal's current size via `onFitted`
 *   (the pane keeps it for the relaunch re-attach);
 * - a `connection.resize` frame is sent only when the fitted size actually
 *   differs from the last one sent, so viewport jitter doesn't spam the
 *   daemon.
 */

interface TerminalSize {
  cols: number;
  rows: number;
}

export interface FitControllerOptions {
  /** Live terminal whose `cols`/`rows` reflect the last `fit()`. */
  terminal: { cols: number; rows: number };
  /** The fit addon's `fit()`. May throw when the container is unmeasurable. */
  fit: () => void;
  /** The terminal connection receiving `resize(cols, rows)`. */
  connection: { resize(cols: number, rows: number): void };
  /** Called on every invocation with the terminal's current size. */
  onFitted?: (size: TerminalSize) => void;
}

/** Returns the observer callback: fit, report, and propagate size changes. */
export function createFitController(options: FitControllerOptions): () => void {
  let lastSent: TerminalSize = { cols: options.terminal.cols, rows: options.terminal.rows };
  return () => {
    try {
      options.fit();
    } catch {
      // Container not measurable yet (hidden during transition) — the
      // next observer event will fit.
    }
    const size: TerminalSize = { cols: options.terminal.cols, rows: options.terminal.rows };
    options.onFitted?.(size);
    if (size.cols !== lastSent.cols || size.rows !== lastSent.rows) {
      lastSent = size;
      options.connection.resize(size.cols, size.rows);
    }
  };
}
