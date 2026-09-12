/**
 * Fit/resize wiring for the browser terminal: turns xterm's fit addon
 * measurements into `terminal.resize` frames on the daemon so the tmux window
 * (and therefore the pane's rendering width) follows the browser viewport.
 *
 * - the first invocation fits synchronously — the pane attaches with the
 *   terminal's size right after wiring the observer, so the initial fit must
 *   not be deferred;
 * - subsequent invocations are coalesced into one trailing fit: a container
 *   that changes every animation frame would otherwise push an intermediate
 *   size to tmux on every frame — each one a tmux resize plus a full screen
 *   repaint and a client-side rewrap of the scrollback at a width that is
 *   stale again on the next frame;
 * - a failed `fit()` (container not measurable yet) is swallowed — the next
 *   observer event re-fits;
 * - every completed fit reports the terminal's current size via `onFitted`;
 * - a `connection.resize` frame is sent only when the fitted size actually
 *   differs from the last one sent, so viewport jitter doesn't spam the daemon;
 * - `dispose()` cancels a pending trailing fit — pane teardown must not fit a
 *   disposed terminal;
 * - `flush()` runs a fit immediately, cancelling any pending trailing fit —
 *   the post-replay re-fit is already timed (next animation frame), so it
 *   must not sit through another debounce window.
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
  /** Called on every completed fit with the terminal's current size. */
  onFitted?: (size: TerminalSize) => void;
  /** Coalescing window (ms) for resize bursts. 0 disables the debounce. Default 150. */
  debounceMs?: number;
}

/** The observer callback: coalesces bursts, fits, reports, propagates. */
export interface FitController {
  (): void;
  /** Fits immediately, cancelling a pending trailing fit (post-replay re-fit). */
  flush(): void;
  /** Cancels a pending trailing fit (pane teardown). */
  dispose(): void;
}

export function createFitController(options: FitControllerOptions): FitController {
  const debounceMs = options.debounceMs ?? 150;
  let lastSent: TerminalSize = { cols: options.terminal.cols, rows: options.terminal.rows };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstCall = true;

  const run = () => {
    timer = undefined;
    try {
      options.fit();
    } catch {
      // Container not measurable yet — the next observer event will fit.
    }
    const size: TerminalSize = { cols: options.terminal.cols, rows: options.terminal.rows };
    options.onFitted?.(size);
    if (size.cols !== lastSent.cols || size.rows !== lastSent.rows) {
      lastSent = size;
      options.connection.resize(size.cols, size.rows);
    }
  };

  const controller = (() => {
    if (firstCall) {
      firstCall = false;
      run();
      return;
    }
    if (timer !== undefined) clearTimeout(timer);
    if (debounceMs <= 0) {
      run();
      return;
    }
    timer = setTimeout(run, debounceMs);
  }) as FitController;
  controller.flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    run();
  };
  controller.dispose = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return controller;
}