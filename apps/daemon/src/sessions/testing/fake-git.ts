/**
 * In-memory fake `GitRunner` for the worker workspace preparation path
 * (issue #287): records every invocation, answers the fetch /
 * origin-HEAD / worktree commands the workspace prep issues, and lets
 * tests script failures (e.g. a fetch failure must abort the spawn
 * loudly). Only implements the subset of commands the daemon uses.
 */

import type { GitRunner } from "../../github/repos.js";

export interface FakeGitInvocation {
  /** The argv (without the leading `git`). */
  args: string[];
  /** The cwd the command ran in, when given. */
  cwd?: string;
}

export class FakeGitRunner {
  /** Every invocation, in order. */
  readonly invocations: FakeGitInvocation[] = [];
  /** First matching command (exact first-arg match) fails with its error. */
  private readonly failures = new Map<string, Error>();

  /** Scripts a failure for the next/all invocations of `git <command>`. */
  failOn(command: string, error: Error): this {
    this.failures.set(command, error);
    return this;
  }

  asRunner(): GitRunner {
    return async (args, options) => {
      this.invocations.push({ args, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) });
      const scripted = args[0] === undefined ? undefined : this.failures.get(args[0]);
      if (scripted !== undefined) throw scripted;
      if (args[0] === "fetch") return { stdout: "", stderr: "" };
      if (args[0] === "symbolic-ref") return { stdout: "origin/main\n", stderr: "" };
      if (args[0] === "worktree") return { stdout: "", stderr: "" };
      throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
    };
  }
}
