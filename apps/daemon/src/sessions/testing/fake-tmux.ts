/**
 * In-memory fake `Tmux` shared by the sessions and terminal test suites.
 * Simulates the subset of tmux the daemon uses:
 *
 * - `pipe-pane -o -t <target> 'cat >> <file>'` records the stream file;
 *   tests emit pane output with {@link FakeTmux.paneOutput}, which appends
 *   to that file exactly like the real `cat >>` would (fs.watch then
 *   wakes the real reader).
 * - `send-keys -t <target> -H <hex>...` decodes into per-target input.
 * - `resize-window -t <target>: -x -y` records the pane size.
 * - `capture-pane -p -e -N -t <target> -S -<n>` returns the canned text set
 *   with {@link FakeTmux.setCapturePane}.
 *
 * The high-level daemon API (create/isAlive/sendLine/kill/capturePane) is
 * overridden on top of the command simulation so API-level tests can drive
 * and assert it directly (`sent`, `killed`).
 */

import { appendFileSync } from "node:fs";
import { Tmux, TmuxError, type CommandResult } from "../tmux.js";

export interface FakeTmuxPane {
  cols: number;
  rows: number;
}

export class FakeTmux extends Tmux {
  readonly sessions = new Map<string, FakeTmuxPane>();
  /** Every invocation, in order. */
  readonly invocations: string[][] = [];
  /** Lines delivered via the high-level `sendLine`, in order. */
  readonly sent: { session: string; text: string }[] = [];
  /** Sessions killed through the high-level `kill`, in order. */
  readonly killed: string[] = [];
  private readonly pipes = new Map<string, string>();
  private readonly inputs = new Map<string, Buffer[]>();
  private readonly captures = new Map<string, string>();

  constructor() {
    super({ runner: async () => ({ stdout: "", stderr: "" }), enterDelayMs: 0 });
  }

  override run(args: string[]): Promise<CommandResult> {
    this.invocations.push(args);
    try {
      return Promise.resolve({ stdout: this.execute(args), stderr: "" });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  override hasSession(name: string): Promise<boolean> {
    return Promise.resolve(this.sessions.has(name));
  }

  override isAlive(name: string): Promise<boolean> {
    return Promise.resolve(this.sessions.has(name));
  }

  override listSessions(): Promise<string[]> {
    return Promise.resolve([...this.sessions.keys()]);
  }

  override create(name: string): Promise<void> {
    this.createSession(name);
    return Promise.resolve();
  }

  override sendLine(session: string, text: string): Promise<void> {
    this.sent.push({ session, text });
    return Promise.resolve();
  }

  override kill(name: string): Promise<void> {
    this.killed.push(name);
    this.killSession(name);
    return Promise.resolve();
  }

  override capturePane(name: string): Promise<string> {
    return Promise.resolve(this.captures.get(name) ?? "pane scrollback");
  }

  createSession(name: string, pane: FakeTmuxPane = { cols: 80, rows: 24 }): void {
    this.sessions.set(name, pane);
  }

  killSession(name: string): void {
    this.sessions.delete(name);
  }

  /** Whether a pipe-pane is active for the target. */
  pipeActive(target: string): boolean {
    return this.pipes.has(target);
  }

  /** Pre-seeds a pipe for the target (simulating a leftover from a restart). */
  openPipe(target: string, file: string): void {
    this.pipes.set(target, file);
  }

  /** The stream file the pane's pipe appends to, if one is running. */
  pipeStreamPath(target: string): string | undefined {
    return this.pipes.get(target);
  }

  /** Simulates the pane process writing output to its pty. */
  paneOutput(target: string, text: string): void {
    const file = this.pipes.get(target);
    if (file === undefined) throw new Error(`no pipe-pane running for ${target}`);
    appendFileSync(file, text);
  }

  /** Everything typed into the pane via `send-keys -H`, in order. */
  inputOf(target: string): Buffer {
    return Buffer.concat(this.inputs.get(target) ?? []);
  }

  /** Canned `capture-pane` output (the pane's scrollback). */
  setCapturePane(target: string, text: string): void {
    this.captures.set(target, text);
  }

  private execute(args: string[]): string {
    const [command] = args;
    switch (command) {
      case "has-session": {
        const name = this.flagValue(args, "-t");
        if (!this.sessions.has(name)) this.fail(`can't find session ${name}`, args);
        return "";
      }
      case "pipe-pane": {
        const target = this.flagValue(args, "-t");
        if (!this.sessions.has(target)) this.fail(`can't find session ${target}`, args);
        const command_ = args[args.length - 1];
        if (command_ !== undefined && command_.startsWith("cat >> ")) {
          this.pipes.set(target, command_.slice("cat >> ".length).trim().replaceAll("'", ""));
        } else {
          this.pipes.delete(target);
        }
        return "";
      }
      case "send-keys": {
        const target = this.flagValue(args, "-t");
        const hexIndex = args.indexOf("-H");
        if (hexIndex === -1) this.fail("only -H is supported", args);
        const bytes: number[] = [];
        for (let i = hexIndex + 1; i < args.length; i++) {
          const arg = args[i] ?? "";
          if (/^[0-9a-fA-F]{2}$/.test(arg)) bytes.push(Number.parseInt(arg, 16));
        }
        const chunks = this.inputs.get(target) ?? [];
        chunks.push(Buffer.from(bytes));
        this.inputs.set(target, chunks);
        return "";
      }
      case "resize-window": {
        const target = this.flagValue(args, "-t").replace(/:$/, "");
        const pane = this.sessions.get(target);
        if (!pane) this.fail(`can't find window ${target}`, args);
        pane.cols = Number(this.flagValue(args, "-x"));
        pane.rows = Number(this.flagValue(args, "-y"));
        return "";
      }
      case "set-option":
        return "";
      case "display-message": {
        const target = this.flagValue(args, "-t").replace(/:$/, "");
        const pane = this.sessions.get(target);
        if (!pane) this.fail(`can't find window ${target}`, args);
        return `${pane.cols} ${pane.rows}`;
      }
      case "capture-pane": {
        const target = this.flagValue(args, "-t");
        return this.captures.get(target) ?? "";
      }
      default:
        this.fail("unsupported command", args);
    }
  }

  private flagValue(args: string[], flag: string): string {
    const value = args[args.indexOf(flag) + 1];
    if (value === undefined) this.fail(`missing ${flag}`, args);
    return value;
  }

  private fail(message: string, args: string[]): never {
    throw new TmuxError(`tmux ${args.join(" ")} failed: ${message}`, {
      args,
      exitCode: 1,
      stderr: message,
    });
  }
}
