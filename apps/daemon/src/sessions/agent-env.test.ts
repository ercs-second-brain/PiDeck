/**
 * Tests for the canonical session-env derivation (`agentSessionEnv`): the
 * env injected into every daemon-created tmux session so agent panes run
 * under the runtime the daemon itself resolved — never the tmux server's
 * stale global environment (see `agent-env.ts` and the pane-side wrapper in
 * `tmux.ts`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { agentSessionEnv } from "./agent-env.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux, TmuxError } from "./tmux.js";

const execFileP = promisify(execFile);

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

/** The canonical session env used by the injection tests below. */
const ENV = { PATH: "/opt/pideck/node/bin:/usr/bin:/bin", PD_NODE: "/opt/pideck/node/bin/node" };

describe("tmux session env wrapper (stale tmux server env, issue #253)", () => {
  it("wraps the pane command so the pane itself starts with the canonical env", async () => {
    // The bug this pins: panes inherit the tmux SERVER's global environment
    // (stale PATH / old Node). The guaranteed fix is pane-side: the command
    // is wrapped in `sh -c 'export ...; exec "$@"'` so the pane process
    // itself resolves the canonical runtime — on every tmux version.
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ sendEnterDelayMs: 0, defaultSessionEnv: ENV, runner: (args) => fake.run(args) });
    await tmux.newSession("sess", { cwd: "/tmp/ws", command: ["pi"] });
    const command = fake.sessions.get("sess")?.command;
    expect(command?.[0]).toBe("sh");
    expect(command?.[1]).toBe("-c");
    const script = command?.[2] ?? "";
    // Bare-safe values are embedded unquoted (shQuote), unsafe ones quoted.
    expect(script).toContain(`export PATH=${ENV.PATH}`);
    expect(script).toContain(`export PD_NODE=${ENV.PD_NODE}`);
    expect(script).toContain(`exec "$@"`);
    // The original payload survives verbatim after the wrapper's argv0 placeholder.
    expect(command?.slice(4)).toEqual(["pi"]);
    // The injection is pane-side only — the tmux server's global env is
    // never mutated (no `setenv`; issue #256 removed the redundant `-e`).
    expect(fake.invocations.some((inv) => inv.args[0] === "setenv")).toBe(false);
  });

  it("wraps plain-shell panes too: orchestrator panes exec the user's login shell with the env", async () => {
    // Orchestrator sessions start a plain interactive shell and pi is typed
    // into it later (sendKeys) — the shell that resolves pi must already
    // carry the canonical PATH.
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ sendEnterDelayMs: 0, defaultSessionEnv: ENV, runner: (args) => fake.run(args) });
    await tmux.newSession("orch");
    const command = fake.sessions.get("orch")?.command;
    expect(command?.[0]).toBe("sh");
    expect(command?.[1]).toBe("-c");
    const script = command?.[2] ?? "";
    expect(script).toContain(`export PATH=${ENV.PATH}`);
    expect(script).toContain(`exec "\${SHELL:-/bin/sh}" -l`);
  });

  it("leaves the command unwrapped when there is nothing to inject", async () => {
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ sendEnterDelayMs: 0, runner: (args) => fake.run(args) });
    await tmux.newSession("plain", { command: ["pi"] });
    expect(fake.sessions.get("plain")?.command).toEqual(["pi"]);
  });

  it("wrapper quoting survives env values and commands containing spaces and quotes", async () => {
    // Only the env values are embedded in the wrapper script; they must be
    // quoted so spaces/quotes in them cannot change what the pane executes.
    const weird = {
      PATH: "/opt/my node'/bin:/usr/bin",
      PD_NODE: "/opt/my node'/bin/node",
    };
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ sendEnterDelayMs: 0, defaultSessionEnv: weird, runner: (args) => fake.run(args) });
    const payload = ["sh", "-c", 'printf "%s\\n%s\\n" "$PATH" "$PD_NODE"'];
    await tmux.newSession("sess", { command: payload });
    const wrapped = fake.sessions.get("sess")?.command;
    // The payload survives the wrapper verbatim.
    expect(wrapped?.slice(4)).toEqual(payload);
    // Execute the wrapper exactly as the pane would: the env must round-trip.
    const { stdout } = await execFileP(wrapped![0]!, wrapped!.slice(1));
    expect(stdout).toBe(`${weird.PATH}\n${weird.PD_NODE}\n`);
  });

  it("wraps the pane command identically regardless of tmux version (issue #256)", async () => {
    // Regression pin from the field (#253): the pane env must never depend
    // on a tmux version branch — the wrapper is the only mechanism (issue
    // #256 removed the last one, the `new-session -e` belt-and-suspenders).
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ sendEnterDelayMs: 0, defaultSessionEnv: ENV, runner: (args) => fake.run(args) });
    await tmux.newSession("sess", { command: ["pi"] });
    const command = fake.sessions.get("sess")?.command;
    expect(command?.[0]).toBe("sh");
    expect(command?.slice(4)).toEqual(["pi"]);
  });

  it("propagates real new-session failures even when env was requested", async () => {
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ sendEnterDelayMs: 0, defaultSessionEnv: ENV, runner: (args) => fake.run(args) });
    await tmux.newSession("dup");
    await expect(tmux.newSession("dup")).rejects.toBeInstanceOf(TmuxError);
  });
});
