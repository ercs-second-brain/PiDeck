/**
 * In-memory fake `TmuxRunner` simulating a tmux server.
 *
 * Used by the daemon's unit tests to exercise tmux-dependent logic without
 * a real tmux binary. Covers the session-management commands (issue #4)
 * and the terminal bridge commands (issues #7/#67):
 * - `send-keys -l <text>` / `send-keys -H <hex>...` — literal text or
 *   hex-encoded bytes (one byte per argument) are appended to the pane.
 * - `capture-pane` tolerates `-e` (escape-sequence capture) and honors the
 *   `-S` history bound (exactly the trailing N lines — the visible-screen
 *   capture mode of the bridge's poll loop).
 * - `pipe-pane` records the target and the notification path from the
 *   command (`cat >> <path>`), so tests can emit output into the watched
 *   file exactly like a real pipe-pane does (see `notifyOutput`).
 *
 * Only implements the subset of commands the daemon uses.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TmuxError, type CommandResult, type TmuxRunner } from "../tmux.js";

export interface FakePaneState {
  command: string[];
  cwd: string | undefined;
  /** Simulated pane contents, one entry per line. */
  paneLines: string[];
  cols: number;
  rows: number;
  /**
   * The pane's PID (`#{pane_pid}`), assigned sequentially at `new-session`
   * (agent-kind caller discovery, docs/agent-kinds.md §3). Sessions seeded
   * directly into the map without one are invisible to `list-panes`.
   */
  panePid?: number;
  /** Simulated pane cursor (reported via `display-message`; issue #92). */
  cursorX?: number;
  cursorY?: number;
  cursorVisible?: boolean;
  /**
   * Value of the session-scoped `extended-keys` option (issue #222), as
   * `set-option` left it. `new-session` initializes it to `off`, mirroring
   * tmux's server-wide default; direct state seeds may leave it unset.
   */
  extendedKeys?: "on" | "off" | "external";
}

export interface FakeTmuxRunnerOptions {
  /** Pre-seed pane output for a session that will be created later. */
  initialPaneLines?: string[];
  initialCols?: number;
  initialRows?: number;
}

export interface FakeInvocation {
  /** The full argument vector (excluding the `-L <socket>` prefix). */
  args: string[];
}

export class FakeTmuxRunner {
  readonly sessions = new Map<string, FakePaneState>();
  /** Every invocation, in order (for input-coalescing assertions). */
  readonly invocations: FakeInvocation[] = [];

  /** Active pipes: pane target → `{ command, notifyPath }`. */
  private readonly pipes = new Map<
    string,
    { command: string; notifyPath: string | undefined }
  >();

  private readonly initialPaneLines: string[] | undefined;
  private readonly initialCols: number;
  private readonly initialRows: number;
  /** Monotonic fake pane PID source (caller discovery, docs/agent-kinds.md). */
  private nextPanePid = 42_000;

  constructor(options: FakeTmuxRunnerOptions = {}) {
    this.initialPaneLines = options.initialPaneLines;
    this.initialCols = options.initialCols ?? 80;
    this.initialRows = options.initialRows ?? 24;
  }

