/**
 * Test harness shared by the daemon-level loop test: a fake tmux (every
 * invocation is recorded, panes are created alive and stay alive), and a
 * helper that reassembles the single lines delivered into panes from the
 * recorded `send-keys -H` chunks.
 */

import { Tmux, type TmuxRunner } from "../sessions/tmux.js";

export function fakeTmux(): { tmux: Tmux; calls: string[][] } {
  const calls: string[][] = [];
  const runner: TmuxRunner = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  return {
    tmux: new Tmux({ runner, enterDelayMs: 0, verifyDelayMs: 0, waitPollMs: 5, waitQuietMs: 0 }),
    calls,
  };
}

/** Reassembles the lines delivered into panes. */
export function sentLines(calls: string[][]): string[] {
  const lines: string[] = [];
  let buffer = "";
  for (const args of calls) {
    if (args[0] !== "send-keys") continue;
    if (args.includes("Enter")) {
      lines.push(buffer);
      buffer = "";
    } else if (args.includes("-H")) {
      buffer += Buffer.from(args.slice(args.indexOf("-H") + 1).join(""), "hex").toString("utf8");
    }
  }
  return lines;
}
