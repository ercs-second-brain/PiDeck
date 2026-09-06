/**
 * In-memory fake `TmuxRunner` simulating a tmux server.
 *
 * Used by the daemon's unit tests (and reusable by later phases, e.g. the
 * terminal bridge) to exercise tmux-dependent logic without a real tmux
 * binary. Only implements the subset of commands the daemon uses.
 */

import { TmuxError, type CommandResult, type TmuxRunner } from "../tmux.js";
export interface FakePaneState {
  command: string[];
  cwd: string | undefined;
  /** Simulated pane contents, one entry per line. */
  paneLines: string[];
  cols: number;
  rows: number;
}

export interface FakeTmuxRunnerOptions {
  /** Pre-seed pane output for a session that will be created later. */
  initialPaneLines?: string[];
  initialCols?: number;
  initialRows?: number;
}

export class FakeTmuxRunner {
  readonly sessions = new Map<string, FakePaneState>();

  private readonly initialPaneLines: string[] | undefined;
  private readonly initialCols: number;
  private readonly initialRows: number;

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

  private execute(args: string[]): string {
    // Skip a private-socket prefix (`-L <name>`) if present.
    let rest = args;
    if (rest[0] === "-L") rest = rest.slice(2);
    const [cmd, ...cmdArgs] = rest;
    switch (cmd) {
      case "-V":
        return "tmux 3.4";
      case "has-session": {
        const name = this.target(cmdArgs, args);
        if (!this.sessions.has(name)) this.fail("can't find session", args);
        return "";
      }
      case "new-session": {
        const parsed = this.parseNewSession(cmdArgs);
        if (this.sessions.has(parsed.name)) {
          this.fail("duplicate session", args);
        }
        this.sessions.set(parsed.name, {
          command: parsed.command,
          cwd: parsed.cwd,
          paneLines: this.initialPaneLines ? [...this.initialPaneLines] : [],
          cols: this.initialCols,
          rows: this.initialRows,
        });
        return "";
      }
      case "list-sessions": {
        return [...this.sessions.keys()].join("\n");
      }
      case "kill-session": {
        const name = this.target(cmdArgs, args);
        if (!this.sessions.delete(name)) this.fail("can't find session", args);
        return "";
      }
      case "capture-pane": {
        const name = this.target(cmdArgs, args);
        const pane = this.sessions.get(name);
        if (!pane) this.fail("can't find session", args);
        return pane.paneLines.join("\n");
      }
      case "resize-window": {
        const name = this.target(cmdArgs, args);
        const pane = this.sessions.get(name);
        if (!pane) this.fail("can't find session", args);
        const x = cmdArgs.indexOf("-x");
        const y = cmdArgs.indexOf("-y");
        if (x !== -1) pane.cols = Number(cmdArgs[x + 1]);
        if (y !== -1) pane.rows = Number(cmdArgs[y + 1]);
        return "";
      }
      case "send-keys": {
        const name = this.target(cmdArgs, args);
        const pane = this.sessions.get(name);
        if (!pane) this.fail("can't find session", args);
        const literal = cmdArgs.indexOf("-l");
        if (literal !== -1) {
          const text = cmdArgs[literal + 1];
          if (text !== undefined) pane.paneLines.push(text);
        }
        return "";
      }
      default:
        return this.fail(`unknown command: ${cmd ?? "(none)"}`, args);
    }
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
