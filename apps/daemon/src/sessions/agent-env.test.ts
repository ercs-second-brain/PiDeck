/**
 * Tests for the canonical session-env derivation (`agentSessionEnv`): the
 * env injected into every daemon-created tmux session so agent panes run
 * under the runtime the daemon itself resolved — never the tmux server's
 * stale global environment (see `agent-env.ts` and the tmux.ts `-e`
 * injection).
 */

import { describe, expect, it } from "vitest";
import { agentSessionEnv } from "./agent-env.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux, TmuxError } from "./tmux.js";

describe("agentSessionEnv", () => {
  it("passes through the daemon's resolved PATH and PD_NODE", () => {
    expect(
      agentSessionEnv({
        PATH: "/opt/pideck/node/bin:/usr/local/bin:/usr/bin:/bin",
        PD_NODE: "/opt/pideck/node/bin/node",
      }),
    ).toEqual({
      PATH: "/opt/pideck/node/bin:/usr/local/bin:/usr/bin:/bin",
      PD_NODE: "/opt/pideck/node/bin/node",
    });
  });

  it("skips PD_NODE when unset (daemon started outside the service wrapper)", () => {
    const env = agentSessionEnv({ PATH: "/usr/bin:/bin" });
    expect(env).toEqual({ PATH: "/usr/bin:/bin" });
    expect(agentSessionEnv({})).toEqual({});
  });

  it("skips empty entries instead of injecting a broken value", () => {
    expect(agentSessionEnv({ PATH: "", PD_NODE: "" })).toEqual({});
  });
});

describe("tmux session env injection (stale tmux server env)", () => {
  const ENV = { PATH: "/opt/pideck/node/bin:/usr/bin:/bin", PD_NODE: "/opt/pideck/node/bin/node" };

  it("new session sees the injected env via new-session -e", async () => {
    // The bug this pins: panes inherit the tmux SERVER's global environment
    // (stale PATH / old Node), so the daemon injects its resolved runtime
    // env explicitly via `new-session -e KEY=VAL`.
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ sendEnterDelayMs: 0, defaultSessionEnv: ENV, runner: (args) => fake.run(args) });
    await tmux.newSession("sess");
    expect(fake.sessions.get("sess")?.env).toEqual(ENV);
    // The injection is part of the new-session invocation itself — NOT a
    // global `setenv` (which would pollute the user's default tmux server)
    // and NOT a post-creation `setenv -t` (which cannot reach the already-
    // started initial pane process).
    expect(fake.invocations.find((inv) => inv.args[0] === "new-session")?.args).toContain("-e");
    expect(fake.invocations.some((inv) => inv.args[0] === "setenv")).toBe(false);
    // No default env → no -e flags at all.
    const bare = new Tmux({ sendEnterDelayMs: 0, runner: (args) => fake.run(args) });
    await bare.newSession("plain");
    expect(fake.invocations.filter((inv) => inv.args[0] === "new-session").at(-1)?.args).not.toContain("-e");
  });

  it("falls back to no env injection when tmux rejects -e (tmux < 3.2)", async () => {
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({
      sendEnterDelayMs: 0,
      defaultSessionEnv: ENV,
      runner: (args) =>
        // Simulate an old tmux server: `-e` is a usage error and the session
        // is not created; every other invocation reaches the fake server.
        args.includes("-e")
          ? Promise.reject(
              new TmuxError("tmux new-session failed: invalid option -- e", {
                args,
                exitCode: 1,
                stderr: "new-session: usage: new-session [-AdEPIPX] ...",
              }),
            )
          : fake.run(args),
    });
    await tmux.newSession("sess");
    expect(await tmux.hasSession("sess")).toBe(true);
    expect(fake.sessions.get("sess")?.env).toBeUndefined();
  });

  it("propagates real new-session failures even when env was requested", async () => {
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ sendEnterDelayMs: 0, defaultSessionEnv: ENV, runner: (args) => fake.run(args) });
    await tmux.newSession("dup");
    // A duplicate-name failure must not be swallowed by the -e fallback.
    await expect(tmux.newSession("dup")).rejects.toBeInstanceOf(TmuxError);
  });
});