  run(args: string[]): Promise<CommandResult> {
    try {
      return Promise.resolve({ stdout: this.execute(args), stderr: "" });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Adapter for the {@link TmuxRunner} call-signature interface. */
  asRunner(): TmuxRunner {
    return (args) => this.run(args);
  }

  fail(message: string, args: string[]): never {
    throw new TmuxError(`tmux ${args.join(" ")} failed: ${message}`, {
      args,
      exitCode: 1,
      stderr: message,
    });
  }

  /** The notification path of the pane's active pipe, if one is running. */
  pipeStreamPath(target: string): string | undefined {
    return this.pipes.get(target)?.notifyPath;
  }

  /**
   * Every byte sent to the pane's input via `send-keys -H`, in order.
   * Key-name invocations (e.g. `send-keys Enter`) are not included — tests
   * assert those via `invocations` (issue #115).
   */
  sentBytes(target: string): Buffer {
    const chunks: Buffer[] = [];
    for (const inv of this.invocations) {
      const args = inv.args;
      if (args[0] !== "send-keys" || !args.includes("-H")) continue;
      if (!args.includes("-t") || args[args.indexOf("-t") + 1] !== target) continue;
      const bytes: number[] = [];
      for (let i = args.indexOf("-H") + 1; i < args.length; i++) {
        const arg = args[i] ?? "";
        if (/^[0-9a-fA-F]{2}$/.test(arg)) bytes.push(Number.parseInt(arg, 16));
      }
      chunks.push(Buffer.from(bytes));
    }
    return Buffer.concat(chunks);
  }

  /** Whether a pipe-pane is active for the target (start/stop bookkeeping). */
  pipeActive(target: string): boolean {
    return this.pipes.has(target);
  }

  /**
   * Emits pane output: appends the lines to the pane (so subsequent
   * `capture-pane` calls see them) and, when a pipe-pane is active, appends
   * the raw text to the pipe's stream file — the same effect the real
   * `cat >> <file>` pipe command has. Files are created on demand.
   */
  notifyOutput(target: string, text: string): void {
    const pane = this.sessions.get(target);
    if (!pane) this.fail(`can't find session ${target}`, []);
    pane.paneLines.push(...splitLines(text));
    const pipe = this.pipes.get(target);
    if (pipe?.notifyPath !== undefined) appendTo(pipe.notifyPath, text);
  }

  private execute(args: string[]): string {
    // Skip a private-socket prefix (`-L <name>`) if present.
    let rest = args;
    if (rest[0] === "-L") rest = rest.slice(2);
    this.invocations.push({ args: [...rest] });
    const [cmd, ...cmdArgs] = rest;
    switch (cmd) {
      case "-V":
        return "tmux 3.4";
      case "has-session":
        return this.hasSession(cmdArgs, args);
      case "new-session":
        return this.newSession(cmdArgs, args);
      case "list-sessions":
        return [...this.sessions.keys()].join("\n");
      case "list-panes":
        return [...this.sessions.entries()]
          .filter(([, pane]) => pane.panePid !== undefined)
          .map(([name, pane]) => `${name}\t${pane.panePid}`)
          .join("\n");
      case "kill-session":
        return this.killSession(cmdArgs, args);
      case "capture-pane":
        return this.capturePane(cmdArgs, args);
      case "resize-window":
        return this.resizeWindow(cmdArgs, args);
      case "send-keys":
        return this.sendKeys(cmdArgs, args);
      case "pipe-pane":
        return this.pipePane(cmdArgs, args);
      case "display-message":
        return this.displayMessage(cmdArgs, args);
      case "set-option":
        return this.setOption(cmdArgs, args);
      default:
        return this.fail(`unknown command: ${cmd ?? "(none)"}`, args);
    }
  }

  private hasSession(cmdArgs: string[], originalArgs: string[]): string {
    const name = this.target(cmdArgs, originalArgs);
    if (!this.sessions.has(name)) this.fail("can't find session", originalArgs);
    return "";
  }

  private newSession(cmdArgs: string[], originalArgs: string[]): string {
    const parsed = this.parseNewSession(cmdArgs);
    if (this.sessions.has(parsed.name)) this.fail("duplicate session", originalArgs);
    this.sessions.set(parsed.name, {
      command: parsed.command,
      cwd: parsed.cwd,
      paneLines: this.initialPaneLines ? [...this.initialPaneLines] : [],
      cols: this.initialCols,
      rows: this.initialRows,
      panePid: this.nextPanePid++,
      cursorX: 0,
      cursorY: 0,
      cursorVisible: true,
      extendedKeys: "off",
    });
    return "";
  }

  private killSession(cmdArgs: string[], originalArgs: string[]): string {
    const name = this.target(cmdArgs, originalArgs);
    if (!this.sessions.delete(name)) this.fail("can't find session", originalArgs);
    this.pipes.delete(name);
    return "";
  }

  private capturePane(cmdArgs: string[], originalArgs: string[]): string {
    const pane = this.paneOf(cmdArgs, originalArgs);
    // `-p`/`-e` are output-mode flags the fake renders the same way. `-S`
    // bounds are honored as "exactly the trailing N lines", matching the
    // visible-screen capture mode of the bridge's poll loop (issue #67).
    const sIdx = cmdArgs.indexOf("-S");
    const bound = sIdx !== -1 ? Number(cmdArgs[sIdx + 1]) : Number.NaN;
    if (!Number.isFinite(bound) || bound < 0) return pane.paneLines.join("\n");
    const keep = pane.paneLines.slice(-bound);
    return keep.length > 0 ? keep.join("\n") : "";
  }

  private resizeWindow(cmdArgs: string[], originalArgs: string[]): string {
    const pane = this.paneOf(cmdArgs, originalArgs);
    const x = cmdArgs.indexOf("-x");
    const y = cmdArgs.indexOf("-y");
    if (x !== -1) pane.cols = Number(cmdArgs[x + 1]);
    if (y !== -1) pane.rows = Number(cmdArgs[y + 1]);
    return "";
  }

  private sendKeys(cmdArgs: string[], originalArgs: string[]): string {
    const pane = this.paneOf(cmdArgs, originalArgs);
    const literal = cmdArgs.indexOf("-l");
    if (literal !== -1) {
      const text = cmdArgs[literal + 1];
      if (text !== undefined) pane.paneLines.push(text);
    }
    const hex = cmdArgs.indexOf("-H");
    if (hex !== -1) pane.paneLines.push(this.decodeHex(cmdArgs.slice(hex + 1), originalArgs));
    return "";
  }

  private pipePane(cmdArgs: string[], originalArgs: string[]): string {
    const name = this.target(cmdArgs, originalArgs);
    if (!this.sessions.has(name)) this.fail("can't find session", originalArgs);
    // Command is the first non-flag argument (the fake never passes
    // `-I`/`-O`); no command stops the pipe.
    const command = this.pipeCommand(cmdArgs);
    if (command === undefined) {
      this.pipes.delete(name);
      return "";
    }
    // Match the real pipe command shape: `cat >> <path>` — extract the
    // stream file path so `notifyOutput` can mirror the append.
    const match = />>\s*(\S+)/.exec(command);
    this.pipes.set(name, { command, notifyPath: match?.[1] });
    // The real pipe shell creates/truncates the stream file at startup.
    if (match?.[1] !== undefined) createFile(match[1]);
    return "";
  }

  /**
   * Applies a session option (issue #222): `set-option -t <session>
   * extended-keys on|off|external`. Like the real tmux, fails on a missing
   * target session or an unknown option.
   */
  private setOption(cmdArgs: string[], originalArgs: string[]): string {
    const pane = this.paneOf(cmdArgs, originalArgs);
    const tIdx = cmdArgs.indexOf("-t");
    const rest = tIdx !== -1 ? cmdArgs.slice(tIdx + 2) : cmdArgs;
    const [option, value] = rest;
    if (option === "extended-keys" && (value === "on" || value === "off" || value === "external")) {
      pane.extendedKeys = value;
      return "";
    }
    return this.fail(`unknown option: ${option ?? "(none)"}`, originalArgs);
  }

  /**
   * Renders a `display-message -p` format, substituting the cursor tokens
   * the terminal bridge queries (issue #92). Unknown tokens pass through —
   * callers here only ever ask for the cursor triple.
   */
  private displayMessage(cmdArgs: string[], originalArgs: string[]): string {
    const pane = this.paneOf(cmdArgs, originalArgs);
    let format: string | undefined;
    for (let i = 0; i < cmdArgs.length; i++) {
      const arg = cmdArgs[i];
      if (arg === undefined || arg === "-p") continue;
      if (arg === "-t") {
        i++; // skip the target value
        continue;
      }
      format = arg;
      break;
    }
    if (format === undefined) return this.fail("display-message: no format", originalArgs);
    return format
      .replace(/#\{cursor_flag\}/g, (pane.cursorVisible ?? true) ? "1" : "0")
      .replace(/#\{cursor_x\}/g, String(pane.cursorX ?? 0))
      .replace(/#\{cursor_y\}/g, String(pane.cursorY ?? 0));
  }

  /** The first non-flag argument (the pipe command), if any. */
  private pipeCommand(cmdArgs: string[]): string | undefined {
    for (let i = 0; i < cmdArgs.length; i++) {
      const arg = cmdArgs[i];
      if (arg === undefined || arg === "-o") continue;
      if (arg === "-t") {
        i++; // skip the target value
        continue;
      }
      return arg;
    }
    return undefined;
  }

  /** Resolves the pane for the command target, failing like tmux if absent. */
  private paneOf(cmdArgs: string[], originalArgs: string[]): FakePaneState {
    const name = this.target(cmdArgs, originalArgs);
    const pane = this.sessions.get(name);
    if (!pane) this.fail("can't find session", originalArgs);
    return pane;
  }

  /** Decodes `send-keys -H` hex byte arguments into UTF-8 text (1 byte/arg). */
  private decodeHex(hexArgs: string[], originalArgs: string[]): string {
    const bytes: number[] = [];
    for (const arg of hexArgs) {
      if (!/^[0-9a-fA-F]{2}$/.test(arg)) this.fail(`bad hex byte: ${arg}`, originalArgs);
      bytes.push(Number.parseInt(arg, 16));
    }
    return Buffer.from(bytes).toString("utf8");
  }

  private target(cmdArgs: string[], originalArgs: string[]): string {
    const idx = cmdArgs.indexOf("-t");
    if (idx === -1 || idx + 1 >= cmdArgs.length) {
      return this.fail("missing target", originalArgs);
    }
    // Targets may be `name`, `name:` (current window) or `name.<window>`.
    const target = cmdArgs[idx + 1];
    return (target ?? "").replace(/[:.].*$/, "");
  }

  private parseNewSession(cmdArgs: string[]): {
    name: string;
    cwd: string | undefined;
    command: string[];
  } {
    let name: string | undefined;
    let cwd: string | undefined;
    const command: string[] = [];
    // tmux stops option parsing at the first non-option word; everything
    // after that is the (verbatim) command to run in the pane.
    for (let i = 0; i < cmdArgs.length; i++) {
      const arg = cmdArgs[i];
      if (arg === undefined) break;
      if (command.length > 0) {
        command.push(arg);
        continue;
      }
      if (arg === "-d") continue;
      if (arg === "-s") {
        name = cmdArgs[++i];
        continue;
      }
      if (arg === "-c") {
        cwd = cmdArgs[++i];
        continue;
      }
      command.push(arg);
    }
    if (name === undefined) return this.fail("new-session: no name", []);
    return { name, cwd, command };
  }
}

/** Splits emitted text into pane lines (trailing newline dropped). */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function appendTo(file: string, text: string): void {
  createFile(file);
  appendFileSync(file, text);
}

function createFile(file: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, "");
}
