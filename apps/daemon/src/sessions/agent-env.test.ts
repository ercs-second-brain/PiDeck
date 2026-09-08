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

/**
 * Runner simulating an old tmux server: `-e` is a usage error and the
 * session is not created; every other invocation reaches `fake`.
 */
function oldTmuxRunner(fake: FakeTmuxRunner) {
  return (args: string[]) =>
    args.includes("-e")
      ? Promise.reject(
          new TmuxError("tmux new-session failed: invalid option -- e", {
            args,
            exitCode: 1,
            stderr: "new-session: usage: new-session [-AdEPIPX] ...",
          }),
        )
      : fake.run(args);
}

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
    // Belt-and-suspenders: -e also sets the session-level env on tmux >= 3.2.
    expect(fake.invocations.find((inv) => inv.args[0] === "new-session")?.args).toContain("-e");
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
    expect(fake.invocations.filter((inv) => inv.args[0] === "new-session").at(-1)?.args).not.toContain("-e");
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

  it("on old tmux (no -e support) the pane still gets the canonical env via the wrapper", async () => {
    // The regression from the field: on tmux < 3.2 the -e retry used to drop
    // the env entirely and the pane silently inherited the stale server env.
    // The wrapper is version-independent, so the retry keeps it.
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({
      sendEnterDelayMs: 0,
      defaultSessionEnv: ENV,
      runner: oldTmuxRunner(fake),
    });
    await tmux.newSession("sess", { command: ["pi"] });
    expect(await tmux.hasSession("sess")).toBe(true);
    const command = fake.sessions.get("sess")?.command;
    const script = command?.[2] ?? "";
    expect(script).toContain(`export PATH=${ENV.PATH}`);
    expect(script).toContain(`export PD_NODE=${ENV.PD_NODE}`);
    expect(command?.slice(4)).toEqual(["pi"]);
    // The old-tmux pane command is IDENTICAL to the modern-tmux one.
    const modern = new FakeTmuxRunner();
    const modernTmux = new Tmux({ sendEnterDelayMs: 0, defaultSessionEnv: ENV, runner: (args) => modern.run(args) });
    await modernTmux.newSession("sess", { command: ["pi"] });
    expect(command).toEqual(modern.sessions.get("sess")?.command);
  });
});

describe("tmux new-session -e belt-and-suspenders (tmux >= 3.2)", () => {
  it("injects the session env via -e and never mutates the server env", async () => {
    // -e covers panes/windows opened LATER inside the session; the injection
    // is part of the new-session invocation itself — NOT a global `setenv`
    // (which would pollute the user's default tmux server) and NOT a
    // post-creation `setenv -t` (which cannot reach the already-started
    // initial pane process).
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({ sendEnterDelayMs: 0, defaultSessionEnv: ENV, runner: (args) => fake.run(args) });
    await tmux.newSession("sess");
    expect(fake.sessions.get("sess")?.env).toEqual(ENV);
    expect(fake.invocations.find((inv) => inv.args[0] === "new-session")?.args).toContain("-e");
    expect(fake.invocations.some((inv) => inv.args[0] === "setenv")).toBe(false);
  });

  it("retries without -e when tmux rejects it (tmux < 3.2)", async () => {
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({
      sendEnterDelayMs: 0,
      defaultSessionEnv: ENV,
      runner: oldTmuxRunner(fake),
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
