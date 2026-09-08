/**
 * Worker-session self-identification for `pideck report-pr` (issue #49).
 *
 * The CLI runs inside a daemon-managed tmux pane (the worker's session), so
 * it resolves the *calling* tmux session from its own live context — the
 * `TMUX` env var plus `tmux display-message -p '#S'` against that same
 * server — instead of asking the caller to name a session. This is the
 * "authenticated-by-context" half of the report path: a process outside a
 * tmux pane has no session to report for, and a worker cannot accidentally
 * report for a sibling session by mistyping an id.
 */

import { execFile } from "node:child_process";

import { CliError } from "./args.js";

/** A single tmux invocation returning stdout (throws on non-zero exit). */
export type TmuxDisplayRunner = (args: string[]) => Promise<string>;

function execFileAsync(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

/** Default runner: the real `tmux` on PATH (the pane's own server via `$TMUX`). */
export function defaultTmuxDisplayRunner(bin = "tmux"): TmuxDisplayRunner {
  return (args) => execFileAsync(bin, args);
}

/**
 * Resolves the tmux session name of the pane the CLI runs in. Throws a
 * `CliError` when not inside tmux or when the session name cannot be read.
 */
export async function currentTmuxSession(
  env: NodeJS.ProcessEnv = process.env,
  run: TmuxDisplayRunner = defaultTmuxDisplayRunner(),
): Promise<string> {
  if (env["TMUX"] === undefined || env["TMUX"].length === 0) {
    throw new CliError(
      "report-pr must run inside an pideck worker tmux session (no TMUX environment — run it from the worker pane)",
    );
  }
  let stdout: string;
  try {
    stdout = await run(["display-message", "-p", "#S"]);
  } catch (err) {
    throw new CliError(`cannot resolve the current tmux session: ${err instanceof Error ? err.message : String(err)}`);
  }
  const name = stdout.trim();
  if (name.length === 0) throw new CliError("tmux returned an empty session name");
  return name;
}
