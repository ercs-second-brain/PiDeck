/**
 * Thin wrapper around the `tmux` CLI.
 *
 * All tmux interaction in the daemon goes through this class so it can be
 * faked in tests (see `testing/fake-tmux.ts`) and isolated on a private
 * socket (see the `socketName` option, used by the integration tests).
 */

import { execFile } from "node:child_process";

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
}

export interface CapturePaneOptions {
  /** Number of history lines to capture back from the live pane. */
  lines?: number;
}

/**
 * Wraps a tmux server (optionally a private one via `-L <socket>`).
 */
export class Tmux {
  private readonly runner: TmuxRunner;
  private readonly socketName: string | undefined;

  constructor(options: { runner?: TmuxRunner; socketName?: string } = {}) {
    this.runner = options.runner ?? defaultTmuxRunner();
    this.socketName = options.socketName;
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

  async newSession(name: string, options: NewSessionOptions = {}): Promise<void> {
    const args = ["new-session", "-d", "-s", name];
    if (options.cwd !== undefined) args.push("-c", options.cwd);
    if (options.command !== undefined && options.command.length > 0) {
      args.push(...options.command);
    }
    await this.run(args);
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
    const lines = options.lines ?? 500;
    const { stdout } = await this.run([
      "capture-pane",
      "-p",
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

  /** Types literal text into the session's active pane, optionally pressing Enter. */
  async sendKeys(name: string, keys: string, options: { enter?: boolean } = {}): Promise<void> {
    await this.run(["send-keys", "-t", name, "-l", keys]);
    if (options.enter) await this.run(["send-keys", "-t", name, "Enter"]);
  }
}

function isNoServerMessage(stderr: string): boolean {
  return (
    /no server running/i.test(stderr) ||
    /error connecting/i.test(stderr) ||
    /No such file or directory/i.test(stderr)
  );
}
