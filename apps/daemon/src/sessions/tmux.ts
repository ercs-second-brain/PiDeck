/**
 * Thin wrapper around the `tmux` CLI.
 *
 * All tmux interaction in the daemon goes through this class so it can be
 * faked in tests (see `testing/fake-tmux.ts`) and isolated on a private
 * socket (see the `socketName` option, used by the integration tests).
 */

import { execFile } from "node:child_process";
import { shQuote } from "./tmux-commands.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Executes a single `tmux` invocation with the given argument vector
 * (without the binary itself). Implementations must throw on a non-zero
 * exit code — prefer throwing {@link TmuxError} so the wrapper can
 * inspect `exitCode`/`stderr`.
 */
export type TmuxRunner = (args: string[]) => Promise<CommandResult>;

export class TmuxError extends Error {
  readonly args: string[];
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(
    message: string,
    options: { args: string[]; exitCode?: number; stderr?: string },
  ) {
    super(message);
    this.name = "TmuxError";
    this.args = options.args;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr ?? "";
  }
}

function execFileAsync(bin: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const exitCode =
            typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : undefined;
          reject(
            new TmuxError(`tmux ${args.join(" ")} failed: ${stderr || err.message}`, {
              args,
              exitCode,
              stderr,
            }),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/** Default {@link TmuxRunner} backed by the real `tmux` binary on PATH. */
export function defaultTmuxRunner(bin = "tmux"): TmuxRunner {
  return (args) => execFileAsync(bin, args);
}

export interface NewSessionOptions {
  /** Working directory for the session's initial pane. */
  cwd?: string;
  /**
   * Command to run in the session (e.g. `["pi"]` for worker sessions).
   * When omitted the session starts a plain interactive shell.
   */
  command?: string[];
  /**
   * Canonical runtime env the session must start with (see
   * {@link agentSessionEnv} and issue #253).
   *
   * Why: a pane inherits the TMUX SERVER's global environment — captured
   * when that server first started. On a long-lived user tmux server every
   * daemon-created session would keep running agents under a stale PATH
   * (e.g. the pre-update system Node), no matter how the daemon's own
   * runtime was refreshed.
   *
   * The injection is pane-side only ({@link sessionCommandWithEnv}): the
   * command itself is wrapped so the pane process exports this env before
   * exec'ing its payload — that works on every tmux version regardless of
   * how stale the server's global environment is. It never mutates the
   * server's global environment (`setenv` without `-t`), which would
   * pollute the user's own sessions when this wrapper runs on the default
   * server. (Issue #256: the redundant `new-session -e` belt-and-suspenders
   * — a second, tmux-3.2-gated mechanism the wrapper made dead — is gone.)
   */
  env?: Record<string, string>;
}

/**
 * Builds the `tmux new-session` argument vector: detached session `name`
 * with the given cwd/command before it.
 */
function newSessionArgs(name: string, options: NewSessionOptions): string[] {
  const args = ["new-session", "-d", "-s", name];
  if (options.cwd !== undefined) args.push("-c", options.cwd);
  if (options.command !== undefined && options.command.length > 0) {
    args.push(...options.command);
  }
  return args;
}

/** Env keys that are safe to embed in the wrapper's `export` script. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Wraps a pane command so the PANE process itself starts with the canonical
 * runtime env (issue #253): the payload is exec'd from a small `sh -c`
 * wrapper that first exports the env. This is the ONE env mechanism —
 * version-independent, and not relying on the tmux server's global
 * environment ever being fresh (issue #256).
 *
 * - With a command: `sh -c 'export ...; exec "$@"' sh <command...>` — the
 *   payload travels as separate argv entries, so commands containing spaces
 *   or quotes survive verbatim (only the env VALUES are embedded in the
 *   script, via {@link shQuote}).
 * - Without a command (plain orchestrator panes, where pi is typed in
 *   later): the wrapper exports the env then exec's the user's shell as a
 *   login shell — mirroring tmux's own default-command behavior — so typed
 *   commands (`pi` via sendKeys) resolve the canonical runtime too.
 *
 * Returns the command unchanged when there is nothing to inject.
 */
function sessionCommandWithEnv(
  command: string[] | undefined,
  env: Record<string, string>,
): string[] | undefined {
  const assignments = Object.entries(env)
    .filter(([key]) => ENV_KEY.test(key))
    .map(([key, value]) => `export ${key}=${shQuote(value)}`)
    .join("; ");
  if (assignments === "") return command;
  if (command === undefined || command.length === 0) {
    return ["sh", "-c", `${assignments}; exec "\${SHELL:-/bin/sh}" -l`];
  }
  return ["sh", "-c", `${assignments}; exec "$@"`, "sh", ...command];
}

export interface CapturePaneOptions {
  /** Number of history lines to capture back from the live pane. */
  lines?: number;
  /**
   * Capture only the trailing `lastLines` lines of the pane (issue #67):
   * the visible screen is always the bottom N lines, so polling it is O(N)
   * instead of O(history + N). Takes precedence over `lines`.
   */
  lastLines?: number;
  /**
   * Join hard-wrapped pane rows back into logical lines (tmux `-J`, issue
   * #362): a capture without it bakes the capture-time pane width into the
   * text, so a log captured in a wide pane wraps mid-word in any narrower
   * viewer. Joined logical lines let the client soft-wrap at its own width.
   */
  joinWrapped?: boolean;
}

/**
 * Wraps a tmux server (optionally a private one via `-L <socket>`).
 *
 * The daemon constructs it with `defaultSessionEnv` ({@link agentSessionEnv}):
 * every session this wrapper creates starts with the daemon's resolved
 * runtime environment instead of the tmux server's global one.
 */
export class Tmux {
  private readonly runner: TmuxRunner;
  private readonly socketName: string | undefined;
  private readonly sendChunkBytes: number;
  private readonly sendEnterDelayMs: number;
  private readonly defaultSessionEnv: Record<string, string> | undefined;
  /** Per-target serialization so concurrent `sendKeys` never interleave chunks. */
  private readonly sendQueues = new Map<string, Promise<void>>();

  constructor(
    options: {
      runner?: TmuxRunner;
      socketName?: string;
      /** Bytes of payload forwarded per `send-keys -H` invocation (issue #115). */
      sendChunkBytes?: number;
      /**
       * Settle time between typing a message and pressing Enter (issue #115).
       * A large paste can absorb a trailing Enter that arrives immediately
       * after it, leaving the draft unsubmitted in the target TUI; the pause
       * mirrors agent-orchestrator's EnterDelay. 0 disables the pause.
       */
      sendEnterDelayMs?: number;
      /**
       * Env injected into every session this wrapper creates unless the
       * caller passes {@link NewSessionOptions.env} explicitly. The daemon
       * wires {@link agentSessionEnv} here — its own resolved runtime — so
       * agent panes never inherit the tmux server's stale global
       * environment.
       */
      defaultSessionEnv?: Record<string, string>;
    } = {},
  ) {
    this.runner = options.runner ?? defaultTmuxRunner();
    this.socketName = options.socketName;
    this.sendChunkBytes = options.sendChunkBytes ?? DEFAULT_SEND_CHUNK_BYTES;
    this.sendEnterDelayMs = options.sendEnterDelayMs ?? DEFAULT_SEND_ENTER_DELAY_MS;
    this.defaultSessionEnv = options.defaultSessionEnv;
  }

  /** Whether a `tmux` binary is available at all (used to skip integration tests). */
  static async isAvailable(runner: TmuxRunner = defaultTmuxRunner()): Promise<boolean> {
    try {
      await runner(["-V"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Raw invocation — escape hatch for callers needing commands we don't wrap. */
  run(args: string[]): Promise<CommandResult> {
    return this.runner(this.prependSocket(args));
  }

  private prependSocket(args: string[]): string[] {
    return this.socketName === undefined ? args : ["-L", this.socketName, ...args];
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", name]);
      return true;
    } catch (err) {
      if (err instanceof TmuxError && err.exitCode === 1) return false;
      throw err;
    }
  }

  /**
   * Creates a detached session and enables `extended-keys` on it (issue
   * #222): pi warns — and modified Enter (shift/ctrl+Enter) may not work —
   * when the option is off, and tmux's server-wide default is off.
   *
   * `extended-keys` is a **session** option (it lives in `show-options`, not
   * `show-options -g`), and `new-session` has no flag to set options, so it
   * is applied with a targeted `set-option -t <session>` right after
   * creation. That covers every session this wrapper creates (orchestrator,
   * workers, relaunch/reconcile) and — because the option is session-scoped
   * — never mutates any other session on the server, even when this wrapper
   * runs on the user's default tmux server (no private socket).
   *
   * When {@link NewSessionOptions.env} is given, the pane command is
   * wrapped by {@link sessionCommandWithEnv} so the pane process itself
   * starts with that environment — the one version-independent path
   * (issue #253: a stale tmux server global environment must never leak
   * into agent panes).
   */
  async newSession(name: string, options: NewSessionOptions = {}): Promise<void> {
    const env = options.env ?? this.defaultSessionEnv;
    const effective: NewSessionOptions = env === undefined
      ? options
      : { ...options, command: sessionCommandWithEnv(options.command, env) };
    await this.run(newSessionArgs(name, effective));
    await this.run(["set-option", "-t", name, "extended-keys", "on"]);
  }

  /**
   * Lists tmux session names. Returns `[]` when the server is not running
   * (tmux exits 1 with "no server running on ...").
   */
  async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await this.run(["list-sessions", "-F", "#S"]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (err) {
      if (err instanceof TmuxError && isNoServerMessage(err.stderr)) return [];
      throw err;
    }
  }

  /** Kills a tmux session. Throws `TmuxError` if it does not exist. */
  async killSession(name: string): Promise<void> {
    await this.run(["kill-session", "-t", name]);
  }

  /** Captures the visible pane (plus `lines` of scrollback) of a session's active window. */
  async capturePane(name: string, options: CapturePaneOptions = {}): Promise<string> {
    const lines = options.lastLines ?? options.lines ?? 500;
    const { stdout } = await this.run([
      "capture-pane",
      "-p",
      ...(options.joinWrapped === true ? ["-J"] : []),
      "-t",
      name,
      "-S",
      `-${lines}`,
    ]);
    return stdout.replace(/\n+$/, "");
  }

  /** Resizes the session's active window (detached sessions default to 80x24). */
  async resize(name: string, cols: number, rows: number): Promise<void> {
    await this.run(["resize-window", "-t", `${name}:`, "-x", String(cols), "-y", String(rows)]);
  }

  /**
   * Types literal text into the session's active pane, optionally pressing
   * Enter to submit it (issue #115).
   *
   * The payload never travels as a raw `send-keys -l` argument: tmux parses
   * leading `-` as flags (so a message like "- fix the bug" failed outright
   * with `invalid flag`), and payloads beyond tmux's ~16KB command buffer
   * failed with `command too long`. Instead the text is chunked into
   * `send-keys -H` hex-byte invocations, which tmux cannot reinterpret.
   *
   * Payloads containing control characters (newlines, tabs, ESC — i.e. any
   * multi-line message) are wrapped in bracketed-paste markers so TUIs that
   * enable paste mode (pi among them) insert the text atomically as literal
   * content instead of interpreting embedded newlines as keypresses. Plain
   * single-line payloads stay unwrapped so ordinary shells see exactly the
   * typed characters.
   *
   * Trailing newlines are stripped from the payload first (issue #123): a
   * newline inside the paste is inserted by the target editor as literal
   * text (a stray empty line under the message, the exact "new line at the
   * end" the user reported) while the actual submission must come from the
   * explicit Enter below — so the paste should end exactly where the
   * intended message text ends.
   *
   * Enter is always its own invocation, sent after a short settle delay:
   * a large burst can absorb an Enter that arrives immediately after it,
   * leaving the draft unsubmitted in the target's input box.
   */
  async sendKeys(name: string, keys: string, options: { enter?: boolean } = {}): Promise<void> {
    await this.enqueueSend(name, () => this.performSendKeys(name, keys, options));
  }

  /**
   * Serializes sends per target: two overlapping `sendKeys` calls (e.g. the
   * spawn prompt gate racing an orchestrator message) would otherwise
   * interleave their hex chunks mid-message and corrupt the pane's input.
   */
  private enqueueSend(target: string, send: () => Promise<void>): Promise<void> {
    const tail = this.sendQueues.get(target) ?? Promise.resolve();
    const next = tail.then(send, send);
    this.sendQueues.set(
      target,
      next.catch(() => {}), // keep the queue alive after failures
    );
    return next;
  }

  private async performSendKeys(
    name: string,
    keys: string,
    options: { enter?: boolean },
  ): Promise<void> {
    // Strip trailing submit newlines before paste-wrapping (issue #123): the
    // explicit Enter below is the submission, so any trailing \n in the
    // payload would only be inserted as literal text by the target editor.
    // A payload that was nothing but newlines collapses to the empty nudge.
    const body = stripTrailingNewlines(keys);
    const payload = needsPasteWrapping(body) ? pasteWrap(body) : body;
    await this.sendHexPayload(name, Buffer.from(payload, "utf8"));
    if (options.enter) {
      if (this.sendEnterDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.sendEnterDelayMs));
      }
      await this.run(["send-keys", "-t", name, "Enter"]);
    }
  }

  /** Chunked hex `send-keys` — bytes tmux cannot reinterpret (issue #115). */
  private async sendHexPayload(name: string, payload: Buffer): Promise<void> {
    for (let offset = 0; offset < payload.length; offset += this.sendChunkBytes) {
      const chunk = payload.subarray(offset, Math.min(offset + this.sendChunkBytes, payload.length));
      await this.run([
        "send-keys",
        "-t",
        name,
        "-H",
        ...[...chunk].map((byte) => byte.toString(16).padStart(2, "0")),
      ]);
    }
  }
}

/**
 * Bytes per `send-keys -H` invocation. tmux rejects commands beyond its
 * ~16KB internal buffer (`command too long`); hex encoding costs 3 chars
 * per byte, so 4KB of payload fits with margin (same ceiling the terminal
 * bridge's InputPump uses).
 */
const DEFAULT_SEND_CHUNK_BYTES = 4096;

/** Settle time before the submitting Enter (issue #115). */
const DEFAULT_SEND_ENTER_DELAY_MS = 300;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Control characters a line-editor or TUI would treat as keypresses rather
 * than literal content. Any of these means the payload must travel inside
 * bracketed-paste markers.
 */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function needsPasteWrapping(keys: string): boolean {
  return CONTROL_CHARS.test(keys);
}

/** Wraps a payload in bracketed-paste markers so TUIs insert it literally. */
function pasteWrap(keys: string): string {
  return `${PASTE_START}${keys}${PASTE_END}`;
}

/** Removes trailing CR/LF run — the submit newlines, not message content. */
function stripTrailingNewlines(keys: string): string {
  return keys.replace(/[\r\n]+$/, "");
}

function isNoServerMessage(stderr: string): boolean {
  return (
    /no server running/i.test(stderr) ||
    /error connecting/i.test(stderr) ||
    /No such file or directory/i.test(stderr)
  );
}
