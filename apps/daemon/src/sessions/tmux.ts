/**
 * Thin wrapper around the `tmux` CLI.
 *
 * All tmux interaction goes through this class so tests can fake it (inject a
 * `TmuxRunner`) and integration tests can run it on a private socket
 * (`socketName`). Every pi session the daemon runs lives in a detached tmux
 * session created here.
 */

import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Executes one `tmux` invocation with the given argument vector (without the
 * binary itself). Implementations must throw on a non-zero exit code —
 * prefer `TmuxError` so callers can inspect `exitCode`/`stderr`.
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
          const code = (err as { code?: unknown }).code;
          reject(
            new TmuxError(`tmux ${args.join(" ")} failed: ${stderr || err.message}`, {
              args,
              exitCode: typeof code === "number" ? code : undefined,
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

export interface CreateOptions {
  /** Working directory for the session's initial window. */
  cwd: string;
  /** Name for the session's initial window (defaults to the session name). */
  windowName?: string;
  /**
   * Command to run in the session's window (e.g. `["pi", ...]`). When
   * omitted the session starts a plain interactive shell.
   */
  command?: string[];
  /**
   * Env the pane must start with. A pane inherits the tmux server's global
   * environment — captured when that server first started — so the env is
   * injected pane-side: the command is wrapped in a small `sh -c` script
   * that exports the env before exec'ing the payload. This works on every
   * tmux version regardless of how stale the server's environment is and
   * never touches the server's global environment.
   */
  env?: Record<string, string>;
}

/** Env keys that are safe to embed in the pane's `export` script. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Wraps a pane command so the pane process starts with the canonical env:
 * `sh -c 'export ...; exec "$@"' sh <command...>`. The payload travels as
 * separate argv entries, so commands containing spaces or quotes survive
 * verbatim; only the env values are embedded in the script. Returns the
 * command unchanged when there is nothing to inject.
 */
function commandWithEnv(
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

/** Single-quotes a value for safe embedding in a shell script. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Bytes per `send-keys -H` invocation — tmux rejects commands past ~16KB. */
const SEND_CHUNK_BYTES = 4096;

/**
 * Settle time between typing a message and pressing Enter: a large paste can
 * absorb a trailing Enter that arrives immediately after it, leaving the
 * draft unsubmitted in the target TUI.
 */
const SEND_ENTER_DELAY_MS = 300;

export interface TmuxOptions {
  runner?: TmuxRunner;
  /** Private tmux server socket (tests run isolated with `-L <socket>`). */
  socketName?: string;
  /** Settle delay before the submitting Enter, in ms. */
  enterDelayMs?: number;
}

export class Tmux {
  private readonly runner: TmuxRunner;
  private readonly socketName: string | undefined;
  private readonly enterDelayMs: number;
  /** Per-target serialization so concurrent sends never interleave. */
  private readonly sendQueues = new Map<string, Promise<void>>();

  constructor(options: TmuxOptions = {}) {
    this.runner = options.runner ?? defaultTmuxRunner();
    this.socketName = options.socketName;
    this.enterDelayMs = options.enterDelayMs ?? SEND_ENTER_DELAY_MS;
  }

  /** Whether a `tmux` binary is available at all. */
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

  /** Creates a detached session whose initial window runs `command` in `cwd`. */
  async create(name: string, options: CreateOptions): Promise<void> {
    const args = ["new-session", "-d", "-s", name, "-n", options.windowName ?? name, "-c", options.cwd];
    const command = commandWithEnv(options.command, options.env ?? {});
    if (command !== undefined) args.push(...command);
    await this.run(args);
  }

  /** Whether the tmux session exists. */
  async isAlive(name: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", name]);
      return true;
    } catch (err) {
      if (err instanceof TmuxError && err.exitCode === 1) return false;
      throw err;
    }
  }

  /**
   * Lists tmux session names. Returns `[]` when the server is not running.
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

  /**
   * Types a single line into the session's active pane, then presses Enter.
   * Safe for one-line prompts — every daemon delivery is a single line.
   *
   * The text travels as chunked `send-keys -H` hex-byte invocations, which
   * tmux cannot reinterpret as flags or keys (raw `send-keys -l` parses a
   * leading `-` as a flag, and long payloads overflow tmux's command
   * buffer). Trailing newlines are stripped: the explicit Enter below is
   * the submission. Enter is its own invocation, sent after a short settle
   * delay so a large burst cannot absorb it.
   */
  async sendLine(name: string, text: string): Promise<void> {
    await this.enqueue(name, () => this.performSendLine(name, text));
  }

  private enqueue(target: string, send: () => Promise<void>): Promise<void> {
    const tail = this.sendQueues.get(target) ?? Promise.resolve();
    const next = tail.then(send, send);
    this.sendQueues.set(
      target,
      next.catch(() => {}),
    );
    return next;
  }

  private async performSendLine(name: string, text: string): Promise<void> {
    const payload = text.replace(/[\r\n]+$/, "");
    for (let offset = 0; offset < payload.length; offset += SEND_CHUNK_BYTES) {
      const chunk = payload.slice(offset, offset + SEND_CHUNK_BYTES);
      const hex = [...Buffer.from(chunk, "utf8")].map((byte) =>
        byte.toString(16).padStart(2, "0"),
      );
      await this.run(["send-keys", "-t", name, "-H", ...hex]);
    }
    if (this.enterDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.enterDelayMs));
    }
    await this.run(["send-keys", "-t", name, "Enter"]);
  }

  /** Kills a tmux session. Throws `TmuxError` if it does not exist. */
  async kill(name: string): Promise<void> {
    await this.run(["kill-session", "-t", name]);
  }

  /**
   * Captures the visible pane plus `lines` of scrollback of a session's
   * active window. `-e` keeps escape sequences (archived logs keep their
   * colours); `-J` joins hard-wrapped rows back into logical lines so the
   * capture is not baked to the pane width it had at capture time.
   */
  async capturePane(name: string, options: { lines?: number } = {}): Promise<string> {
    const lines = options.lines ?? 2000;
    const { stdout } = await this.run([
      "capture-pane",
      "-p",
      "-e",
      "-J",
      "-t",
      name,
      "-S",
      `-${lines}`,
    ]);
    return stdout.replace(/\n+$/, "");
  }
}

function isNoServerMessage(stderr: string): boolean {
  return (
    /no server running/i.test(stderr) ||
    /error connecting/i.test(stderr) ||
    /no such file or directory/i.test(stderr)
  );
}
