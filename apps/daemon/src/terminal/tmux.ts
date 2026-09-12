/**
 * Thin wrapper around the `tmux` CLI, scoped to what the terminal bridge
 * needs: run an argument vector, check a session exists. Kept as an
 * interface so tests can fake it and an integration test can target a
 * private tmux socket.
 */

import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export class TmuxError extends Error {
  readonly args: string[];
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(message: string, options: { args: string[]; exitCode?: number; stderr?: string }) {
    super(message);
    this.name = "TmuxError";
    this.args = options.args;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr ?? "";
  }
}

/** The surface of `tmux` the terminal bridge talks to. */
export interface Tmux {
  /** Runs one `tmux` invocation; rejects with `TmuxError` on non-zero exit. */
  run(args: string[]): Promise<CommandResult>;
  hasSession(name: string): Promise<boolean>;
}

function execFileAsync(bin: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    });
  });
}

export interface TmuxCliOptions {
  /** Binary to invoke (default `tmux`). */
  bin?: string;
  /** Run against a private tmux socket (`tmux -L <name>`); for tests. */
  socket?: string;
}

/** Real {@link Tmux} backed by the `tmux` binary. */
export class TmuxCli implements Tmux {
  private readonly bin: string;
  private readonly prefix: string[];

  constructor(options: TmuxCliOptions = {}) {
    this.bin = options.bin ?? "tmux";
    this.prefix = options.socket ? ["-L", options.socket] : [];
  }

  run(args: string[]): Promise<CommandResult> {
    return execFileAsync(this.bin, [...this.prefix, ...args]);
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", name]);
      return true;
    } catch {
      return false;
    }
  }
}